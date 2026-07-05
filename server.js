// Console de Mentoria em Oncologia Veterinária — Servidor unificado
// -------------------------------------------------------------------
// Este único servidor cuida de três coisas:
// 1) Serve o app web (pasta /public) — o que os alunos acessam no navegador
// 2) Expõe uma API (/api/docs, /api/ask) usada pelo app web
// 3) Recebe e responde mensagens do WhatsApp (/webhook)
//
// Veja o README.md para o passo a passo de configuração e deploy.

const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ADMIN_USER = process.env.ADMIN_USER || 'mentora';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// Protege as rotas de administração (gerenciar o acervo) com usuário/senha simples.
// O navegador mostra uma caixinha de login nativa (Basic Auth).
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

const DOCS_PATH = path.join(__dirname, 'docs.json');

function loadDocs() {
  return JSON.parse(fs.readFileSync(DOCS_PATH, 'utf8'));
}
function saveDocs(docs) {
  fs.writeFileSync(DOCS_PATH, JSON.stringify(docs, null, 2));
}
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
    return { answer: 'Desculpe, tive um problema para consultar o acervo agora. Tente novamente em instantes.', sources: [] };
  }
  const textBlocks = (data.content || []).filter(b => b.type === 'text').map(b => b.text);
  return textBlocks.join('\n') || 'Não consegui gerar uma resposta agora.';
}

// ---------- API usada pelo app web ----------

app.get('/api/docs', (req, res) => {
  // Lista pública: só nome e id (sem o texto completo), usada na tela dos alunos.
  const docs = loadDocs().map(d => ({ id: d.id, name: d.name }));
  res.json(docs);
});

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

app.post('/api/ask', async (req, res) => {
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
