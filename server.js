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
app.set('trust proxy', 1); // atrás do proxy do Render: req.ip passa a ser o IP real do visitante
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
  // Telefone de WhatsApp (opcional) — usado para restringir o bot só a alunos matriculados.
  // ALTER com IF NOT EXISTS garante que funciona tanto em bancos novos quanto já existentes.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS phone TEXT;`);
  // Rastreamento de acesso (aditivo — não afeta login/senha existentes de ninguém).
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS last_login TIMESTAMPTZ;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS login_count INT DEFAULT 0;`);
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
  // Para o painel de atividade: de onde veio a resposta (acervo/geral) e quais materiais
  // foram usados — permite montar o ranking de "assuntos mais procurados".
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS tier TEXT;`);
  await pool.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_doc_ids JSONB;`);
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
  // Configurações do app (identidade da mentora, modo de busca na internet) — editáveis pelo /admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Planos e cotas. Alunos já existentes ficam no plano Mentoria (DEFAULT), então nada muda para eles.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'mentoria';`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS free_exams_used INT DEFAULT 0;`);
  // Cadastro aberto: contas criadas pelo próprio usuário precisam confirmar o e-mail. Contas antigas ficam confirmadas.
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT TRUE;`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'convite';`);
  await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash TEXT PRIMARY KEY,
      student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  // Registro de uso (cotas + custo real estimado de cada resposta).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usage_events (
      id BIGSERIAL PRIMARY KEY,
      student_id TEXT REFERENCES students(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      channel TEXT,
      tier TEXT,
      input_tokens INT DEFAULT 0,
      output_tokens INT DEFAULT 0,
      searches INT DEFAULT 0,
      cost_usd NUMERIC(12,6) DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS usage_events_student_time ON usage_events (student_id, created_at);`);
  // Aparência: imagens (logo, foto da mentora, banners) e banners editáveis pelo /admin.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_assets (
      key TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_banners (
      id TEXT PRIMARY KEY,
      title TEXT,
      body TEXT,
      link_url TEXT,
      link_label TEXT,
      active BOOLEAN DEFAULT TRUE,
      position INT DEFAULT 0,
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
    const { rows } = await pool.query('SELECT id, name, email, phone, password_set AS "passwordSet", salt, hash, last_login AS "lastLogin", COALESCE(login_count,0) AS "loginCount", created_at AS "createdAt", COALESCE(plan,\'mentoria\') AS plan, COALESCE(free_exams_used,0) AS "freeExamsUsed", COALESCE(email_verified,true) AS "emailVerified", COALESCE(source,\'convite\') AS source FROM students ORDER BY created_at ASC');
    return rows;
  }
  return loadStudentsFile();
}

// Cria um "convite" — nome + e-mail, ainda sem senha. O aluno define a senha
// dele mesmo na tela de "Primeiro acesso".
function normalizePhone(phone) {
  return (phone || '').replace(/\D/g, ''); // só dígitos, para comparar com o formato que o WhatsApp envia
}

async function inviteStudent(name, email, phone) {
  const emailNorm = email.trim().toLowerCase();
  const phoneNorm = phone ? normalizePhone(phone) : null;
  const id = 'aluno-' + Date.now();
  if (useDb) {
    const existing = await pool.query('SELECT id, name, source, plan FROM students WHERE email=$1', [emailNorm]);
    if (existing.rows.length) {
      // Pessoa que já se cadastrou sozinha (plano Grátis) e agora entrou na mentoria: promove a conta, sem apagar nada.
      if (existing.rows[0].source === 'cadastro' && existing.rows[0].plan !== 'mentoria') {
        await pool.query(`UPDATE students SET plan='mentoria', phone=COALESCE($2, phone) WHERE id=$1`, [existing.rows[0].id, phoneNorm]);
        return { id: existing.rows[0].id, name: existing.rows[0].name, email: emailNorm, phone: phoneNorm, promoted: true };
      }
      throw new Error('Já existe um convite ou conta com esse e-mail.');
    }
    await pool.query('INSERT INTO students (id, name, email, phone, password_set) VALUES ($1,$2,$3,$4,false)', [id, name, emailNorm, phoneNorm]);
    return { id, name, email: emailNorm, phone: phoneNorm };
  }
  const students = loadStudentsFile();
  if (students.some(s => s.email === emailNorm)) throw new Error('Já existe um convite ou conta com esse e-mail.');
  const student = { id, name, email: emailNorm, phone: phoneNorm, passwordSet: false, salt: null, hash: null };
  students.push(student);
  saveStudentsFile(students);
  return student;
}

async function getStudentByPhone(phone) {
  const phoneNorm = normalizePhone(phone);
  if (!phoneNorm) return null;
  if (useDb) {
    const { rows } = await pool.query('SELECT id, name, phone FROM students WHERE phone=$1', [phoneNorm]);
    return rows[0] || null;
  }
  const student = loadStudentsFile().find(s => normalizePhone(s.phone) === phoneNorm);
  return student || null;
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
    student = rows[0] ? { id: rows[0].id, name: rows[0].name, passwordSet: rows[0].password_set, salt: rows[0].salt, hash: rows[0].hash, emailVerified: rows[0].email_verified !== false } : null;
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
async function listConversations(studentId, historyDays = 0) {
  if (!useDb) return [];
  const { rows } = historyDays > 0
    ? await pool.query(
        `SELECT id, title, updated_at FROM conversations WHERE student_id=$1 AND updated_at > now() - make_interval(days => $2) ORDER BY updated_at DESC`,
        [studentId, historyDays])
    : await pool.query('SELECT id, title, updated_at FROM conversations WHERE student_id=$1 ORDER BY updated_at DESC', [studentId]);
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
async function appendMessage(conversationId, role, content, { tier, sourceDocIds } = {}) {
  if (!useDb) return;
  const id = 'msg-' + Date.now() + '-' + crypto.randomBytes(3).toString('hex');
  await pool.query(
    'INSERT INTO messages (id, conversation_id, role, content, tier, source_doc_ids) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, conversationId, role, content, tier || null, sourceDocIds && sourceDocIds.length ? JSON.stringify(sourceDocIds) : null]
  );
  await pool.query('UPDATE conversations SET updated_at = now() WHERE id=$1', [conversationId]);
}
async function recordLogin(studentId) {
  if (!useDb) return;
  await pool.query('UPDATE students SET last_login = now(), login_count = COALESCE(login_count,0) + 1 WHERE id=$1', [studentId]);
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

// ---------- Cadastro aberto, confirmação de e-mail e recuperação de senha ----------
// Envio de e-mail: Brevo (BREVO_API_KEY) ou Resend (RESEND_API_KEY). Se as duas existirem, usa o Brevo.
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_API_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_API_URL = process.env.RESEND_API_URL || 'https://api.resend.com/emails';
const MAIL_FROM = process.env.MAIL_FROM; // ex: "Oncoway <contato@vetjoicefaria.com>"
function mailProvider() { return BREVO_API_KEY ? 'brevo' : (RESEND_API_KEY ? 'resend' : null); }
function mailConfigured() { return Boolean(mailProvider() && MAIL_FROM); }
function parseFrom(from) {
  const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(from || '');
  return m ? { name: m[1].trim(), email: m[2].trim() } : { name: '', email: String(from || '').trim() };
}

async function sendMail({ to, subject, html, text }) {
  let r;
  if (mailProvider() === 'brevo') {
    const f = parseFrom(MAIL_FROM);
    r = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({ sender: f.name ? { name: f.name, email: f.email } : { email: f.email }, to: [{ email: to }], subject, htmlContent: html, textContent: text })
    });
  } else {
    r = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, html, text })
    });
  }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`Falha ao enviar e-mail (${r.status}): ${body.slice(0, 200)}`);
  }
}
const escHtml = t => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function baseUrl(req) {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/+$/, '');
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
  return `${proto}://${req.get('host')}`;
}
async function sendAuthMail(req, to, kind, name, link) {
  const cfg = await getSettings();
  const app = escHtml(cfg.appName);
  const templates = {
    verify: { subject: `Confirme seu e-mail — ${cfg.appName}`, intro: `Olá, ${escHtml(name)}! Falta só confirmar seu e-mail para ativar sua conta no ${app}.`, cta: 'Confirmar meu e-mail', note: 'O link vale por 24 horas. Se não foi você, ignore este e-mail.' },
    reset: { subject: `Redefinir sua senha — ${cfg.appName}`, intro: `Recebemos um pedido para redefinir a senha da sua conta no ${app}.`, cta: 'Criar nova senha', note: 'O link vale por 1 hora. Se não foi você, ignore este e-mail: sua senha continua a mesma.' }
  };
  const t = templates[kind];
  const html = `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1E2A32"><h2 style="color:${escHtml(cfg.primaryColor)}">${app}</h2><p>${t.intro}</p><p><a href="${escHtml(link)}" style="display:inline-block;background:${escHtml(cfg.accentColor)};color:#fff;padding:12px 20px;border-radius:4px;text-decoration:none">${t.cta}</a></p><p style="font-size:13px;color:#4B5A61">${t.note}</p><p style="font-size:12px;color:#8a979d">Se o botão não funcionar, copie este endereço no navegador:<br>${escHtml(link)}</p></div>`;
  await sendMail({ to, subject: t.subject, html, text: `${t.intro.replace(/<[^>]+>/g, '')}\n\n${link}\n\n${t.note}` });
}
async function sendInfoMail(to, subject, bodyHtml) {
  const cfg = await getSettings();
  await sendMail({ to, subject: `${subject} — ${cfg.appName}`, html: `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#1E2A32"><h2 style="color:${escHtml(cfg.primaryColor)}">${escHtml(cfg.appName)}</h2>${bodyHtml}</div>`, text: bodyHtml.replace(/<[^>]+>/g, ' ') });
}

