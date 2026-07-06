// Agente Oncoway — Servidor unificado
// -------------------------------------------------------------------
// Este único servidor cuida de:
// 1) Login dos alunos por e-mail, com "primeiro acesso" (o aluno cria a própria senha)
// 2) O app web dos alunos (pasta /public)
// 3) A área da mentora (/admin) — gerenciar acervo e convites de alunos
// 4) O bot de WhatsApp (/webhook)
//
// Veja o README.md para o passo a passo de configuração e deploy.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
let Pool;
try { Pool = require('pg').Pool; } catch (e) { Pool = null; }
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '12mb' }));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_USER = process.env.ADMIN_USER || 'mentora';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DATABASE_URL = process.env.DATABASE_URL;

const DOCS_PATH = path.join(__dirname, 'docs.json');
const STUDENTS_PATH = path.join(__dirname, 'students.json');

// ---------- Camada de dados ----------
// Se DATABASE_URL estiver configurada (ex: Supabase/Postgres), os dados ficam guardados
// lá — sobrevivem a reinícios e redeploys do servidor. Se não estiver configurada, o
// sistema continua funcionando com os arquivos locais (docs.json / students.json), do
// jeito que já funcionava antes — mas com o risco já conhecido de perda em planos gratuitos
// sem disco persistente.
const useDb = Boolean(DATABASE_URL && Pool);
let pool = null;
if (useDb) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
} else {
  console.warn('DATABASE_URL não configurada (ou pacote "pg" ausente) — usando arquivos locais. Configure DATABASE_URL para não correr risco de perder dados em reinícios do servidor.');
}

async function initDb() {
  if (!useDb) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_set BOOLEAN DEFAULT FALSE,
      salt TEXT,
      hash TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Semeia o acervo de exemplo na primeira vez, se a tabela estiver vazia e existir um docs.json local.
  const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM docs');
  if (rows[0].count === 0 && fs.existsSync(DOCS_PATH)) {
    const seed = JSON.parse(fs.readFileSync(DOCS_PATH, 'utf8'));
    for (const d of seed) {
      await pool.query('INSERT INTO docs (id, name, text) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING', [d.id, d.name, d.text]);
    }
    console.log(`Banco de dados: acervo semeado com ${seed.length} materiais de exemplo.`);
  }
}

// ---- Acervo (docs) ----
async function loadDocs() {
  if (useDb) {
    const { rows } = await pool.query('SELECT id, name, text FROM docs ORDER BY created_at ASC');
    return rows;
  }
  return JSON.parse(fs.readFileSync(DOCS_PATH, 'utf8'));
}
async function addDoc(name, text) {
  const id = 'doc-' + Date.now();
  if (useDb) {
    await pool.query('INSERT INTO docs (id, name, text) VALUES ($1,$2,$3)', [id, name, text]);
    return;
  }
  const docs = JSON.parse(fs.readFileSync(DOCS_PATH, 'utf8'));
  docs.push({ id, name, text });
  fs.writeFileSync(DOCS_PATH, JSON.stringify(docs, null, 2));
}
async function deleteDoc(id) {
  if (useDb) {
    await pool.query('DELETE FROM docs WHERE id=$1', [id]);
    return;
  }
  let docs = JSON.parse(fs.readFileSync(DOCS_PATH, 'utf8'));
  docs = docs.filter(d => d.id !== id);
  fs.writeFileSync(DOCS_PATH, JSON.stringify(docs, null, 2));
}

// ---- Alunos ----
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
function loadStudentsFile() {
  if (!fs.existsSync(STUDENTS_PATH)) return [];
  return JSON.parse(fs.readFileSync(STUDENTS_PATH, 'utf8'));
}
function saveStudentsFile(students) {
  fs.writeFileSync(STUDENTS_PATH, JSON.stringify(students, null, 2));
}

