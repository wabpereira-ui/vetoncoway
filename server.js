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
app.use(express.json({ limit: '25mb' }));

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
  // Conversas salvas dos alunos (para reabrir depois, como no histórico do Claude).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
      title TEXT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Triagem Oncoway: ficha catalográfica estruturada por artigo (tipo de neoplasia, tópicos,
  // palavras-chave, resumo) — gerada uma vez por artigo, usada para melhorar a busca.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_metadata (
      doc_id TEXT PRIMARY KEY REFERENCES docs(id) ON DELETE CASCADE,
      tipo_neoplasia JSONB,
      topicos JSONB,
      palavras_chave JSONB,
      resumo TEXT,
      tipo_documento TEXT,
      catalogued_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Triagem Oncoway: doses/protocolos extraídos dos artigos, isolados numa tabela própria
  // para a mentora revisar (e para permitir, no futuro, detectar divergências entre fontes).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS doc_doses (
      id TEXT PRIMARY KEY,
      doc_id TEXT REFERENCES docs(id) ON DELETE CASCADE,
      fonte_nome TEXT,
      medicamento TEXT,
      dose TEXT,
      indicacao TEXT,
      especie TEXT,
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
// Cache em memória: evita buscar o texto completo de TODOS os artigos no banco a cada
// pergunta de aluno (isso estava consumindo o egress do Supabase rapidamente). O cache só
// é renovado quando um material é adicionado/removido, ou a cada 10 minutos por segurança.
let _docsCache = null;
let _docsCacheAt = 0;
const DOCS_CACHE_TTL_MS = 10 * 60 * 1000;

async function loadDocs() {
  if (useDb) {
    if (_docsCache && (Date.now() - _docsCacheAt) < DOCS_CACHE_TTL_MS) return _docsCache;
    const { rows } = await pool.query('SELECT id, name, text FROM docs ORDER BY created_at ASC');
    _docsCache = rows;
    _docsCacheAt = Date.now();
    return rows;
  }
  return JSON.parse(fs.readFileSync(DOCS_PATH, 'utf8'));
}
function invalidateDocsCache() { _docsCache = null; }

async function addDoc(name, text) {
  const id = 'doc-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  if (useDb) {
    await pool.query('INSERT INTO docs (id, name, text) VALUES ($1,$2,$3)', [id, name, text]);
    invalidateDocsCache();
    return id;
  }
  const docs = JSON.parse(fs.readFileSync(DOCS_PATH, 'utf8'));
  docs.push({ id, name, text });
  fs.writeFileSync(DOCS_PATH, JSON.stringify(docs, null, 2));
  return id;
}
async function deleteDoc(id) {
  if (useDb) {
    await pool.query('DELETE FROM docs WHERE id=$1', [id]);
    invalidateDocsCache();
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

// ---- Conversas salvas (historico persistente por aluno, como no Claude) ----
async function listConversations(studentId) {
  if (!useDb) return [];
  const { rows } = await pool.query(
    'SELECT id, title, updated_at FROM conversations WHERE student_id=$1 ORDER BY updated_at DESC',
    [studentId]
  );
  return rows;
}
async function createConversation(studentId) {
  const id = 'conv-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  if (!useDb) return id;
  await pool.query('INSERT INTO conversations (id, student_id, title) VALUES ($1,$2,$3)', [id, studentId, null]);
  return id;
}
async function getConversationOwner(conversationId) {
  if (!useDb) return null;
  const { rows } = await pool.query('SELECT student_id FROM conversations WHERE id=$1', [conversationId]);
  return rows[0] ? rows[0].student_id : null;
}
async function deleteConversation(conversationId) {
  if (!useDb) return;
  await pool.query('DELETE FROM conversations WHERE id=$1', [conversationId]);
}
async function loadConversationMessages(conversationId) {
  if (!useDb) return [];
  const { rows } = await pool.query(
    'SELECT role, content FROM messages WHERE conversation_id=$1 ORDER BY created_at ASC',
    [conversationId]
  );
  return rows;
}
async function appendMessage(conversationId, role, content) {
  if (!useDb) return;
  const id = 'msg-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  await pool.query('INSERT INTO messages (id, conversation_id, role, content) VALUES ($1,$2,$3,$4)', [id, conversationId, role, content]);
  await pool.query('UPDATE conversations SET updated_at = now() WHERE id=$1', [conversationId]);
}
async function maybeSetConversationTitle(conversationId, question) {
  if (!useDb || !question) return;
  const { rows } = await pool.query('SELECT title FROM conversations WHERE id=$1', [conversationId]);
  if (rows[0] && !rows[0].title) {
    const title = question.length > 60 ? question.slice(0, 57) + '...' : question;
    await pool.query('UPDATE conversations SET title=$1 WHERE id=$2', [title, conversationId]);
  }
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
  sessions.set(sessionId, { studentId: student.id, name: student.name, expires: Date.now() + SESSION_DURATION_MS, history: [] });
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
let _metaCache = null;
let _metaCacheAt = 0;
const META_CACHE_TTL_MS = 10 * 60 * 1000;

async function loadMetadataMap() {
  if (!useDb) return {};
  if (_metaCache && (Date.now() - _metaCacheAt) < META_CACHE_TTL_MS) return _metaCache;
  const { rows } = await pool.query('SELECT * FROM doc_metadata');
  const map = {};
  rows.forEach(r => {
    map[r.doc_id] = {
      tipo_neoplasia: r.tipo_neoplasia || [],
      topicos: r.topicos || [],
      palavras_chave: r.palavras_chave || [],
      resumo: r.resumo || '',
      tipo_documento: r.tipo_documento || ''
    };
  });
  _metaCache = map;
  _metaCacheAt = Date.now();
  return map;
}
function invalidateMetaCache() { _metaCache = null; }

async function retrieveContext(query, docs, topN = 5) {
  const qWords = normalize(query).split(/\W+/).filter(w => w.length > 3);
  const metaMap = await loadMetadataMap();
  let scored = [];
  docs.forEach(d => {
    // Ficha catalográfica (Triagem Oncoway): se existir, dá um "bônus" de relevância quando
    // a pergunta bate com o tipo de neoplasia, tópicos ou palavras-chave catalogadas —
    // isso ajuda a achar o artigo certo mesmo quando o aluno usa palavras diferentes do texto.
    const meta = metaMap[d.id];
    let metaBoost = 0;
    if (meta) {
      const tags = [...(meta.tipo_neoplasia || []), ...(meta.topicos || []), ...(meta.palavras_chave || [])]
        .map(t => normalize(String(t)));
      qWords.forEach(w => {
        if (tags.some(tag => tag.includes(w) || w.includes(tag))) metaBoost += 4;
      });
    }
    chunkText(d.text).forEach(c => {
      const cNorm = normalize(c);
      let score = metaBoost;
      qWords.forEach(w => { if (cNorm.includes(w)) score++; });
      if (score > 0) scored.push({ source: d.name, text: c, score });
    });
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

// ---------- Triagem Oncoway: agente de catalogação do acervo ----------
// Roda uma vez por artigo (não a cada pergunta do aluno): lê o texto e extrai uma ficha
// estruturada (tipo de neoplasia, tópicos, palavras-chave, resumo) + as doses/protocolos
// mencionados, numa tabela própria para a mentora revisar.
const CATALOG_SYSTEM_PROMPT = `Você é um agente de catalogação de acervo médico-veterinário ("Triagem Oncoway").
Leia o material abaixo e extraia metadados estruturados para melhorar buscas futuras.
Responda SOMENTE com um objeto JSON válido, sem nenhum texto antes ou depois, EXATAMENTE neste formato:
{
  "tipo_neoplasia": ["..."],
  "topicos": ["..."],
  "palavras_chave": ["..."],
  "resumo": "...",
  "tipo_documento": "...",
  "doses": [ { "medicamento": "...", "dose": "...", "indicacao": "...", "especie": "..." } ]
}
Regras:
- tipo_neoplasia: tipos de câncer/tumor abordados (lista vazia se o material não for específico de um tipo).
- topicos: 3 a 8 tópicos clínicos abordados (ex: "estadiamento", "quimioterapia adjuvante", "fatores prognósticos").
- palavras_chave: 5 a 15 termos e sinônimos que um aluno poderia usar para buscar esse conteúdo, incluindo termos leigos e técnicos.
- resumo: 1-2 frases resumindo o conteúdo do material.
- tipo_documento: ex: "artigo científico", "transcrição de aula", "capítulo de livro", "protocolo clínico".
- doses: toda dose de medicamento mencionada no texto, com a indicação clínica associada. Lista vazia se não houver nenhuma.
- Nunca invente informação que não está no texto. Se um campo não puder ser preenchido com confiança, use lista/string vazia.`;

async function catalogDocument(doc) {
  const userContent = `NOME DA FONTE: ${doc.name}\n\nTEXTO (pode estar truncado):\n${doc.text.slice(0, 15000)}`;
  const raw = await callClaude({
    system: CATALOG_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
    maxTokens: 1200
  });
  if (!raw) return null;
  try {
    const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error('Triagem Oncoway: erro ao interpretar JSON da catalogação:', e.message);
    return null;
  }
}

async function saveMetadata(docId, docName, meta) {
  if (!useDb) return;
  await pool.query(`
    INSERT INTO doc_metadata (doc_id, tipo_neoplasia, topicos, palavras_chave, resumo, tipo_documento)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (doc_id) DO UPDATE SET
      tipo_neoplasia=$2, topicos=$3, palavras_chave=$4, resumo=$5, tipo_documento=$6, catalogued_at=now()
  `, [
    docId,
    JSON.stringify(meta.tipo_neoplasia || []),
    JSON.stringify(meta.topicos || []),
    JSON.stringify(meta.palavras_chave || []),
    meta.resumo || '',
    meta.tipo_documento || ''
  ]);

  await pool.query('DELETE FROM doc_doses WHERE doc_id=$1', [docId]);
  if (Array.isArray(meta.doses)) {
    for (const d of meta.doses) {
      if (!d.medicamento && !d.dose) continue;
      await pool.query(
        'INSERT INTO doc_doses (id, doc_id, fonte_nome, medicamento, dose, indicacao, especie) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        ['dose-' + crypto.randomBytes(6).toString('hex'), docId, docName, d.medicamento || '', d.dose || '', d.indicacao || '', d.especie || '']
      );
    }
  }
  invalidateMetaCache();
}

async function getCatalogStatus() {
  if (!useDb) return { total: 0, catalogued: 0, dbEnabled: false };
  const totalRes = await pool.query('SELECT COUNT(*)::int AS c FROM docs');
  const cataloguedRes = await pool.query('SELECT COUNT(*)::int AS c FROM doc_metadata');
  return { total: totalRes.rows[0].c, catalogued: cataloguedRes.rows[0].c, dbEnabled: true };
}

async function getUncataloguedDocs(limit) {
  if (!useDb) return [];
  const { rows } = await pool.query(`
    SELECT d.id, d.name, d.text FROM docs d
    LEFT JOIN doc_metadata m ON m.doc_id = d.id
    WHERE m.doc_id IS NULL
    ORDER BY d.created_at ASC
    LIMIT $1
  `, [limit]);
  return rows;
}

async function loadDoses() {
  if (!useDb) return [];
  const { rows } = await pool.query('SELECT * FROM doc_doses ORDER BY created_at DESC');
  return rows;
}
async function deleteDoseEntry(id) {
  if (!useDb) return;
  await pool.query('DELETE FROM doc_doses WHERE id=$1', [id]);
}

const SEM_COBERTURA = 'SEM_COBERTURA_NO_ACERVO';

// Regra compartilhada: decide o ESTILO da resposta conforme o tipo de pergunta.
const ESTILO_RESPOSTA = `Antes de responder, identifique o tipo da pergunta:
- Se for uma PERGUNTA DE DECISÃO CLÍNICA (indicação de tratamento, prognóstico, conduta — ex: "esse caso precisa de quimioterapia?", "qual o prognóstico?", "vale a pena operar?"): responda no ESTILO MENTOR. Apresente brevemente os fatores relevantes que pesam nessa decisão (ex: grau histológico, margens, estadiamento, conforme o assunto) e faça 2-4 perguntas de acompanhamento para o aluno aplicar isso ao caso dele, antes de fechar uma orientação geral. O objetivo é ajudar o aluno a EXERCITAR o raciocínio clínico, não só entregar a resposta pronta.
- Se for uma PERGUNTA OBJETIVA (dose, definição, valor de referência, dado factual direto — ex: "qual a dose de vincristina?", "o que é o índice mitótico?"): responda de forma direta e concisa, sem fazer perguntas de volta desnecessárias.`;

// Prompt único (substituiu os três prompts separados de antes). Une acervo + conhecimento
// geral + interpretação de exame + memória de conversa numa só chamada à IA — mais rápido,
// mais barato, e funciona naturalmente com perguntas de acompanhamento ("e sobre isso que
// perguntei antes?").
const SYSTEM_PROMPT_MAIN = `Você é o Agente Oncoway, assistente de apoio a um programa de mentoria em oncologia veterinária.
Você está em uma CONVERSA CONTÍNUA com o aluno — pode haver perguntas de acompanhamento referentes a mensagens
anteriores da mesma conversa; use esse histórico normalmente, do jeito que um mentor faria numa conversa real.

Cada pergunta do aluno pode vir acompanhada de CONTEXTO do acervo oficial do curso, e/ou de imagens e textos de
exames anexados. Você também pode ter acesso a uma ferramenta de busca na internet.

Regras obrigatórias:
1) Se o CONTEXTO do acervo for suficiente para responder, baseie-se nele e cite a fonte entre parênteses, ex: (Fonte: Aula 3 — Linfoma).
2) Se o contexto não for suficiente (ou não houver contexto), responda com seu conhecimento geral de medicina
   veterinária e, se precisar de algo atual ou específico, use a busca na internet — deixando claro na resposta
   que essa parte não vem do material oficial do curso.
3) Se houver imagem(ns) ou texto(s) de exame anexado(s), interprete-os como apoio ao raciocínio clínico do aluno,
   deixando claro que não é um laudo definitivo e que o caso deve ser revisado com a mentora. Se a imagem/texto não
   permitir uma leitura clara, diga isso e peça os dados que faltam, em vez de supor ou inventar achados.
4) ${ESTILO_RESPOSTA}
5) Sempre que mencionar dose de medicamento, inclua: "⚠ Confirme esta dose com a mentora antes de qualquer uso clínico."
6) IMPORTANTE: sempre conclua seu raciocínio por completo — nunca interrompa a resposta no meio. Se a resposta for
   longa, isso é aceitável; o que não pode acontecer é parar antes de fechar a ideia.
7) Ao FINAL de cada resposta, em uma linha própria e por último, escreva EXATAMENTE uma destas duas tags (nada mais
   nessa linha, sem explicação): [[FONTE:ACERVO]] se a resposta se baseou principalmente no acervo do curso, ou
   [[FONTE:GERAL]] se baseou-se em conhecimento geral e/ou busca na internet. Essa tag é só para controle interno
   do sistema — o aluno não vê essa parte.`;

async function callClaude({ system, messages, tools, maxTokens }) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens || 2000,
    system,
    messages
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

const HISTORY_MAX_MESSAGES = 16; // 8 trocas (pergunta+resposta) de memória por conversa

// Monta a mensagem do turno atual: contexto do acervo + textos de exame extraídos (se houver)
// + a pergunta, mais quaisquer imagens anexadas (até 5).
function buildTurnContent(question, contextBlock, images, examTexts) {
  let textPart = `CONTEXTO DO ACERVO (se relevante):\n${contextBlock || '(nenhum trecho relevante encontrado no acervo)'}\n\n`;
  if (examTexts && examTexts.length) {
    examTexts.forEach((t, i) => { textPart += `TEXTO EXTRAÍDO DO EXAME ANEXADO ${i + 1}:\n${t}\n\n`; });
  }
  textPart += `PERGUNTA DO ALUNO:\n${question}`;

  if (images && images.length) {
    const blocks = images.map(img => ({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } }));
    return [...blocks, { type: 'text', text: textPart }];
  }
  return textPart;
}

// Chamada única, com memória de conversa (histórico guardado na sessão do aluno) e suporte
// a múltiplos anexos (imagens e/ou textos de exame extraídos de PDF).
// Núcleo "puro": recebe o histórico (array de {role, content} em texto) e devolve a
// resposta + a origem (acervo/geral), sem decidir sozinho onde guardar o histórico —
// isso permite reaproveitar tanto com conversas salvas no banco quanto com a memória
// de sessão simples (usada como retaguarda sem banco, e pelo WhatsApp).
async function askClaudeCore(history, question, contextBlock, { images, examTexts } = {}) {
  const turnContent = buildTurnContent(question, contextBlock, images, examTexts);
  const messages = [...history, { role: 'user', content: turnContent }];

  const raw = await callClaude({
    system: SYSTEM_PROMPT_MAIN,
    messages,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    maxTokens: 2000
  });

  if (raw === null) {
    return { answer: 'Desculpe, tive um problema para consultar o acervo agora. Tente novamente em instantes.', tier: 'erro' };
  }

  const tagMatch = raw.match(/\[\[FONTE:(ACERVO|GERAL)\]\]\s*$/i);
  let tier = 'fallback';
  let answer = raw;
  if (tagMatch) {
    tier = tagMatch[1].toUpperCase() === 'ACERVO' ? 'acervo' : 'fallback';
    answer = raw.slice(0, tagMatch.index).trim();
  }
  return { answer, tier };
}

// Versão com memória de sessão simples (retaguarda sem banco de dados, e usada pelo WhatsApp).
async function askClaude(session, question, contextBlock, { images, examTexts } = {}) {
  const history = session.history || [];
  const result = await askClaudeCore(history, question, contextBlock, { images, examTexts });

  const historyQuestion = question || (images?.length || examTexts?.length ? '[anexo(s) de exame enviado(s)]' : question);
  session.history = [...history, { role: 'user', content: historyQuestion }, { role: 'assistant', content: result.answer }];
  while (session.history.length > HISTORY_MAX_MESSAGES) session.history.shift();

  return result;
}

// ---------- API usada pela tela dos alunos (exige login) ----------

app.get('/api/docs', requireStudentApi, async (req, res) => {
  const docs = (await loadDocs()).map(d => ({ id: d.id, name: d.name }));
  res.json(docs);
});

app.post('/api/ask', requireStudentApi, async (req, res) => {
  try {
    const { question, images, examTexts, conversationId } = req.body;
    if (!question && !(images?.length) && !(examTexts?.length)) {
      return res.status(400).json({ error: 'question ou anexo é obrigatório' });
    }
    const safeImages = Array.isArray(images) ? images.slice(0, 5) : [];
    const safeExamTexts = Array.isArray(examTexts) ? examTexts.slice(0, 5) : [];
    const finalQuestion = question || 'Interprete o(s) exame(s) anexado(s).';

    const docs = await loadDocs();
    const topChunks = await retrieveContext(finalQuestion, docs);
    const contextBlock = topChunks.map(c => `[Fonte: ${c.source}]\n${c.text}`).join('\n\n---\n\n');
    const sources = [...new Set(topChunks.map(c => c.source))];

    let result;
    if (useDb && conversationId) {
      // Confere que a conversa pertence mesmo ao aluno logado, antes de usar/gravar nela.
      const owner = await getConversationOwner(conversationId);
      if (owner !== req.student.studentId) {
        return res.status(403).json({ error: 'Conversa não encontrada.' });
      }
      const history = await loadConversationMessages(conversationId);
      result = await askClaudeCore(history, finalQuestion, contextBlock, { images: safeImages, examTexts: safeExamTexts });
      const historyQuestion = question || (safeImages.length || safeExamTexts.length ? '[anexo(s) de exame enviado(s)]' : question);
      await appendMessage(conversationId, 'user', historyQuestion);
      await appendMessage(conversationId, 'assistant', result.answer);
      await maybeSetConversationTitle(conversationId, question);
    } else {
      // Retaguarda sem banco (ou sem conversationId): memória de sessão simples, como antes.
      result = await askClaude(req.student, finalQuestion, contextBlock, { images: safeImages, examTexts: safeExamTexts });
    }

    res.json({ answer: result.answer, sources: result.tier === 'acervo' ? sources : [], tier: result.tier });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ---------- Conversas salvas do aluno (histórico persistente, como no Claude) ----------

app.get('/api/conversations', requireStudentApi, async (req, res) => {
  res.json(await listConversations(req.student.studentId));
});

app.post('/api/conversations', requireStudentApi, async (req, res) => {
  const id = await createConversation(req.student.studentId);
  res.json({ id });
});

app.get('/api/conversations/:id/messages', requireStudentApi, async (req, res) => {
  const owner = await getConversationOwner(req.params.id);
  if (owner !== req.student.studentId) return res.status(403).json({ error: 'Conversa não encontrada.' });
  res.json(await loadConversationMessages(req.params.id));
});

app.delete('/api/conversations/:id', requireStudentApi, async (req, res) => {
  const owner = await getConversationOwner(req.params.id);
  if (owner !== req.student.studentId) return res.status(403).json({ error: 'Conversa não encontrada.' });
  await deleteConversation(req.params.id);
  res.json({ ok: true });
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
  const docId = await addDoc(name, text);
  res.json(await loadDocs());

  // Triagem Oncoway: cataloga em segundo plano, sem fazer o upload esperar.
  if (useDb) {
    catalogDocument({ name, text })
      .then(meta => { if (meta) return saveMetadata(docId, name, meta); })
      .catch(err => console.error('Triagem Oncoway: erro ao catalogar', name, err));
  }
});
app.delete('/api/admin/docs/:id', requireAdmin, async (req, res) => {
  await deleteDoc(req.params.id);
  res.json(await loadDocs());
});

// ---------- Triagem Oncoway (agente de catalogação do acervo) ----------

app.get('/api/admin/catalog-status', requireAdmin, async (req, res) => {
  res.json(await getCatalogStatus());
});

// Processa um lote de artigos ainda não catalogados (a mentora pode clicar de novo até
// zerar a fila — cada clique processa até 8 artigos, para não travar em acervos grandes).
app.post('/api/admin/catalog-batch', requireAdmin, async (req, res) => {
  if (!useDb) return res.status(400).json({ error: 'A catalogação exige banco de dados configurado (DATABASE_URL).' });
  const BATCH_SIZE = 8;
  const pending = await getUncataloguedDocs(BATCH_SIZE);
  let processed = 0;
  for (const doc of pending) {
    try {
      const meta = await catalogDocument(doc);
      if (meta) { await saveMetadata(doc.id, doc.name, meta); processed++; }
    } catch (err) {
      console.error('Triagem Oncoway: erro ao catalogar', doc.name, err);
    }
  }
  const status = await getCatalogStatus();
  res.json({ processed, ...status });
});

app.get('/api/admin/doses', requireAdmin, async (req, res) => {
  res.json(await loadDoses());
});
app.delete('/api/admin/doses/:id', requireAdmin, async (req, res) => {
  await deleteDoseEntry(req.params.id);
  res.json(await loadDoses());
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

const whatsappSessions = new Map(); // telefone -> { history: [] }

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!message || message.type !== 'text') return;
    const docs = await loadDocs();
    const topChunks = await retrieveContext(message.text.body, docs);
    const contextBlock = topChunks.map(c => `[Fonte: ${c.source}]\n${c.text}`).join('\n\n---\n\n');
    if (!whatsappSessions.has(message.from)) whatsappSessions.set(message.from, { history: [] });
    const waSession = whatsappSessions.get(message.from);
    const { answer } = await askClaude(waSession, message.text.body, contextBlock);
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