// Limite de tentativas em memória (suficiente para um servidor único).
const _rate = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const arr = (_rate.get(key) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { _rate.set(key, arr); return false; }
  arr.push(now); _rate.set(key, arr);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of _rate) { if (!v.some(t => now - t < 3600000)) _rate.delete(k); } }, 600000).unref();

const sha256 = t => crypto.createHash('sha256').update(t).digest('hex');
async function createAuthToken(studentId, kind, ttlMs) {
  const raw = crypto.randomBytes(32).toString('hex');
  await pool.query('UPDATE auth_tokens SET used_at = now() WHERE student_id=$1 AND kind=$2 AND used_at IS NULL', [studentId, kind]);
  await pool.query('INSERT INTO auth_tokens (token_hash, student_id, kind, expires_at) VALUES ($1,$2,$3,$4)', [sha256(raw), studentId, kind, new Date(Date.now() + ttlMs)]);
  return raw;
}
async function consumeAuthToken(raw, kind) {
  if (!raw || typeof raw !== 'string' || raw.length > 200) return null;
  const { rows } = await pool.query(
    'UPDATE auth_tokens SET used_at = now() WHERE token_hash=$1 AND kind=$2 AND used_at IS NULL AND expires_at > now() RETURNING student_id',
    [sha256(raw), kind]);
  return rows[0] ? rows[0].student_id : null;
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const GENERIC_SENT = 'Se o e-mail estiver correto, enviamos as instruções. Confira também a caixa de spam.';

function simplePage(title, bodyHtml) {
  return `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(title)}</title>
<style>body{margin:0;background:#F1F3EE;font-family:Arial,sans-serif;color:#1E2A32;line-height:1.6}.c{max-width:680px;margin:40px auto;padding:28px;background:#fff;border:1px solid #CBD3C4;border-top:3px solid #5C8374}h1{font-size:22px;color:#223449}a{color:#3F5C50}p{margin:10px 0}</style></head><body><div class="c"><h1>${escHtml(title)}</h1>${bodyHtml}</div></body></html>`;
}
function textToHtml(t) { return String(t).split(/\n{2,}/).map(p => `<p>${escHtml(p).replace(/\n/g, '<br>')}</p>`).join(''); }

app.get('/termos', async (req, res) => { const c = await getSettings(); res.send(simplePage('Termos de uso', textToHtml(c.termsText) + '<p><a href="/login.html">Voltar</a></p>')); });
app.get('/privacidade', async (req, res) => { const c = await getSettings(); res.send(simplePage('Política de privacidade', textToHtml(c.privacyText) + '<p><a href="/login.html">Voltar</a></p>')); });

// Criar conta (plano Grátis). Resposta sempre genérica, para não revelar quais e-mails já existem.
app.post('/api/signup', async (req, res) => {
  try {
    const { name, email, password, acceptTerms, website } = req.body || {};
    if (website) return res.json({ ok: true, message: GENERIC_SENT }); // honeypot: robôs preenchem
    const cfg = await getSettings();
    if (cfg.signupOpen !== 'sim' || !useDb) return res.status(403).json({ error: 'O cadastro ainda não está aberto.' });
    if (!mailConfigured()) return res.status(503).json({ error: 'O cadastro está temporariamente indisponível.' });
    const nm = String(name || '').trim(), em = String(email || '').trim().toLowerCase(), pw = String(password || '');
    if (nm.length < 2 || nm.length > 80) return res.status(400).json({ error: 'Informe seu nome.' });
    if (!EMAIL_RE.test(em) || em.length > 160) return res.status(400).json({ error: 'E-mail inválido.' });
    if (pw.length < 8 || pw.length > 128) return res.status(400).json({ error: 'A senha precisa ter entre 8 e 128 caracteres.' });
    if (acceptTerms !== true) return res.status(400).json({ error: 'É preciso aceitar os termos de uso e a política de privacidade.' });
    // limite só para tentativas válidas (as que gastariam e-mail): 8 por hora por IP, 3 por e-mail
    if (!rateLimit('signup:' + req.ip, 8, 3600000)) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
    if (!rateLimit('signup-mail:' + em, 3, 3600000)) return res.json({ ok: true, message: GENERIC_SENT });

    const existing = await pool.query('SELECT id, name, password_set FROM students WHERE email=$1', [em]);
    const root = baseUrl(req);
    if (!existing.rows.length) {
      const id = 'u-' + crypto.randomBytes(8).toString('hex');
      const salt = crypto.randomBytes(16).toString('hex');
      await pool.query(
        `INSERT INTO students (id, name, email, password_set, salt, hash, plan, source, email_verified, terms_accepted_at)
         VALUES ($1,$2,$3,true,$4,$5,'gratis','cadastro',false,now())`, [id, nm, em, salt, hashPassword(pw, salt)]);
      const token = await createAuthToken(id, 'verify', 24 * 3600000);
      await sendAuthMail(req, em, 'verify', nm, `${root}/verificar?token=${token}`);
    } else if (existing.rows[0].password_set) {
      await sendInfoMail(em, 'Você já tem uma conta', `<p>Alguém (provavelmente você) tentou criar uma conta com este e-mail, mas ele já está cadastrado.</p><p><a href="${escHtml(root)}/login.html">Entrar</a> · Esqueceu a senha? Use "Esqueci minha senha" na tela de entrada.</p>`);
    } else {
      await sendInfoMail(em, 'Seu convite está esperando', `<p>Este e-mail já foi convidado pela mentora. Na tela de entrada, use a aba <b>Primeiro acesso</b> para criar sua senha.</p><p><a href="${escHtml(root)}/login.html">Abrir o app</a></p>`);
    }
    res.json({ ok: true, message: GENERIC_SENT });
  } catch (e) { console.error('signup:', e.message); res.status(500).json({ error: 'Não foi possível concluir agora. Tente novamente.' }); }
});

app.get('/verificar', async (req, res) => {
  try {
    if (!useDb) return res.status(404).end();
    const studentId = await consumeAuthToken(String(req.query.token || ''), 'verify');
    if (!studentId) return res.status(400).send(simplePage('Link inválido ou expirado', '<p>Este link de confirmação não vale mais. Entre com seu e-mail e senha e peça um novo link.</p><p><a href="/login.html">Ir para a entrada</a></p>'));
    await pool.query('UPDATE students SET email_verified=true WHERE id=$1', [studentId]);
    const { rows } = await pool.query('SELECT id, name FROM students WHERE id=$1', [studentId]);
    createSession(rows[0], res, req);
    await recordLogin(rows[0].id);
    res.redirect('/');
  } catch (e) { console.error('verificar:', e.message); res.status(500).send(simplePage('Erro', '<p>Não foi possível confirmar agora. Tente novamente.</p>')); }
});

app.post('/api/resend-verification', async (req, res) => {
  try {
    const em = String((req.body || {}).email || '').trim().toLowerCase();
    if (!useDb || !mailConfigured() || !EMAIL_RE.test(em)) return res.json({ ok: true, message: GENERIC_SENT });
    if (!rateLimit('resend-ip:' + req.ip, 10, 3600000) || !rateLimit('resend:' + em, 3, 3600000)) return res.json({ ok: true, message: GENERIC_SENT });
    const { rows } = await pool.query(`SELECT id, name FROM students WHERE email=$1 AND email_verified=false AND source='cadastro'`, [em]);
    if (rows[0]) { const token = await createAuthToken(rows[0].id, 'verify', 24 * 3600000); await sendAuthMail(req, em, 'verify', rows[0].name, `${baseUrl(req)}/verificar?token=${token}`); }
    res.json({ ok: true, message: GENERIC_SENT });
  } catch (e) { console.error('resend:', e.message); res.json({ ok: true, message: GENERIC_SENT }); }
});

app.post('/api/forgot', async (req, res) => {
  try {
    const em = String((req.body || {}).email || '').trim().toLowerCase();
    if (!useDb || !mailConfigured() || !EMAIL_RE.test(em)) return res.json({ ok: true, message: GENERIC_SENT });
    if (!rateLimit('forgot-ip:' + req.ip, 10, 3600000) || !rateLimit('forgot:' + em, 3, 3600000)) return res.json({ ok: true, message: GENERIC_SENT });
    const { rows } = await pool.query('SELECT id, name FROM students WHERE email=$1 AND password_set=true', [em]);
    if (rows[0]) { const token = await createAuthToken(rows[0].id, 'reset', 3600000); await sendAuthMail(req, em, 'reset', rows[0].name, `${baseUrl(req)}/redefinir?token=${token}`); }
    res.json({ ok: true, message: GENERIC_SENT });
  } catch (e) { console.error('forgot:', e.message); res.json({ ok: true, message: GENERIC_SENT }); }
});

app.get('/redefinir', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'reset.html')); });

