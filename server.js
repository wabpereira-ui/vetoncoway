// Agente Oncoway — Servidor unificado
// -------------------------------------------------------------------
// Este único servidor cuida de:
// 1) Login individual dos alunos (cada um com seu usuário e senha)
// 2) O app web dos alunos (pasta /public)
// 3) A área da mentora (/admin) — gerenciar acervo e contas de alunos
// 4) O bot de WhatsApp (/webhook)
//
// Veja o README.md para o passo a passo de configuração e deploy.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_USER = process.env.ADMIN_USER || 'mentora';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

const DOCS_PATH = path.join(__dirname, 'docs.json');
const STUDENTS_PATH = path.join(__dirname, 'students.json');

function loadDocs() { return JSON.parse(fs.readFileSync(DOCS_PATH, 'utf8')); }
function saveDocs(docs) { fs.writeFileSync(DOCS_PATH, JSON.stringify(docs, null, 2)); }

function loadStudents() {
  if (!fs.existsSync(STUDENTS_PATH)) return [];
  return JSON.parse(fs.readFileSync(STUDENTS_PATH, 'utf8'));
}
function saveStudents(students) {
  fs.writeFileSync(STUDENTS_PATH, JSON.stringify(students, null, 2));
}

// ---------- Senhas dos alunos (hash com salt, nunca em texto puro) ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function createStudent(name, username, password) {
  const students = loadStudents();
  const usernameNorm = username.trim().toLowerCase();
  if (students.some(s => s.username === usernameNorm)) {
    throw new Error('Já existe um aluno com esse nome de usuário.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const student = { id: 'aluno-' + Date.now(), name, username: usernameNorm, salt, hash };
  students.push(student);
  saveStudents(students);
  return student;
}
function verifyStudent(username, password) {
  const students = loadStudents();
  const usernameNorm = (username || '').trim().toLowerCase();
  const student = students.find(s => s.username === usernameNorm);
  if (!student) return null;
  const hash = hashPassword(password || '', student.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(student.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return student;
}

// ---------- Sessões simples (cookie httpOnly + memória do servidor) ----------
// Observação: sessões ficam na memória do processo. Se o servidor reiniciar,
// todo mundo precisa logar de novo — isso é aceitável para um programa pequeno.
const sessions = new Map(); // sessionId -> { studentId, name, expires }
const SESSION_COOKIE = 'oncoway_session';
const SESSION_DURATION_MS = 1000 * 60 * 60 * 24 * 30; // 30 dias

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(part => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}
function createSession(student, res, req) {
  const sessionId = crypto.randomBytes(24).toString('hex');
  sessions.set(sessionId, { studentId: student.id, name: student.name, expires: Date.now() + SESSION_DURATION_MS });
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${sessionId}; HttpOnly; Path=/; Max-Age=${SESSION_DURATION_MS / 1000}; SameSite=Lax${secure ? '; Secure' : ''}`);
}
function destroySession(req, res) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (sid) sessions.delete(sid);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
}
function getSession(req) {
  const cookies = parseCookies(req);
  const sid = cookies[SESSION_COOKIE];
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (session.expires < Date.now()) { sessions.delete(sid); return null; }
  return session;
}

// ---------- Auth da mentora (Basic Auth simples, separado do login dos alunos) ----------
function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    console.warn('ADMIN_PASSWORD não configurada — defina essa variável de ambiente para proteger o /admin.');
  }
  const auth = req.headers.authorization;
  if (auth) {
    const [, encoded] = auth.split(' ');
    const [user, pass] = Buffer.from(encoded || '', 'base64').toString().split(':');
    if (user === ADMIN_USER && pass === ADMIN_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Area da mentora"');
  return res.status(401).send('Acesso restrito à mentora.');
}

// ---------- Auth dos alunos (login individual por cookie de sessão) ----------
function requireStudentPage(req, res, next) {
  const session = getSession(req);
  if (session) { req.student = session; return next(); }
  return res.redirect('/login.html');
}
function requireStudentApi(req, res, next) {
  const session = getSession(req);
  if (session) { req.student = session; return next(); }
  return res.status(401).json({ error: 'not_authenticated' });
}

// Rotas públicas de login (sem senha nenhuma para acessar a própria tela de login)
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const student = verifyStudent(username, password);
  if (!student) return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  createSession(student, res, req);
  res.json({ ok: true, name: student.name });
});
app.post('/api/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ name: session.name });
});

// Página principal e demais arquivos estáticos exigem login de aluno
app.get('/', requireStudentPage, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

function chunkText(text) {
  return text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 20);
}
function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}
function retrieveContext(query, docs, topN = 5) {
  const qWords = normalize(query).split(/\W+/).filter(w => w.length > 3);
  let scored = [];
  docs.forEach(d => {
    chunkText(d.text).forEach(c => {
      const cNorm = normalize(c);
      let score = 0;
      qWords.forEach(w => { if (cNorm.includes(w)) score++; });
      if (score > 0) scored.push({ source: d.name, text: c, score });
    });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

const SYSTEM_PROMPT = `Você é um assistente de apoio ao ensino de um programa de mentoria em oncologia veterinária.
Responda SOMENTE com base no CONTEXTO fornecido pelo usuário, que vem do acervo de aulas, artigos e livros do programa.
Regras obrigatórias:
1) Se o contexto não contiver a resposta, diga claramente que o material disponível ainda não cobre esse ponto e sugira perguntar diretamente à mentora. Não invente informação.
2) Seja objetivo e use linguagem técnica adequada para alunos de pós-graduação em oncologia veterinária.
3) Sempre que a resposta envolver dose de medicamento, inclua no fim: "⚠ Confirme esta dose com a fonte original e com a mentora antes de qualquer uso clínico."
4) Indique ao final, entre parênteses, a fonte usada, ex: (Fonte: Aula 3 — Linfoma).`;

async function askClaude(question, contextBlock) {
  const userContent = `CONTEXTO DISPONÍVEL:\n${contextBlock || '(nenhum trecho relevante encontrado no acervo)'}\n\nPERGUNTA DO ALUNO:\n${question}`;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    })
  });
  const data = await response.json();
  if (data.error) {
    console.error('Erro da API Anthropic:', data.error);
    return 'Desculpe, tive um problema para consultar o acervo agora. Tente novamente em instantes.';
  }
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  return textBlocks.join('\n') || 'Não consegui gerar uma resposta agora.';
}

// ---------- API usada pela tela dos alunos (exige login individual) ----------

app.get('/api/docs', requireStudentApi, (req, res) => {
  const docs = loadDocs().map(d => ({ id: d.id, name: d.name }));
  res.json(docs);
});

app.post('/api/ask', requireStudentApi, async (req, res) => {
  try {
    const { question } = req.body;
    if (!question) return res.status(400).json({ error: 'question é obrigatório' });
    const docs = loadDocs();
    const topChunks = retrieveContext(question, docs);
    const contextBlock = topChunks.map(c => `[Fonte: ${c.source}]\n${c.text}`).join('\n\n---\n\n');
    const sources = [...new Set(topChunks.map(c => c.source))];
    const answer = await askClaude(question, contextBlock);
    res.json({ answer, sources });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ---------- Área da mentora: acervo ----------

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});

app.get('/api/admin/docs', requireAdmin, (req, res) => {
  res.json(loadDocs());
});
app.post('/api/admin/docs', requireAdmin, (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name e text são obrigatórios' });
  const docs = loadDocs();
  docs.push({ id: 'doc-' + Date.now(), name, text });
  saveDocs(docs);
  res.json(docs);
});
app.delete('/api/admin/docs/:id', requireAdmin, (req, res) => {
  let docs = loadDocs();
  docs = docs.filter(d => d.id !== req.params.id);
  saveDocs(docs);
  res.json(docs);
});

// ---------- Área da mentora: contas dos alunos ----------

app.get('/api/admin/students', requireAdmin, (req, res) => {
  const students = loadStudents().map(s => ({ id: s.id, name: s.name, username: s.username }));
  res.json(students);
});
app.post('/api/admin/students', requireAdmin, (req, res) => {
  const { name, username, password } = req.body;
  if (!name || !username || !password) {
    return res.status(400).json({ error: 'name, username e password são obrigatórios' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
  }
  try {
    createStudent(name, username, password);
    const students = loadStudents().map(s => ({ id: s.id, name: s.name, username: s.username }));
    res.json(students);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete('/api/admin/students/:id', requireAdmin, (req, res) => {
  let students = loadStudents();
  students = students.filter(s => s.id !== req.params.id);
  saveStudents(students);
  res.json(students.map(s => ({ id: s.id, name: s.name, username: s.username })));
});

// ---------- WhatsApp ----------

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function sendWhatsAppMessage(to, body) {
  await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, text: { body } })
  });
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;
    const docs = loadDocs();
    const topChunks = retrieveContext(message.text.body, docs);
    const contextBlock = topChunks.map(c => `[Fonte: ${c.source}]\n${c.text}`).join('\n\n---\n\n');
    const answer = await askClaude(message.text.body, contextBlock);
    await sendWhatsAppMessage(message.from, answer);
  } catch (err) {
    console.error('Erro ao processar mensagem do WhatsApp:', err);
  }
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