async function loadStudents() {
  if (useDb) {
    const { rows } = await pool.query('SELECT id, name, email, password_set AS "passwordSet", salt, hash FROM students ORDER BY created_at ASC');
    return rows;
  }
  return loadStudentsFile();
}

// Cria um "convite" — nome + e-mail, ainda sem senha. O aluno define a senha
// dele mesmo na tela de "Primeiro acesso".
async function inviteStudent(name, email) {
  const emailNorm = email.trim().toLowerCase();
  const id = 'aluno-' + Date.now();
  if (useDb) {
    const existing = await pool.query('SELECT id FROM students WHERE email=$1', [emailNorm]);
    if (existing.rows.length) throw new Error('Já existe um convite ou conta com esse e-mail.');
    await pool.query('INSERT INTO students (id, name, email, password_set) VALUES ($1,$2,$3,false)', [id, name, emailNorm]);
    return { id, name, email: emailNorm };
  }
  const students = loadStudentsFile();
  if (students.some(s => s.email === emailNorm)) throw new Error('Já existe um convite ou conta com esse e-mail.');
  const student = { id, name, email: emailNorm, passwordSet: false, salt: null, hash: null };
  students.push(student);
  saveStudentsFile(students);
  return student;
}

// Primeiro acesso: o aluno define a própria senha para um convite existente.
async function setStudentPassword(email, password) {
  const emailNorm = (email || '').trim().toLowerCase();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  if (useDb) {
    const { rows } = await pool.query('SELECT * FROM students WHERE email=$1', [emailNorm]);
    const student = rows[0];
    if (!student) throw new Error('E-mail não encontrado. Peça um convite para a mentora.');
    if (student.password_set) throw new Error('Essa conta já tem senha. Use "Entrar", ou peça para a mentora resetar o acesso.');
    await pool.query('UPDATE students SET salt=$1, hash=$2, password_set=true WHERE id=$3', [salt, hash, student.id]);
    return { id: student.id, name: student.name, email: emailNorm };
  }
  const students = loadStudentsFile();
  const student = students.find(s => s.email === emailNorm);
  if (!student) throw new Error('E-mail não encontrado. Peça um convite para a mentora.');
  if (student.passwordSet) throw new Error('Essa conta já tem senha. Use "Entrar", ou peça para a mentora resetar o acesso.');
  student.salt = salt;
  student.hash = hash;
  student.passwordSet = true;
  saveStudentsFile(students);
  return student;
}