app.post('/api/reset', async (req, res) => {
  try {
    if (!useDb) return res.status(404).end();
    if (!rateLimit('reset:' + req.ip, 20, 3600000)) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
    const { token, password } = req.body || {};
    const pw = String(password || '');
    if (pw.length < 8 || pw.length > 128) return res.status(400).json({ error: 'A senha precisa ter entre 8 e 128 caracteres.' });
    const studentId = await consumeAuthToken(String(token || ''), 'reset');
    if (!studentId) return res.status(400).json({ error: 'Este link não vale mais. Peça um novo em "Esqueci minha senha".' });
    const salt = crypto.randomBytes(16).toString('hex');
    await pool.query('UPDATE students SET salt=$1, hash=$2, password_set=true, email_verified=true WHERE id=$3', [salt, hashPassword(pw, salt), studentId]);
    // encerra sessões antigas dessa conta
    for (const [sid, sess] of sessions) { if (sess.studentId === studentId) sessions.delete(sid); }
    const { rows } = await pool.query('SELECT id, name FROM students WHERE id=$1', [studentId]);
    createSession(rows[0], res, req);
    await recordLogin(studentId);
    res.json({ ok: true });
  } catch (e) { console.error('reset:', e.message); res.status(500).json({ error: 'Não foi possível redefinir agora.' }); }
});

// O próprio usuário apaga a conta (LGPD): remove conversas, uso e cadastro.
app.post('/api/me/delete', requireStudentApi, async (req, res) => {
  try {
    if (!useDb) return res.status(400).json({ error: 'Indisponível.' });
    const { rows } = await pool.query('SELECT email FROM students WHERE id=$1', [req.student.studentId]);
    if (!rows[0]) return res.status(404).json({ error: 'Conta não encontrada.' });
    const ok = await verifyStudent(rows[0].email, (req.body || {}).password);
    if (!ok) return res.status(403).json({ error: 'Senha incorreta.' });
    await deleteStudent(req.student.studentId);
    destroySession(req, res);
    res.json({ ok: true });
  } catch (e) { console.error('delete account:', e.message); res.status(500).json({ error: 'Não foi possível excluir agora.' }); }
});

// Limpeza: contas criadas sozinhas e nunca confirmadas somem depois de 7 dias.
async function cleanupUnverified() {
  if (!useDb) return;
  try {
    await pool.query(`DELETE FROM students WHERE source='cadastro' AND email_verified=false AND created_at < now() - interval '7 days'`);
    await pool.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '1 day'`);
  } catch (e) { console.error('cleanup:', e.message); }
}
setInterval(cleanupUnverified, 3600000).unref();

// Rotas públicas de login/cadastro (sem exigir sessão)
app.get('/api/branding', async (req, res) => {
  try { res.json(await getBranding()); }
  catch (e) { console.error(e); res.status(500).json({ error: 'branding' }); }
});

// Imagens de marca (públicas: o login precisa mostrar o logo antes do acesso).
app.get('/brand/:key', async (req, res) => {
  try {
    if (!validAssetKey(req.params.key)) return res.status(404).end();
    const a = await getAsset(req.params.key);
    if (!a) return res.status(404).end();
    res.set('Content-Type', a.mime);
    res.set('Cache-Control', 'public, max-age=86400');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(Buffer.from(a.data, 'base64'));
  } catch (e) { res.status(500).end(); }
});

app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!rateLimit('login:' + req.ip + ':' + String(email || '').toLowerCase(), 20, 15 * 60000)) {
    return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
  }
  const student = await verifyStudent(email, password);
  if (!student) return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  if (student.emailVerified === false) {
    return res.status(403).json({ error: 'Confirme seu e-mail para entrar. Enviamos um link quando você criou a conta.', needVerify: true });
  }
  createSession(student, res, req);
  await recordLogin(student.id);
  res.json({ ok: true, name: student.name });
});

app.post('/api/register', async (req, res) => {
  const { email, password } = req.body;
  if (!rateLimit('register:' + req.ip, 20, 3600000)) return res.status(429).json({ error: 'Muitas tentativas. Tente novamente mais tarde.' });
  if (!email || !password) return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  if (password.length < 6) return res.status(400).json({ error: 'A senha precisa ter pelo menos 6 caracteres.' });
  try {
    const student = await setStudentPassword(email, password);
    createSession(student, res, req);
    await recordLogin(student.id);
    res.json({ ok: true, name: student.name });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  destroySession(req, res);
  res.json({ ok: true });
});
app.get('/api/me', async (req, res) => {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'not_authenticated' });
  let usage = null;
  try { usage = usageSummary(await getUsageInfo(session.studentId)); } catch (e) { console.error(e.message); }
  res.json({ name: session.name, usage });
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
      if (score > 0) scored.push({ source: d.name, docId: d.id, text: c, score });
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

// ---------- Painel de atividade (acompanhamento de acesso e uso) ----------
async function getAnalytics() {
  if (!useDb) return { dbEnabled: false };

  const [studentsRes, tierRes, materialsRes, topicsRes, dailyRes, uncoveredRes] = await Promise.all([
    pool.query(`
      SELECT s.id, s.name, s.email, s.last_login, s.login_count,
        COALESCE(mc.msg_count, 0)::int AS msg_count,
        mc.last_active
      FROM students s
      LEFT JOIN (
        SELECT c.student_id,
          COUNT(*) FILTER (WHERE m.role = 'user') AS msg_count,
          MAX(m.created_at) AS last_active
        FROM messages m
        JOIN conversations c ON m.conversation_id = c.id
        GROUP BY c.student_id
      ) mc ON mc.student_id = s.id
      ORDER BY mc.last_active DESC NULLS LAST, s.created_at DESC
    `),
    pool.query(`SELECT tier, COUNT(*)::int AS count FROM messages WHERE role='assistant' AND tier IS NOT NULL GROUP BY tier`),
    pool.query(`
      SELECT d.name AS name, COUNT(*)::int AS count
      FROM messages m
      CROSS JOIN LATERAL jsonb_array_elements_text(m.source_doc_ids) AS doc_id
      JOIN docs d ON d.id = doc_id
      WHERE m.role = 'assistant' AND m.source_doc_ids IS NOT NULL
      GROUP BY d.name
      ORDER BY count DESC
      LIMIT 10
    `),
    pool.query(`
      SELECT topic, COUNT(*)::int AS count FROM (
        SELECT jsonb_array_elements_text(dm.topicos) AS topic
        FROM messages m
        CROSS JOIN LATERAL jsonb_array_elements_text(m.source_doc_ids) AS doc_id
        JOIN doc_metadata dm ON dm.doc_id = doc_id
        WHERE m.role = 'assistant' AND m.source_doc_ids IS NOT NULL
        UNION ALL
        SELECT jsonb_array_elements_text(dm.tipo_neoplasia) AS topic
        FROM messages m
        CROSS JOIN LATERAL jsonb_array_elements_text(m.source_doc_ids) AS doc_id
        JOIN doc_metadata dm ON dm.doc_id = doc_id
        WHERE m.role = 'assistant' AND m.source_doc_ids IS NOT NULL
      ) sub
      GROUP BY topic
      ORDER BY count DESC
      LIMIT 12
    `),
    pool.query(`
      SELECT to_char(date_trunc('day', created_at), 'DD/MM') AS day, COUNT(*)::int AS count
      FROM messages
      WHERE role = 'user' AND created_at > now() - interval '14 days'
      GROUP BY date_trunc('day', created_at)
      ORDER BY date_trunc('day', created_at)
    `),
    pool.query(`
      SELECT q.content AS question, to_char(m.created_at, 'DD/MM HH24:MI') AS at
      FROM messages m
      CROSS JOIN LATERAL (
        SELECT u.content FROM messages u
        WHERE u.conversation_id = m.conversation_id AND u.role = 'user' AND u.created_at <= m.created_at
        ORDER BY u.created_at DESC LIMIT 1
      ) q
      WHERE m.role = 'assistant' AND m.tier = 'sem_cobertura'
      ORDER BY m.created_at DESC
      LIMIT 25
    `)
  ]);

  return {
    dbEnabled: true,
    students: studentsRes.rows,
    tierDistribution: tierRes.rows,
    topMaterials: materialsRes.rows,
    topTopics: topicsRes.rows,
    dailyActivity: dailyRes.rows,
    uncovered: uncoveredRes.rows
  };
}

async function deleteDoseEntry(id) {
  if (!useDb) return;
  await pool.query('DELETE FROM doc_doses WHERE id=$1', [id]);
}

// ---------- Configurações do app (identidade + modo de busca) ----------
// Tudo aditivo: sem nenhuma configuração salva, valem os padrões abaixo.
const SETTINGS_PATH = path.join(__dirname, 'settings.json');
const SEARCH_MODES = ['acervo', 'acervo_web', 'aberto'];
const DEFAULT_SETTINGS = {
  appName: 'Agente Oncoway',
  tagline: 'Raciocínio clínico em oncologia veterinária, no método da sua mentora',
  mentorName: 'Joice Faria',
  mentorTitle: 'Médica-veterinária oncologista',
  // Como a mentora explica: vira parte do prompt. Ela pode reescrever com as próprias palavras.
  voice: 'Fale como a mentora falaria numa discussão de caso: direta, didática e clínica, sem formalidade excessiva. ' +
    'Priorize o raciocínio (por que decidir assim) antes da regra decorada. Organize casos clínicos em: ' +
    'Resumo do caso, Raciocínio, Conduta sugerida e Pontos de atenção.',
  // acervo = só o material da mentora; acervo_web = acervo e, se faltar, busca limitada na internet;
  // aberto = comportamento antigo (conhecimento geral e internet livres).
  searchMode: 'acervo_web',
  // Aparência (todos opcionais; sem configuração vale o visual atual)
  primaryColor: '#223449',
  accentColor: '#5C8374',
  fontHeading: 'serif',      // serif | sans
  radius: 'reto',            // reto | suave | redondo
  showEntryCards: 'sim',     // sim | nao
  quickLinks: '[]',          // JSON: [{label,url}] até 6
  // Planos (editáveis em /admin → Planos e custos). 0 em questions/exams = recurso indisponível.
  plans: '',                 // JSON; vazio = padrões abaixo (DEFAULT_PLANS)
  freeExamsOnce: '5',        // exames grátis, uma única vez, para quem está no plano Grátis
  upgradeUrl: '',            // para onde vai o botão "Assinar" (página de vendas/checkout)
  // Preços da API para ESTIMAR o custo (confira na Anthropic e ajuste): US$ por milhão de tokens e por mil buscas.
  priceInputPerM: '3', priceOutputPerM: '15', priceSearchPer1k: '10', usdBrl: '5.5',
  // Cadastro aberto (desligado por padrão: só quem é convidado entra, como sempre foi)
  signupOpen: 'nao',
  supportEmail: '',
  termsText: '',             // vazio = modelo padrão (DEFAULT_TERMS)
  privacyText: ''            // vazio = modelo padrão (DEFAULT_PRIVACY)
};
const DEFAULT_TERMS = `MODELO PARA REVISÃO: substitua pelo texto aprovado pela mentora e revisado por um advogado.

1. O que é o serviço
Este aplicativo é uma ferramenta de apoio ao raciocínio clínico em oncologia veterinária, baseada no material e no método da mentora. Ele não emite laudos, não substitui o julgamento do médico-veterinário e não deve ser usado como única base para decisões clínicas.

2. Responsabilidade clínica
Doses, protocolos e interpretações de exames são referências de apoio e devem sempre ser conferidos com a fonte original e com o profissional responsável pelo caso. A decisão clínica é sempre do médico-veterinário.

3. Conta e uso
Você é responsável pelas informações e pela senha da sua conta. A conta é pessoal e não deve ser compartilhada. Podemos limitar ou suspender contas usadas de forma abusiva.

4. Planos e limites
Cada plano tem limites mensais de uso, informados no aplicativo. Os limites podem ser alterados, com aviso prévio razoável.

5. Conteúdo e propriedade intelectual
O conteúdo do aplicativo e do material da mentora é protegido por direitos autorais. É proibido copiar, redistribuir ou usar o conteúdo para treinar outros sistemas.

6. Dados de pacientes e tutores
Não envie dados pessoais de tutores (nome, telefone, endereço, documentos) em perguntas ou exames. Remova essas informações antes de anexar.

7. Alterações e contato
Estes termos podem ser atualizados. Dúvidas: use o contato informado no aplicativo.`;
const DEFAULT_PRIVACY = `MODELO PARA REVISÃO: substitua pelo texto aprovado pela mentora e revisado por um advogado (LGPD).

1. Dados que coletamos
Nome, e-mail, senha (armazenada de forma criptografada), plano, suas perguntas, as respostas geradas e os exames ou arquivos que você anexar, além de dados de uso (datas de acesso e quantidade de perguntas).

2. Para que usamos
Para criar e manter sua conta, responder às suas perguntas, controlar os limites do plano, melhorar o material de ensino com dados agregados e garantir a segurança do serviço.

3. Com quem compartilhamos
Usamos prestadores para operar o serviço: hospedagem, banco de dados, envio de e-mails e o provedor de inteligência artificial que processa suas perguntas e anexos. Eles tratam os dados apenas para prestar o serviço.

4. Por quanto tempo guardamos
Enquanto sua conta existir. Contas não confirmadas por e-mail são apagadas depois de alguns dias. Ao excluir a conta, apagamos seus dados e conversas.

5. Seus direitos (LGPD)
Você pode pedir acesso, correção ou exclusão dos seus dados. A exclusão da conta pode ser feita dentro do aplicativo, ou pelo contato informado.

6. Segurança
Adotamos medidas técnicas para proteger seus dados, mas nenhum sistema é totalmente imune a falhas.

7. Contato
Use o contato informado no aplicativo para falar sobre privacidade.`;
const PLAN_KEYS = ['gratis', 'assinante', 'mentoria'];
const DEFAULT_PLANS = {
  gratis:    { label: 'Grátis',    questions: 10,   exams: 0,    historyDays: 7, chunks: 2, whatsapp: false },
  assinante: { label: 'Assinante', questions: 150,  exams: 20,   historyDays: 0, chunks: 0, whatsapp: true },
  mentoria:  { label: 'Mentoria',  questions: 1000, exams: 1000, historyDays: 0, chunks: 0, whatsapp: true }
};
const clampInt = (v, min, max, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
function sanitizePlans(raw) {
  let p = {};
  try { p = typeof raw === 'string' && raw ? JSON.parse(raw) : (raw || {}); } catch (e) {}
  const out = {};
  for (const k of PLAN_KEYS) {
    const d = DEFAULT_PLANS[k], x = (p && p[k]) || {};
    out[k] = {
      label: String(x.label || d.label).trim().slice(0, 30) || d.label,
      questions: clampInt(x.questions, 0, 100000, d.questions),
      exams: clampInt(x.exams, 0, 100000, d.exams),
      historyDays: clampInt(x.historyDays, 0, 3650, d.historyDays),
      chunks: clampInt(x.chunks, 0, 10, d.chunks),
      whatsapp: x.whatsapp === undefined ? d.whatsapp : (x.whatsapp === true || x.whatsapp === 'true')
    };
  }
  return out;
}
const cleanNum = (v, dflt, max) => { const n = parseFloat(String(v).replace(',', '.')); return Number.isFinite(n) && n >= 0 ? String(Math.min(n, max)) : dflt; };
const HEX = /^#[0-9a-fA-F]{6}$/;
const OPTIONS = { fontHeading: ['serif', 'sans'], radius: ['reto', 'suave', 'redondo'], showEntryCards: ['sim', 'nao'] };
function sanitizeQuickLinks(raw) {
  let arr = [];
  try { arr = JSON.parse(raw); } catch (e) {}
  if (!Array.isArray(arr)) arr = [];
  return JSON.stringify(arr.slice(0, 6).map(l => ({ label: String(l.label || '').trim().slice(0, 40), url: String(l.url || '').trim().slice(0, 300) }))
    .filter(l => l.label && /^https?:\/\//i.test(l.url)));
}
let _settingsCache = null, _settingsAt = 0;

async function getSettings() {
  if (_settingsCache && Date.now() - _settingsAt < 60 * 1000) return _settingsCache;
  let saved = {};
  try {
    if (useDb) {
      const { rows } = await pool.query('SELECT key, value FROM app_settings');
      rows.forEach(r => { saved[r.key] = r.value; });
    } else if (fs.existsSync(SETTINGS_PATH)) {
      saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (e) { console.error('Falha ao ler configurações:', e.message); }
  const merged = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof saved[k] === 'string' && saved[k].trim()) merged[k] = saved[k].trim();
  }
  if (!SEARCH_MODES.includes(merged.searchMode)) merged.searchMode = DEFAULT_SETTINGS.searchMode;
  for (const k of ['primaryColor', 'accentColor']) if (!HEX.test(merged[k])) merged[k] = DEFAULT_SETTINGS[k];
  for (const [k, list] of Object.entries(OPTIONS)) if (!list.includes(merged[k])) merged[k] = DEFAULT_SETTINGS[k];
  merged.quickLinks = sanitizeQuickLinks(merged.quickLinks);
  merged.plans = JSON.stringify(sanitizePlans(merged.plans));
  merged.freeExamsOnce = String(clampInt(merged.freeExamsOnce, 0, 100, 5));
  if (!/^https?:\/\//i.test(merged.upgradeUrl)) merged.upgradeUrl = '';
  merged.priceInputPerM = cleanNum(merged.priceInputPerM, '3', 1000);
  merged.priceOutputPerM = cleanNum(merged.priceOutputPerM, '15', 1000);
  merged.priceSearchPer1k = cleanNum(merged.priceSearchPer1k, '10', 1000);
  merged.usdBrl = cleanNum(merged.usdBrl, '5.5', 100);
  if (!['sim', 'nao'].includes(merged.signupOpen)) merged.signupOpen = 'nao';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(merged.supportEmail)) merged.supportEmail = '';
  if (!merged.termsText) merged.termsText = DEFAULT_TERMS;
  if (!merged.privacyText) merged.privacyText = DEFAULT_PRIVACY;
  _settingsCache = merged; _settingsAt = Date.now();
  return merged;
}

async function saveSettings(input) {
  const clean = {};
  const limits = { appName: 60, tagline: 160, mentorName: 80, mentorTitle: 100, voice: 1500, searchMode: 20,
    primaryColor: 7, accentColor: 7, fontHeading: 10, radius: 10, showEntryCards: 3, quickLinks: 2500,
    plans: 4000, freeExamsOnce: 4, upgradeUrl: 300, signupOpen: 3, supportEmail: 160, termsText: 20000, privacyText: 20000, priceInputPerM: 10, priceOutputPerM: 10, priceSearchPer1k: 10, usdBrl: 10 };
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof input[k] === 'string') clean[k] = input[k].trim().slice(0, limits[k]);
  }
  if (clean.searchMode && !SEARCH_MODES.includes(clean.searchMode)) delete clean.searchMode;
  for (const k of ['primaryColor', 'accentColor']) if (clean[k] !== undefined && !HEX.test(clean[k])) delete clean[k];
  for (const [k, list] of Object.entries(OPTIONS)) if (clean[k] !== undefined && !list.includes(clean[k])) delete clean[k];
  if (clean.quickLinks !== undefined) clean.quickLinks = sanitizeQuickLinks(input.quickLinks);
  if (input.plans !== undefined) clean.plans = JSON.stringify(sanitizePlans(input.plans));
  if (clean.signupOpen !== undefined && !['sim', 'nao'].includes(clean.signupOpen)) delete clean.signupOpen;
  if (clean.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.supportEmail)) delete clean.supportEmail;
  if (clean.freeExamsOnce !== undefined) clean.freeExamsOnce = String(clampInt(clean.freeExamsOnce, 0, 100, 5));
  if (clean.upgradeUrl !== undefined && clean.upgradeUrl && !/^https?:\/\//i.test(clean.upgradeUrl)) delete clean.upgradeUrl;
  for (const [k, d, m] of [['priceInputPerM', '3', 1000], ['priceOutputPerM', '15', 1000], ['priceSearchPer1k', '10', 1000], ['usdBrl', '5.5', 100]]) {
    if (clean[k] !== undefined) clean[k] = cleanNum(clean[k], d, m);
  }
  if (useDb) {
    for (const [k, v] of Object.entries(clean)) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1,$2)
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, v]);
    }
  } else {
    let saved = {};
    try { if (fs.existsSync(SETTINGS_PATH)) saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (e) {}
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({ ...saved, ...clean }, null, 2));
  }
  _settingsCache = null; _brandingCache = null;
  return getSettings();
}

// ---------- Imagens (logo, foto, banners) e banners ----------
const ASSETS_PATH = path.join(__dirname, 'assets.json');
const BANNERS_PATH = path.join(__dirname, 'banners.json');
const ASSET_KEYS = ['logo', 'logoLight', 'photo'];
const ASSET_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const ASSET_MAX_BYTES = 1.5 * 1024 * 1024;
const readJson = (p, fallback) => { try { return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : fallback; } catch (e) { return fallback; } };

function parseDataUrl(dataUrl) {
  const m = /^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+\/=]+)$/i.exec(String(dataUrl || ''));
  if (!m || !ASSET_MIMES.includes(m[1].toLowerCase())) return null;
  const bytes = Math.floor(m[2].length * 3 / 4);
  if (bytes > ASSET_MAX_BYTES) return null;
  return { mime: m[1].toLowerCase(), data: m[2] };
}
function validAssetKey(key) { return ASSET_KEYS.includes(key) || /^banner-[a-z0-9]{6,20}$/.test(key); }

async function setAsset(key, mime, data) {
  if (useDb) {
    await pool.query(`INSERT INTO app_assets (key, mime, data) VALUES ($1,$2,$3)
      ON CONFLICT (key) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, [key, mime, data]);
  } else {
    const all = readJson(ASSETS_PATH, {});
    all[key] = { mime, data, updated: Date.now() };
    fs.writeFileSync(ASSETS_PATH, JSON.stringify(all));
  }
  _brandingCache = null;
}
async function getAsset(key) {
  if (useDb) {
    const { rows } = await pool.query('SELECT mime, data FROM app_assets WHERE key=$1', [key]);
    return rows[0] || null;
  }
  return readJson(ASSETS_PATH, {})[key] || null;
}
async function deleteAsset(key) {
  if (useDb) await pool.query('DELETE FROM app_assets WHERE key=$1', [key]);
  else { const all = readJson(ASSETS_PATH, {}); delete all[key]; fs.writeFileSync(ASSETS_PATH, JSON.stringify(all)); }
  _brandingCache = null;
}
// Mapa chave -> versão (timestamp), sem trazer os bytes das imagens.
async function assetVersions() {
  if (useDb) {
    const { rows } = await pool.query('SELECT key, (extract(epoch from updated_at)*1000)::bigint AS v FROM app_assets');
    return Object.fromEntries(rows.map(r => [r.key, Number(r.v)]));
  }
  const all = readJson(ASSETS_PATH, {});
  return Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.updated || 1]));
}