async function verifyStudent(email, password) {
  const emailNorm = (email || '').trim().toLowerCase();
  let student;
  if (useDb) {
    const { rows } = await pool.query('SELECT * FROM students WHERE email=$1', [emailNorm]);
    student = rows[0] ? { id: rows[0].id, name: rows[0].name, passwordSet: rows[0].password_set, salt: rows[0].salt, hash: rows[0].hash } : null;
  } else {
    student = loadStudentsFile().find(s => s.email === emailNorm);
  }
  if (!student || !student.passwordSet) return null;
  const hash = hashPassword(password || '', student.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(student.hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return student;
}

// Mentora "reseta" o acesso (ex: aluno esqueceu a senha): volta o status para
// "convite pendente", sem apagar o cadastro. O aluno faz "Primeiro acesso" de novo.
async function resetStudentPassword(id) {
  if (useDb) {
    const { rowCount } = await pool.query('UPDATE students SET password_set=false, salt=NULL, hash=NULL WHERE id=$1', [id]);
    if (!rowCount) throw new Error('Aluno não encontrado.');
    return;
  }
  const students = loadStudentsFile();
  const student = students.find(s => s.id === id);
  if (!student) throw new Error('Aluno não encontrado.');
  student.passwordSet = false;
  student.salt = null;
  student.hash = null;
  saveStudentsFile(students);
}

async function deleteStudent(id) {
  if (useDb) {
    await pool.query('DELETE FROM students WHERE id=$1', [id]);
    return;
  }
  let students = loadStudentsFile();
  students = students.filter(s => s.id !== id);
  saveStudentsFile(students);
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

// Rotas públicas de login/cadastro (sem exigir sessão)
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const student = await verifyStudent(email, password);
  if (!student) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  createSession(student, res, req);
  res.json({ ok: true, name: student.name });
});

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  if (password.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
  try {
    const student = await setStudentPassword(email, password);
    createSession(student, res, req);
    res.json({ ok: true, name: student.name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

const SEM_COBERTURA = 'SEM_COBERTURA_NO_ACERVO';

// Regra compartilhada: decide o ESTILO da resposta conforme o tipo de pergunta.
// - Perguntas de DECISÃO CLÍNICA (indicação de tratamento, prognóstico, conduta, "isso precisa de X?")
//   usam o estilo MENTOR: apresentam os fatores relevantes que faltam saber sobre o caso e fazem
//   perguntas de acompanhamento antes de fechar uma orientação — para o aluno exercitar o raciocínio.
// - Perguntas OBJETIVAS (dose, definição, valor de referência, "o que é X", "qual a dose de Y")
//   são respondidas de forma direta e concisa, sem perguntas desnecessárias.
const ESTILO_RESPOSTA = `Antes de responder, identifique o tipo da pergunta:
- Se for uma PERGUNTA DE DECISÃO CLÍNICA (indicação de tratamento, prognóstico, conduta — ex: "esse caso precisa de quimioterapia?", "qual o prognóstico?", "vale a pena operar?"): responda no ESTILO MENTOR. Apresente brevemente os fatores relevantes que pesam nessa decisão (ex: grau histológico, margens, estadiamento, conforme o assunto) e faça 2-4 perguntas de acompanhamento para o aluno aplicar isso ao caso dele, antes de fechar uma orientação geral. O objetivo é ajudar o aluno a EXERCITAR o raciocínio clínico, não só entregar a resposta pronta.
- Se for uma PERGUNTA OBJETIVA (dose, definição, valor de referência, dado factual direto — ex: "qual a dose de vincristina?", "o que é o índice mitótico?"): responda de forma direta e concisa, sem fazer perguntas de volta desnecessárias.`;

const SYSTEM_PROMPT_ACERVO = `Você é um assistente de apoio ao ensino de um programa de mentoria em oncologia veterinária.
Responda SOMENTE com base no CONTEXTO fornecido pelo usuário, que vem do acervo de aulas, artigos e livros do programa.
Regras obrigatórias:
1) Se o contexto NÃO contiver informação suficiente para responder à pergunta, responda EXATAMENTE e SOMENTE com o texto: ${SEM_COBERTURA}
   (sem mais nada, nem explicação, nem pontuação extra) — isso aciona uma busca complementar automática.
2) Se o contexto for suficiente, ${ESTILO_RESPOSTA}
3) Use linguagem técnica adequada para alunos de pós-graduação em oncologia veterinária.
4) Sempre que a resposta envolver dose de medicamento, inclua no fim: "⚠ Confirme esta dose com a fonte original e com a mentora antes de qualquer uso clínico."
5) Indique ao final, entre parênteses, a fonte usada, ex: (Fonte: Aula 3 — Linfoma).`;

const SYSTEM_PROMPT_FALLBACK = `Você é um assistente de apoio a um programa de mentoria em oncologia veterinária.
O acervo oficial do curso (aulas, artigos e livros selecionados pela mentora) NÃO cobre a pergunta do aluno.
Responda usando seu conhecimento geral de medicina veterinária. Se precisar de informação atual, específica
ou que exija verificação, use a ferramenta de busca na internet disponível.
Regras obrigatórias:
1) Comece a resposta deixando claro que esta informação NÃO vem dos materiais oficiais do curso — é conhecimento
   geral e/ou pesquisa na internet, ainda não revisado pela mentora.
2) ${ESTILO_RESPOSTA}
3) Sempre que mencionar dose de medicamento, inclua: "⚠ Esta dose não foi validada pelos materiais do curso — confirme com a mentora antes de qualquer uso clínico."
4) Seja técnico. Se usou busca na internet, mencione brevemente a fonte.`;

const SYSTEM_PROMPT_EXAM = `Você é um assistente de apoio à interpretação clínica em um programa de mentoria em oncologia veterinária.
O aluno está trazendo um caso ou anexando um exame (laboratorial ou de imagem) para discutir com apoio interpretativo,
da mesma forma que um mentor faria durante uma sessão de caso clínico.
Regras obrigatórias:
1) Se houver CONTEXTO do acervo do curso relevante, use-o e cite a fonte entre parênteses. Caso contrário, baseie-se
   no seu conhecimento geral de medicina veterinária (e pesquisa na internet, se a ferramenta estiver disponível e for útil).
2) Comece deixando claro, em uma linha, que esta é uma interpretação de apoio ao raciocínio clínico — não um laudo
   definitivo — e que o caso deve ser revisado com a mentora.
3) ${ESTILO_RESPOSTA}
4) Se a imagem/texto do exame não permitir uma leitura clara ou faltar informação essencial, diga isso e peça os
   dados que faltam, em vez de supor ou inventar achados.
5) Sempre que mencionar dose de medicamento, inclua: "⚠ Confirme esta dose com a mentora antes de qualquer uso clínico."`;

async function callClaude({ system, content, tools, maxTokens }) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens || 800,
    system,
    messages: [{ role: 'user', content }]
  };
  if (tools) body.tools = tools;
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (data.error) {
    console.error('Erro da API Anthropic:', data.error);
    return null;
  }
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  return textBlocks.join('\n').trim();
}

// Cascata: 1) tenta responder só com o acervo. 2) se não achar, tenta conhecimento geral
// + busca na internet, sempre avisando que a resposta não é do material oficial do curso.
async function askClaudeCascade(question, contextBlock) {
  const userContent = `CONTEXTO DISPONÍVEL:\n${contextBlock || '(nenhum trecho relevante encontrado no acervo)'}\n\nPERGUNTA DO ALUNO:\n${question}`;
  const acervoAnswer = await callClaude({ system: SYSTEM_PROMPT_ACERVO, content: userContent });

  if (acervoAnswer === null) {
    return { answer: 'Desculpe, tive um problema para consultar o acervo agora. Tente novamente em instantes.', tier: 'erro' };
  }
  if (acervoAnswer !== SEM_COBERTURA) {
    return { answer: acervoAnswer, tier: 'acervo' };
  }

  const fallbackAnswer = await callClaude({
    system: SYSTEM_PROMPT_FALLBACK,
    content: `PERGUNTA DO ALUNO:\n${question}`,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }]
  });
  if (fallbackAnswer === null) {
    return { answer: 'O acervo ainda não cobre esse assunto, e tive um problema ao buscar informação complementar. Sugiro perguntar diretamente à mentora.', tier: 'erro' };
  }
  return { answer: fallbackAnswer, tier: 'fallback' };
}

// Interpretação de exame: usado quando o aluno anexa uma imagem (foto de exame) ou texto
// extraído de um PDF. Combina contexto do acervo (se relevante) + conhecimento geral + visão.
async function askClaudeExam(question, contextBlock, attachment) {
  let textPart = `CONTEXTO DO ACERVO (se relevante):\n${contextBlock || '(nenhum trecho relevante encontrado no acervo)'}\n\n`;
  if (attachment?.kind === 'examText') {
    textPart += `TEXTO EXTRAÍDO DO EXAME ANEXADO:\n${attachment.text}\n\n`;
  }
  textPart += `PERGUNTA / CASO DO ALUNO:\n${question}`;

  let content;
  if (attachment?.kind === 'image') {
    content = [
      { type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data } },
      { type: 'text', text: textPart }
    ];
  } else {
    content = textPart;
  }

  const answer = await callClaude({
    system: SYSTEM_PROMPT_EXAM,
    content,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    maxTokens: 1300
  });
  if (answer === null) {
    return { answer: 'Desculpe, tive um problema para interpretar o exame agora. Tente novamente em instantes.', tier: 'erro' };
  }
  return { answer, tier: 'exame' };
}