async function listBanners() {
  if (useDb) {
    const { rows } = await pool.query('SELECT id, title, body, link_url, link_label, active, position FROM app_banners ORDER BY position, created_at');
    return rows;
  }
  return readJson(BANNERS_PATH, []);
}
async function saveBanner(b) {
  const clean = {
    id: b.id && /^banner-[a-z0-9]{6,20}$/.test(b.id) ? b.id : 'banner-' + crypto.randomBytes(5).toString('hex'),
    title: String(b.title || '').trim().slice(0, 120),
    body: String(b.body || '').trim().slice(0, 400),
    link_url: /^https?:\/\//i.test(String(b.link_url || '').trim()) ? String(b.link_url).trim().slice(0, 300) : '',
    link_label: String(b.link_label || '').trim().slice(0, 40),
    active: b.active !== false,
    position: Number.isFinite(+b.position) ? +b.position : 0
  };
  if (useDb) {
    await pool.query(`INSERT INTO app_banners (id,title,body,link_url,link_label,active,position) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, link_url=EXCLUDED.link_url,
      link_label=EXCLUDED.link_label, active=EXCLUDED.active, position=EXCLUDED.position`,
      [clean.id, clean.title, clean.body, clean.link_url, clean.link_label, clean.active, clean.position]);
  } else {
    const all = readJson(BANNERS_PATH, []).filter(x => x.id !== clean.id);
    all.push(clean); fs.writeFileSync(BANNERS_PATH, JSON.stringify(all));
  }
  _brandingCache = null;
  return clean;
}
async function deleteBanner(id) {
  if (useDb) await pool.query('DELETE FROM app_banners WHERE id=$1', [id]);
  else fs.writeFileSync(BANNERS_PATH, JSON.stringify(readJson(BANNERS_PATH, []).filter(x => x.id !== id)));
  await deleteAsset(id);
}

let _brandingCache = null, _brandingAt = 0;
async function getBranding() {
  if (_brandingCache && Date.now() - _brandingAt < 60 * 1000) return _brandingCache;
  const [c, versions, banners] = await Promise.all([getSettings(), assetVersions(), listBanners()]);
  const img = k => (versions[k] ? `/brand/${k}?v=${versions[k]}` : null);
  _brandingCache = {
    appName: c.appName, tagline: c.tagline, mentorName: c.mentorName, mentorTitle: c.mentorTitle,
    primaryColor: c.primaryColor, accentColor: c.accentColor, fontHeading: c.fontHeading, radius: c.radius,
    showEntryCards: c.showEntryCards === 'sim',
    signupOpen: c.signupOpen === 'sim' && mailConfigured() && useDb, supportEmail: c.supportEmail,
    quickLinks: JSON.parse(c.quickLinks),
    logo: img('logo'), logoLight: img('logoLight'), photo: img('photo'),
    banners: banners.filter(b => b.active !== false).map(b => ({
      id: b.id, title: b.title, body: b.body, linkUrl: b.link_url, linkLabel: b.link_label, image: img(b.id)
    }))
  };
  _brandingAt = Date.now();
  return _brandingCache;
}

// ---------- Planos, cotas e custo ----------
// Mês de cobrança = mês-calendário no horário de Brasília (UTC-3). A cota renova no dia 1º.
function monthWindow(now = Date.now()) {
  const bt = new Date(now - 3 * 3600000);
  const y = bt.getUTCFullYear(), m = bt.getUTCMonth();
  return { start: new Date(Date.UTC(y, m, 1) + 3 * 3600000), end: new Date(Date.UTC(y, m + 1, 1) + 3 * 3600000) };
}
function fmtDateBR(d) {
  const bt = new Date(new Date(d).getTime() - 3 * 3600000);
  return String(bt.getUTCDate()).padStart(2, '0') + '/' + String(bt.getUTCMonth() + 1).padStart(2, '0');
}

async function getUsageInfo(studentId) {
  if (!useDb || !studentId) return null;
  const cfg = await getSettings();
  const plans = JSON.parse(cfg.plans);
  const { rows } = await pool.query('SELECT plan, COALESCE(free_exams_used,0) AS fe FROM students WHERE id=$1', [studentId]);
  if (!rows[0]) return null;
  const plan = PLAN_KEYS.includes(rows[0].plan) ? rows[0].plan : 'mentoria';
  const limits = plans[plan];
  const w = monthWindow();
  const u = await pool.query(
    `SELECT kind, COUNT(*)::int AS c FROM usage_events WHERE student_id=$1 AND created_at >= $2 AND created_at < $3 GROUP BY kind`,
    [studentId, w.start, w.end]);
  const used = { questions: 0, exams: 0 };
  u.rows.forEach(r => { if (r.kind === 'question') used.questions = r.c; if (r.kind === 'exam') used.exams = r.c; });
  const freeTotal = plan === 'gratis' ? parseInt(cfg.freeExamsOnce, 10) : 0;
  return {
    plan, planLabel: limits.label, limits, used,
    freeExamsLeft: Math.max(0, freeTotal - rows[0].fe), freeExamsTotal: freeTotal,
    resetAt: w.end.toISOString(), upgradeUrl: cfg.upgradeUrl
  };
}

// Resumo seguro para o app do aluno (sem dados internos).
function usageSummary(info) {
  if (!info) return null;
  return {
    plan: info.plan, planLabel: info.planLabel,
    questions: { used: info.used.questions, limit: info.limits.questions },
    exams: { used: info.used.exams, limit: info.limits.exams },
    freeExams: info.freeExamsTotal ? { left: info.freeExamsLeft, total: info.freeExamsTotal } : null,
    resetAt: info.resetAt, upgradeUrl: info.upgradeUrl, whatsapp: info.limits.whatsapp
  };
}

// Decide se a pergunta pode seguir. Sem banco de dados não há cotas (tudo liberado).
async function checkQuota(studentId, isExam) {
  const info = await getUsageInfo(studentId);
  if (!info) return { ok: true, info: null };
  const renew = fmtDateBR(info.resetAt);
  const base = { info, upgradeUrl: info.upgradeUrl, resetAt: info.resetAt, plan: info.plan, planLabel: info.planLabel };
  if (isExam) {
    if (info.used.exams < info.limits.exams) return { ok: true, info, useFreeHook: false };
    if (info.plan === 'gratis' && info.freeExamsLeft > 0) return { ok: true, info, useFreeHook: true };
    const exhaustedHook = info.plan === 'gratis' && info.freeExamsTotal > 0;
    const message = info.limits.exams === 0
      ? (exhaustedHook
          ? `Você usou seus ${info.freeExamsTotal} exames grátis. A interpretação de exames faz parte do plano Assinante.`
          : 'A interpretação de exames faz parte do plano Assinante.')
      : `Você usou as ${info.limits.exams} interpretações de exame do mês. Sua cota renova em ${renew}.`;
    return { ok: false, kind: 'exams', message, ...base };
  }
  if (info.used.questions >= info.limits.questions) {
    return { ok: false, kind: 'questions',
      message: `Você usou as ${info.limits.questions} perguntas do mês no plano ${info.planLabel}. Sua cota renova em ${renew}.`, ...base };
  }
  return { ok: true, info };
}

function computeCost(usage, cfg) {
  const u = usage || {};
  const inTok = u.input || 0, outTok = u.output || 0, searches = u.searches || 0;
  const usd = inTok * parseFloat(cfg.priceInputPerM) / 1e6 + outTok * parseFloat(cfg.priceOutputPerM) / 1e6 + searches * parseFloat(cfg.priceSearchPer1k) / 1000;
  return { inTok, outTok, searches, usd };
}

async function recordUsage(studentId, { isExam, useFreeHook, channel, tier, usage }) {
  if (!useDb || !studentId) return;
  try {
    const cfg = await getSettings();
    const c = computeCost(usage, cfg);
    const kind = isExam ? (useFreeHook ? 'exam_free' : 'exam') : 'question';
    await pool.query(
      `INSERT INTO usage_events (student_id, kind, channel, tier, input_tokens, output_tokens, searches, cost_usd)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [studentId, kind, channel || 'web', tier || null, c.inTok, c.outTok, c.searches, c.usd.toFixed(6)]);
    if (useFreeHook) await pool.query('UPDATE students SET free_exams_used = COALESCE(free_exams_used,0) + 1 WHERE id=$1', [studentId]);
  } catch (e) { console.error('Falha ao registrar uso:', e.message); }
}

function quotaPayload(q) {
  return { error: 'quota', kind: q.kind, message: q.message, plan: q.plan, planLabel: q.planLabel, resetAt: q.resetAt, upgradeUrl: q.upgradeUrl || '' };
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
function buildSystemPrompt(cfg) {
  const mentor = cfg.mentorName;
  const modeRule = {
    acervo: `2) Responda SOMENTE com base no CONTEXTO do acervo (o material de ${mentor}). Você NÃO tem busca na internet. ` +
      `Se o contexto não cobrir a pergunta, não invente: diga com clareza que esse ponto ainda não está no material de ${mentor}, ` +
      `ofereça no máximo uma orientação geral breve e prudente, marcada como "orientação geral, fora do material", e sugira levar o caso à mentoria.`,
    acervo_web: `2) Priorize o CONTEXTO do acervo (o material de ${mentor}). Só se ele for claramente insuficiente, complemente com ` +
      `conhecimento geral e, se for realmente necessário (dado atual ou muito específico), com NO MÁXIMO uma ou duas buscas na internet. ` +
      `Deixe explícito qual parte vem do material de ${mentor} e qual é complemento externo.`,
    aberto: `2) Se o CONTEXTO do acervo for insuficiente, responda com conhecimento geral de medicina veterinária e, se precisar de algo ` +
      `atual ou específico, use a busca na internet — deixando claro que essa parte não vem do material oficial do curso.`
  }[cfg.searchMode];
  const tagRule = cfg.searchMode === 'acervo'
    ? `[[FONTE:ACERVO]] se a resposta se baseou no acervo, ou [[FONTE:SEM_COBERTURA]] se o acervo não cobria a pergunta`
    : `[[FONTE:ACERVO]] se a resposta se baseou principalmente no acervo, [[FONTE:GERAL]] se baseou-se em conhecimento geral e/ou internet, ` +
      `ou [[FONTE:SEM_COBERTURA]] se o acervo não cobria a pergunta e a resposta é só uma orientação geral breve`;
  return `Você é o ${cfg.appName}, o assistente de raciocínio clínico que carrega o método de ${mentor}${cfg.mentorTitle ? ' (' + cfg.mentorTitle + ')' : ''} em oncologia veterinária.
Você NÃO é um chatbot genérico: fale em nome do método dela, em primeira pessoa do plural quando fizer sentido ("no nosso método…"), sem fingir ser a própria ${mentor}.
Você está em uma CONVERSA CONTÍNUA — use o histórico normalmente para perguntas de acompanhamento.

VOZ E ESTILO (definidos pela mentora):
${cfg.voice}
Evite o tom de assistente genérico: nada de "Claro!", "Ótima pergunta!", listas de tópicos soltos sem raciocínio ou avisos repetitivos.

Cada pergunta pode vir com CONTEXTO do acervo oficial, e/ou imagens e textos de exames anexados.