// ---------- API usada pela tela dos alunos (exige login) ----------

app.get('/api/docs', requireStudentApi, async (req, res) => {
  const docs = (await loadDocs()).map(d => ({ id: d.id, name: d.name }));
  res.json(docs);
});

app.post('/api/ask', requireStudentApi, async (req, res) => {
  try {
    const { question, image, examText } = req.body;
    if (!question) return res.status(400).json({ error: 'question é obrigatório' });
    const docs = await loadDocs();
    const topChunks = retrieveContext(question, docs);
    const contextBlock = topChunks.map(c => `[Fonte: ${c.source}]\n${c.text}`).join('\n\n---\n\n');
    const sources = [...new Set(topChunks.map(c => c.source))];

    let result;
    if (image && image.data && image.mediaType) {
      result = await askClaudeExam(question, contextBlock, { kind: 'image', mediaType: image.mediaType, data: image.data });
    } else if (examText) {
      result = await askClaudeExam(question, contextBlock, { kind: 'examText', text: examText });
    } else {
      result = await askClaudeCascade(question, contextBlock);
    }

    res.json({ answer: result.answer, sources: result.tier === 'acervo' ? sources : [], tier: result.tier });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ---------- Área da mentora: acervo ----------

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'admin', 'admin.html'));
});

app.get('/api/admin/docs', requireAdmin, async (req, res) => {
  res.json(await loadDocs());
});
app.post('/api/admin/docs', requireAdmin, async (req, res) => {
  const { name, text } = req.body;
  if (!name || !text) return res.status(400).json({ error: 'name e text são obrigatórios' });
  await addDoc(name, text);
  res.json(await loadDocs());
});
app.delete('/api/admin/docs/:id', requireAdmin, async (req, res) => {
  await deleteDoc(req.params.id);
  res.json(await loadDocs());
});