Regras obrigatórias:
1) Se o CONTEXTO do acervo for suficiente, baseie-se nele e cite a fonte entre parênteses, ex: (Fonte: Aula 3 — Linfoma).
${modeRule}
3) Se houver imagem(ns) ou texto(s) de exame, interprete-os como apoio ao raciocínio clínico, deixando claro que não é laudo definitivo e que o caso deve ser revisado com ${mentor}. Se não permitirem leitura clara, diga isso e peça os dados que faltam, em vez de supor.
4) ${ESTILO_RESPOSTA}
5) Sempre que mencionar dose de medicamento, inclua: "⚠ Confirme esta dose com ${mentor} antes de qualquer uso clínico."
6) Sempre conclua o raciocínio por completo — nunca interrompa a resposta no meio.
7) Ao FINAL, em linha própria e por último, escreva EXATAMENTE uma tag (nada mais na linha): ${tagRule}. É só controle interno; o aluno não vê.`;
}

async function callClaude({ system, messages, tools, maxTokens, onUsage }) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens || 2000,
    system,
    messages
  };
  if (tools) body.tools = tools;
  const response = await fetch(process.env.ANTHROPIC_API_URL || 'https://api.anthropic.com/v1/messages', {
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
  if (onUsage && data.usage) {
    onUsage({ input: data.usage.input_tokens || 0, output: data.usage.output_tokens || 0,
      searches: (data.usage.server_tool_use && data.usage.server_tool_use.web_search_requests) || 0 });
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

  const cfg = await getSettings();
  const tools = cfg.searchMode === 'acervo' ? undefined
    : [{ type: 'web_search_20250305', name: 'web_search', max_uses: cfg.searchMode === 'acervo_web' ? 2 : 5 }];
  let usage = null;
  const raw = await callClaude({
    system: buildSystemPrompt(cfg),
    messages,
    tools,
    maxTokens: 2000,
    onUsage: u => { usage = u; }
  });

  if (raw === null) {
    return { answer: 'Desculpe, tive um problema para consultar o acervo agora. Tente novamente em instantes.', tier: 'erro' };
  }

  const tagMatch = raw.match(/\[\[FONTE:(ACERVO|GERAL|SEM_COBERTURA)\]\]\s*$/i);
  let tier = 'fallback';
  let answer = raw;
  if (tagMatch) {
    const t = tagMatch[1].toUpperCase();
    tier = t === 'ACERVO' ? 'acervo' : t === 'SEM_COBERTURA' ? 'sem_cobertura' : 'fallback';
    answer = raw.slice(0, tagMatch.index).trim();
  }
  return { answer, tier, usage };
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

    // Cota do plano: confere antes de gastar com a IA.
    const isExam = safeImages.length > 0 || safeExamTexts.length > 0;
    const quota = await checkQuota(req.student.studentId, isExam);
    if (!quota.ok) return res.status(429).json(quotaPayload(quota));
    const planChunks = quota.info && quota.info.limits.chunks ? quota.info.limits.chunks : 5;

    const docs = await loadDocs();
    const topChunks = await retrieveContext(finalQuestion, docs, planChunks);
    const contextBlock = topChunks.map(c => `[Fonte: ${c.source}]\n${c.text}`).join('\n\n---\n\n');
    const sources = [...new Set(topChunks.map(c => c.source))];
    const sourceDocIds = [...new Set(topChunks.map(c => c.docId))];

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
      await appendMessage(conversationId, 'assistant', result.answer, {
        tier: result.tier,
        sourceDocIds: result.tier === 'acervo' ? sourceDocIds : []
      });
      await maybeSetConversationTitle(conversationId, question);
    } else {
      // Retaguarda sem banco (ou sem conversationId): memória de sessão simples, como antes.
      result = await askClaude(req.student, finalQuestion, contextBlock, { images: safeImages, examTexts: safeExamTexts });
    }

    if (result.tier !== 'erro') {
      await recordUsage(req.student.studentId, { isExam, useFreeHook: quota.useFreeHook, channel: 'web', tier: result.tier, usage: result.usage });
    }
    const usage = usageSummary(await getUsageInfo(req.student.studentId));
    res.json({ answer: result.answer, sources: result.tier === 'acervo' ? sources : [], tier: result.tier, usage });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro interno' });
  }
});

// ---------- Conversas salvas do aluno (histórico persistente, como no Claude) ----------

app.get('/api/conversations', requireStudentApi, async (req, res) => {
  let days = 0;
  try { const info = await getUsageInfo(req.student.studentId); days = info ? info.limits.historyDays : 0; } catch (e) {}
  res.json(await listConversations(req.student.studentId, days));
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

app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  res.json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS, modes: SEARCH_MODES, mail: { configured: mailConfigured(), from: MAIL_FROM || '', provider: mailProvider() } });
});
app.post('/api/admin/settings', requireAdmin, async (req, res) => {
  try { res.json({ ok: true, settings: await saveSettings(req.body || {}) }); }
  catch (e) { console.error(e); res.status(500).json({ error: 'Não foi possível salvar.' }); }
});

app.post('/api/admin/assets/:key', requireAdmin, async (req, res) => {
  const key = req.params.key;
  if (!validAssetKey(key)) return res.status(400).json({ error: 'Chave inválida.' });
  const parsed = parseDataUrl(req.body && req.body.dataUrl);
  if (!parsed) return res.status(400).json({ error: 'Imagem inválida ou maior que 1,5 MB (use PNG, JPG, WebP ou SVG).' });
  await setAsset(key, parsed.mime, parsed.data);
  res.json({ ok: true });
});
app.delete('/api/admin/assets/:key', requireAdmin, async (req, res) => {
  if (!validAssetKey(req.params.key)) return res.status(400).json({ error: 'Chave inválida.' });
  await deleteAsset(req.params.key);
  res.json({ ok: true });
});
app.get('/api/admin/banners', requireAdmin, async (req, res) => {
  const versions = await assetVersions();
  res.json((await listBanners()).map(b => ({ ...b, image: versions[b.id] ? `/brand/${b.id}?v=${versions[b.id]}` : null })));
});
app.post('/api/admin/banners', requireAdmin, async (req, res) => {
  res.json({ ok: true, banner: await saveBanner(req.body || {}) });
});
app.delete('/api/admin/banners/:id', requireAdmin, async (req, res) => {
  if (!/^banner-[a-z0-9]{6,20}$/.test(req.params.id)) return res.status(400).json({ error: 'id inválido' });
  await deleteBanner(req.params.id);
  res.json({ ok: true });
});

// Visão geral: números-chave e pendências que pedem uma ação da mentora.
app.get('/api/admin/overview', requireAdmin, async (req, res) => {
  try {
    const students = await loadStudents();
    const docs = await loadDocs();
    const out = {
      dbEnabled: useDb,
      students: { total: students.length, pendingInvite: students.filter(s => !s.passwordSet).length, active7d: 0, neverLoggedIn: 0 },
      docs: { total: docs.length, uncatalogued: 0 },
      questions: { last7d: 0, last30d: 0, uncovered: 0, acervoShare: null }
    };
    if (useDb) {
      const week = Date.now() - 7 * 86400000;
      out.students.active7d = students.filter(s => s.lastLogin && new Date(s.lastLogin).getTime() >= week).length;
      out.students.neverLoggedIn = students.filter(s => s.passwordSet && !s.lastLogin).length;
      const cat = await getCatalogStatus();
      out.docs.uncatalogued = Math.max(0, cat.total - cat.catalogued);
      const [q, t, u] = await Promise.all([
        pool.query(`SELECT COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS d7,
                           COUNT(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS d30
                    FROM messages WHERE role='user'`),
        pool.query(`SELECT tier, COUNT(*)::int AS c FROM messages
                    WHERE role='assistant' AND tier IS NOT NULL AND created_at > now() - interval '30 days' GROUP BY tier`),
        pool.query(`SELECT COUNT(*)::int AS c FROM messages WHERE role='assistant' AND tier='sem_cobertura' AND created_at > now() - interval '30 days'`)
      ]);
      out.questions.last7d = q.rows[0].d7; out.questions.last30d = q.rows[0].d30;
      out.questions.uncovered = u.rows[0].c;
      const w = monthWindow();
      const cost = await pool.query('SELECT COALESCE(SUM(cost_usd),0)::float AS c FROM usage_events WHERE created_at >= $1 AND created_at < $2', [w.start, w.end]);
      out.costMonthUsd = cost.rows[0].c;
      const tm = Object.fromEntries(t.rows.map(r => [r.tier, r.c]));
      const tot = (tm.acervo || 0) + (tm.fallback || 0) + (tm.sem_cobertura || 0);
      out.questions.acervoShare = tot ? Math.round(100 * (tm.acervo || 0) / tot) : null;
    }
    res.json(out);
  } catch (e) { console.error(e); res.status(500).json({ error: 'overview' }); }
});

app.get('/api/admin/analytics', requireAdmin, async (req, res) => {
  res.json(await getAnalytics());
});

app.get('/api/admin/doses', requireAdmin, async (req, res) => {
  res.json(await loadDoses());
});
app.delete('/api/admin/doses/:id', requireAdmin, async (req, res) => {
  await deleteDoseEntry(req.params.id);
  res.json(await loadDoses());
});

// ---------- Área da mentora: convites e contas dos alunos ----------

function publicStudentFields(s) {
  return { id: s.id, name: s.name, email: s.email, phone: s.phone || '', passwordSet: s.passwordSet,
    lastLogin: s.lastLogin || null, loginCount: s.loginCount || 0, createdAt: s.createdAt || null,
    plan: s.plan || 'mentoria', freeExamsUsed: s.freeExamsUsed || 0,
    emailVerified: s.emailVerified !== false, source: s.source || 'convite' };
}

// Lista de alunos com o uso do mês (perguntas, exames e custo estimado).
async function studentsWithUsage() {
  const students = (await loadStudents()).map(publicStudentFields);
  if (!useDb) return students;
  const w = monthWindow();
  const { rows } = await pool.query(
    `SELECT student_id,
       COUNT(*) FILTER (WHERE kind='question')::int AS q,
       COUNT(*) FILTER (WHERE kind IN ('exam','exam_free'))::int AS e,
       COALESCE(SUM(cost_usd),0)::float AS cost
     FROM usage_events WHERE created_at >= $1 AND created_at < $2 GROUP BY student_id`, [w.start, w.end]);
  const map = Object.fromEntries(rows.map(r => [r.student_id, r]));
  return students.map(s => ({ ...s, monthQuestions: (map[s.id] || {}).q || 0, monthExams: (map[s.id] || {}).e || 0, monthCostUsd: (map[s.id] || {}).cost || 0 }));
}
app.get('/api/admin/students', requireAdmin, async (req, res) => {
  res.json(await studentsWithUsage());
});

// Trocar o plano de um aluno.
app.post('/api/admin/students/:id/plan', requireAdmin, async (req, res) => {
  const plan = req.body && req.body.plan;
  if (!PLAN_KEYS.includes(plan)) return res.status(400).json({ error: 'Plano inválido.' });
  if (useDb) await pool.query('UPDATE students SET plan=$1 WHERE id=$2', [plan, req.params.id]);
  res.json(await studentsWithUsage());
});

// Relatório do mês: custo estimado total, por plano e por aluno.
app.get('/api/admin/billing', requireAdmin, async (req, res) => {
  try {
    const cfg = await getSettings();
    const usdBrl = parseFloat(cfg.usdBrl);
    if (!useDb) return res.json({ dbEnabled: false });
    const w = monthWindow();
    const [tot, byPlan, top, byChannel] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE kind='question')::int AS q, COUNT(*) FILTER (WHERE kind IN ('exam','exam_free'))::int AS e,
                  COALESCE(SUM(cost_usd),0)::float AS cost,
                  COALESCE(AVG(cost_usd) FILTER (WHERE kind='question'),0)::float AS avg_q,
                  COALESCE(AVG(cost_usd) FILTER (WHERE kind IN ('exam','exam_free')),0)::float AS avg_e
                  FROM usage_events WHERE created_at >= $1 AND created_at < $2`, [w.start, w.end]),
      pool.query(`SELECT COALESCE(s.plan,'mentoria') AS plan, COUNT(DISTINCT s.id)::int AS users,
                  COUNT(u.id) FILTER (WHERE u.kind='question')::int AS q, COUNT(u.id) FILTER (WHERE u.kind IN ('exam','exam_free'))::int AS e,
                  COALESCE(SUM(u.cost_usd),0)::float AS cost
                  FROM students s LEFT JOIN usage_events u ON u.student_id=s.id AND u.created_at >= $1 AND u.created_at < $2
                  GROUP BY COALESCE(s.plan,'mentoria')`, [w.start, w.end]),
      pool.query(`SELECT s.name, s.email, COALESCE(s.plan,'mentoria') AS plan, COUNT(*)::int AS n, SUM(u.cost_usd)::float AS cost
                  FROM usage_events u JOIN students s ON s.id=u.student_id WHERE u.created_at >= $1 AND u.created_at < $2
                  GROUP BY s.id ORDER BY cost DESC LIMIT 10`, [w.start, w.end]),
      pool.query(`SELECT COALESCE(channel,'web') AS channel, COUNT(*)::int AS n, COALESCE(SUM(cost_usd),0)::float AS cost
                  FROM usage_events WHERE created_at >= $1 AND created_at < $2 GROUP BY COALESCE(channel,'web')`, [w.start, w.end])
    ]);
    const t = tot.rows[0];
    res.json({
      dbEnabled: true, usdBrl, monthStart: w.start, monthEnd: w.end,
      totals: { questions: t.q, exams: t.e, costUsd: t.cost, avgQuestionUsd: t.avg_q, avgExamUsd: t.avg_e },
      byPlan: byPlan.rows, topStudents: top.rows, byChannel: byChannel.rows
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'billing' }); }
});

app.post('/api/admin/students', requireAdmin, async (req, res) => {
  const { name, email, phone, plan } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'name e email são obrigatórios' });
  if (!email.includes('@')) return res.status(400).json({ error: 'E-mail inválido.' });
  try {
    await inviteStudent(name, email, phone);
    if (useDb && PLAN_KEYS.includes(plan)) await pool.query('UPDATE students SET plan=$1 WHERE email=$2', [plan, email.trim().toLowerCase()]);
    res.json(await studentsWithUsage());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/students/:id/phone', requireAdmin, async (req, res) => {
  const { phone } = req.body;
  const phoneNorm = phone ? normalizePhone(phone) : null;
  if (useDb) {
    await pool.query('UPDATE students SET phone=$1 WHERE id=$2', [phoneNorm, req.params.id]);
  } else {
    const students = loadStudentsFile();
    const student = students.find(s => s.id === req.params.id);
    if (student) { student.phone = phoneNorm; saveStudentsFile(students); }
  }
  res.json(await studentsWithUsage());
});

app.post('/api/admin/students/:id/reset', requireAdmin, async (req, res) => {
  try {
    await resetStudentPassword(req.params.id);
    res.json(await studentsWithUsage());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/admin/students/:id', requireAdmin, async (req, res) => {
  await deleteStudent(req.params.id);
  res.json(await studentsWithUsage());
});

// ---------- WhatsApp ----------

// Etapa que costuma faltar mesmo com o webhook verificado: inscrever o APP para
// receber eventos da conta específica do WhatsApp Business (WABA). Sem isso, mensagens
// reais não chegam, mesmo com a URL do webhook certinha. Acesse uma vez pelo navegador
// (pede a senha da mentora) para resolver.
app.get('/api/admin/whatsapp/subscribe', requireAdmin, async (req, res) => {
  const wabaId = process.env.WHATSAPP_BUSINESS_ACCOUNT_ID;
  if (!wabaId) {
    return res.status(400).json({ error: 'Defina a variável WHATSAPP_BUSINESS_ACCOUNT_ID no Render (é o "WhatsApp Business Account ID" que aparece no painel da Meta).' });
  }
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/subscribed_apps`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    });
    const data = await r.json();
    res.json({ ok: r.ok, resultadoDaMeta: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

async function sendWhatsAppMessage(to, body) {
  const res = await fetch(`https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WHATSAPP_TOKEN}` },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, text: { body } })
  });
  const data = await res.json();
  if (!res.ok) {
    console.error('[WEBHOOK] Erro ao ENVIAR mensagem pela API do WhatsApp:', JSON.stringify(data));
  } else {
    console.log('[WEBHOOK] Mensagem enviada com sucesso para', to);
  }
}

// Baixa uma mídia (foto/documento) enviada pelo aluno no WhatsApp. A API do WhatsApp
// funciona em duas etapas: primeiro pega a URL temporária do arquivo, depois baixa o
// conteúdo binário de fato — as duas etapas exigem o token de acesso.
async function downloadWhatsAppMedia(mediaId) {
  const metaRes = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
  });
  const meta = await metaRes.json();
  if (!meta.url) throw new Error('Não foi possível obter a URL da mídia do WhatsApp.');
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` } });
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: meta.mime_type || '' };
}

// Extrai texto de um PDF recebido pelo WhatsApp (server-side, sem depender do navegador).
async function extractPdfTextServerSide(buffer) {
  try {
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    return (data.text || '').trim();
  } catch (err) {
    console.error('Erro ao extrair texto do PDF (WhatsApp):', err.message);
    return '';
  }
}

// Adapta a formatação markdown (pensada para o app web) ao estilo simples do WhatsApp:
// **negrito** -> *negrito* (WhatsApp usa um asterisco só), remove cerquilhas de título, etc.
function toWhatsAppFormatting(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const whatsappSessions = new Map(); // telefone -> { history: [] }

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    console.log('[WEBHOOK] payload recebido:', JSON.stringify(req.body).slice(0, 1500));
    if (!message) { console.log('[WEBHOOK] nenhuma mensagem encontrada no payload (pode ser um evento de status, ex: "entregue").'); return; }
    console.log(`[WEBHOOK] mensagem de ${message.from}, tipo: ${message.type}`);

    const student = await getStudentByPhone(message.from);
    console.log('[WEBHOOK] aluno encontrado para esse telefone?', student ? `sim (${student.name})` : 'não');
    if (!student) {
      await sendWhatsAppMessage(message.from,
        'Este número não está cadastrado no programa de mentoria. Peça para a mentora liberar seu acesso e tente novamente.');
      return;
    }

    // Plano: o WhatsApp só está disponível nos planos que o incluem.
    const waInfo = await getUsageInfo(student.id);
    if (waInfo && !waInfo.limits.whatsapp) {
      await sendWhatsAppMessage(message.from, `O WhatsApp faz parte do plano Assinante ou Mentoria. Seu plano atual é ${waInfo.planLabel}.` + (waInfo.upgradeUrl ? ` Conheça: ${waInfo.upgradeUrl}` : ' Você continua podendo usar o app pela web.'));
      return;
    }

    let question = null;
    let images = [];
    let examTexts = [];

    if (message.type === 'text') {
      question = message.text.body;
    } else if (message.type === 'image') {
      const { buffer, mimeType } = await downloadWhatsAppMedia(message.image.id);
      images.push({ mediaType: mimeType || 'image/jpeg', data: buffer.toString('base64') });
      question = message.image.caption || 'Interprete a imagem do exame anexada.';
    } else if (message.type === 'document') {
      const { buffer, mimeType } = await downloadWhatsAppMedia(message.document.id);
      if (mimeType === 'application/pdf') {
        const text = await extractPdfTextServerSide(buffer);
        if (text.length < 30) {
          await sendWhatsAppMessage(message.from, 'Não consegui ler texto desse PDF (pode ser um documento escaneado). Tente enviar como foto (imagem) em vez de PDF.');
          return;
        }
        examTexts.push(text);
        question = message.document.caption || 'Interprete o exame anexado.';
      } else {
        await sendWhatsAppMessage(message.from, 'Por enquanto só consigo ler fotos e arquivos PDF de exame — esse formato de arquivo não é suportado.');
        return;
      }
    } else {
      return; // outros tipos (áudio, figurinha, etc.) são ignorados por ora
    }

    const waIsExam = images.length > 0 || examTexts.length > 0;
    const waQuota = await checkQuota(student.id, waIsExam);
    if (!waQuota.ok) {
      await sendWhatsAppMessage(message.from, waQuota.message + (waQuota.upgradeUrl ? ` Para continuar agora: ${waQuota.upgradeUrl}` : ''));
      return;
    }
    const docs = await loadDocs();
    const topChunks = await retrieveContext(question, docs, waQuota.info && waQuota.info.limits.chunks ? waQuota.info.limits.chunks : 5);
    const contextBlock = topChunks.map(c => `[Fonte: ${c.source}]\n${c.text}`).join('\n\n---\n\n');
    if (!whatsappSessions.has(message.from)) whatsappSessions.set(message.from, { history: [] });
    const waSession = whatsappSessions.get(message.from);
    const waResult = await askClaude(waSession, question, contextBlock, { images, examTexts });
    if (waResult.tier !== 'erro') {
      await recordUsage(student.id, { isExam: waIsExam, useFreeHook: waQuota.useFreeHook, channel: 'whatsapp', tier: waResult.tier, usage: waResult.usage });
    }
    await sendWhatsAppMessage(message.from, toWhatsAppFormatting(waResult.answer));
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