// ---------- Área da mentora: convites e contas dos alunos ----------

app.get('/api/admin/students', requireAdmin, async (req, res) => {
  const students = (await loadStudents()).map(s => ({ id: s.id, name: s.name, email: s.email, passwordSet: s.passwordSet }));
  res.json(students);
});

app.post('/api/admin/students', requireAdmin, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name e email são obrigatórios' });
  if (!email.includes('@')) return res.status(400).json({ error: 'E-mail inválido.' });
  try {
    await inviteStudent(name, email);
    const students = (await loadStudents()).map(s => ({ id: s.id, name: s.name, email: s.email, passwordSet: s.passwordSet }));
    res.json(students);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/students/:id/reset', requireAdmin, async (req, res) => {
  try {
    await resetStudentPassword(req.params.id);
    const students = (await loadStudents()).map(s => ({ id: s.id, name: s.name, email: s.email, passwordSet: s.passwordSet }));
    res.json(students);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
  await deleteStudent(req.params.id);
  const students = (await loadStudents()).map(s => ({ id: s.id, name: s.name, email: s.email, passwordSet: s.passwordSet }));
  res.json(students);
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
    const docs = await loadDocs();
    const topChunks = retrieveContext(message.text.body, docs);
    const contextBlock = topChunks.map(c => `[Fonte: ${c.source}]\n${c.text}`).join('\n\n---\n\n');
    const { answer } = await askClaudeCascade(message.text.body, contextBlock);
    await sendWhatsAppMessage(message.from, answer);
  } catch (err) {
    console.error('Erro ao processar mensagem do WhatsApp:', err);
  }
});

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT} (banco de dados: ${useDb ? 'Postgres' : 'arquivo local'})`));
  })
  .catch(err => {
    console.error('Erro ao inicializar o banco de dados:', err);
    app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT} (aviso: banco de dados falhou ao iniciar)`));
  });
