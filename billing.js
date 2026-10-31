// Integração com o Asaas: recebe avisos de pagamento (webhook), atualiza o plano
// do aluno e mantém a régua de cobrança (aviso de atraso, volta para o Grátis).
//
// Segredos ficam SOMENTE em variáveis de ambiente do Render:
//   ASAAS_WEBHOOK_TOKEN  token que o Asaas envia no cabeçalho "asaas-access-token"
//   ASAAS_API_KEY        chave da API (usada só para descobrir o e-mail do cliente)
//   ASAAS_ENV            "sandbox" (testes) ou "production" (padrão)
//   ASAAS_API_URL        opcional: sobrescreve o endereço da API
//
// Regra de ouro: só mexe em quem é "assinante" pago pelo Asaas. Mentoria e planos
// definidos à mão pela mentora nunca são alterados por aqui.
const crypto = require('crypto');

module.exports = function registerBilling(deps) {
  const { app, pool, useDb, requireAdmin, sendMail, mailConfigured, escHtml, getSettings, saveSettings, path, adminDir } = deps;

  const TOKEN = () => process.env.ASAAS_WEBHOOK_TOKEN || '';
  const API_KEY = () => process.env.ASAAS_API_KEY || '';
  const API_URL = () => (process.env.ASAAS_API_URL
    || (String(process.env.ASAAS_ENV || '').toLowerCase() === 'sandbox' ? 'https://api-sandbox.asaas.com/v3' : 'https://api.asaas.com/v3')).replace(/\/+$/, '');
  const envName = () => (String(process.env.ASAAS_ENV || '').toLowerCase() === 'sandbox' ? 'sandbox' : 'produção');

  const PAY_OK = ['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'];
  const PAY_REVOKE = ['PAYMENT_REFUNDED', 'PAYMENT_CHARGEBACK_REQUESTED'];
  const SUB_END = ['SUBSCRIPTION_INACTIVATED', 'SUBSCRIPTION_DELETED'];

  async function init() {
    if (!useDb) return;
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS plan_until TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS billing_status TEXT;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS asaas_customer_id TEXT;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS billing_overdue_since TIMESTAMPTZ;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS billing_warned_at TIMESTAMPTZ;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS billing_events (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        payload JSONB,
        email TEXT,
        customer_id TEXT,
        student_id TEXT,
        received_at TIMESTAMPTZ DEFAULT now(),
        processed BOOLEAN DEFAULT FALSE,
        result TEXT
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS billing_events_received_idx ON billing_events (received_at DESC);`);
  }

  // ---------- utilidades ----------
  function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }
  const day = 86400000;
  function parseDay(s) {
    if (!s || typeof s !== 'string') return null;
    const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00Z' : s);
    return isNaN(d) ? null : d;
  }
  function addPeriod(date, cycle) {
    const d = new Date(date.getTime());
    const months = { MONTHLY: 1, BIMONTHLY: 2, QUARTERLY: 3, SEMIANNUALLY: 6, YEARLY: 12 }[cycle];
    if (months) d.setUTCMonth(d.getUTCMonth() + months);
    else if (cycle === 'WEEKLY') d.setTime(d.getTime() + 7 * day);
    else if (cycle === 'BIWEEKLY') d.setTime(d.getTime() + 14 * day);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    return d;
  }
  async function rules() {
    const c = await getSettings();
    const n = (v, d, max) => { const x = parseInt(v, 10); return Number.isFinite(x) && x >= 0 && x <= max ? x : d; };
    return { warnDays: n(c.billingWarnDays, 3, 60), downgradeDays: n(c.billingDowngradeDays, 7, 90), graceDays: n(c.billingGraceDays, 2, 30), appName: c.appName, supportEmail: c.supportEmail, upgradeUrl: c.upgradeUrl };
  }

  async function asaasGet(pathname) {
    if (!API_KEY()) return { missingKey: true };
    const r = await fetch(API_URL() + pathname, {
      headers: { access_token: API_KEY(), 'User-Agent': 'Oncoway/1.0', accept: 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (r.status === 404) return { notFound: true };
    if (!r.ok) throw new Error(`Asaas respondeu ${r.status} em ${pathname}`);
    return { data: await r.json() };
  }

  const STUDENT_COLS = 'id, name, email, plan, plan_until, billing_status, billing_overdue_since, asaas_customer_id';
  async function studentByEmail(email) {
    const { rows } = await pool.query(`SELECT ${STUDENT_COLS} FROM students WHERE lower(email)=$1`, [String(email || '').trim().toLowerCase()]);
    return rows[0] || null;
  }

  // Descobre qual aluno é o cliente do Asaas: pelo vínculo já salvo, pelo e-mail informado
  // ou buscando o e-mail do cliente na API do Asaas.
  async function resolveStudent(customerId, overrideEmail) {
    if (overrideEmail) {
      const s = await studentByEmail(overrideEmail);
      return { student: s, email: String(overrideEmail).trim().toLowerCase(), reason: s ? null : 'nenhuma conta com esse e-mail' };
    }
    if (customerId) {
      const { rows } = await pool.query(`SELECT ${STUDENT_COLS} FROM students WHERE asaas_customer_id=$1`, [customerId]);
      if (rows[0]) return { student: rows[0], email: String(rows[0].email).toLowerCase() };
      const r = await asaasGet('/customers/' + encodeURIComponent(customerId));
      if (r.missingKey) return { student: null, email: null, reason: 'ASAAS_API_KEY não configurada (não dá para descobrir o e-mail do cliente)' };
      if (r.notFound || !r.data) return { student: null, email: null, reason: 'cliente não encontrado no Asaas' };
      const email = String(r.data.email || '').trim().toLowerCase();
      if (!email) return { student: null, email: null, reason: 'cliente sem e-mail no Asaas' };
      const s = await studentByEmail(email);
      return { student: s, email, reason: s ? null : 'nenhuma conta com o e-mail ' + email };
    }
    return { student: null, email: null, reason: 'evento sem cliente' };
  }

  async function sendBillingMail(to, subject, paragraphs, cta) {
    if (!mailConfigured()) return false;
    const r = await rules();
    const app_ = escHtml(r.appName);
    const body = paragraphs.map(p => `<p style="margin:0 0 12px;">${p}</p>`).join('');
    const btn = cta && cta.url ? `<p style="margin:18px 0;"><a href="${escHtml(cta.url)}" style="background:#3F5C50;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none;">${escHtml(cta.label)}</a></p>` : '';
    const html = `<div style="font-family:Arial,sans-serif;color:#1C2B33;max-width:520px;line-height:1.5;">${body}${btn}<p style="color:#667;font-size:12px;">${app_}${r.supportEmail ? ' · dúvidas: ' + escHtml(r.supportEmail) : ''}</p></div>`;
    const text = paragraphs.map(p => p.replace(/<[^>]+>/g, '')).join('\n\n') + (cta && cta.url ? `\n\n${cta.label}: ${cta.url}` : '');
    try { await sendMail({ to, subject, html, text }); return true; } catch (e) { console.error('billing mail:', e.message); return false; }
  }

  // ---------- regras por evento ----------
  // Devolve um texto curto com o que aconteceu (vai para a tela Pagamentos).
  async function applyEvent(ev, student, extra) {
    const type = ev.event;
    const pay = ev.payment || {};
    const sub = ev.subscription || {};
    const R = await rules();

    if (student.plan === 'mentoria') return 'ignorado: aluno da mentoria (plano preservado)';

    if (PAY_OK.includes(type)) {
      let cycle = 'MONTHLY';
      if (pay.subscription) {
        try { const r = await asaasGet('/subscriptions/' + encodeURIComponent(pay.subscription)); if (r.data && r.data.cycle) cycle = r.data.cycle; } catch (e) { /* assume mensal */ }
      }
      const due = parseDay(pay.dueDate) || new Date();
      const paidAt = parseDay(pay.clientPaymentDate) || parseDay(pay.paymentDate) || new Date();
      const base = due > paidAt ? due : paidAt;
      const until = new Date(addPeriod(base, cycle).getTime() + R.graceDays * day);
      const { rows } = await pool.query(
        `UPDATE students SET plan='assinante', billing_status='active', plan_until=GREATEST(COALESCE(plan_until, $2), $2),
           billing_overdue_since=NULL, billing_warned_at=NULL, asaas_customer_id=COALESCE($3, asaas_customer_id)
         WHERE id=$1 RETURNING plan_until`, [student.id, until, extra.customerId || null]);
      if (student.plan !== 'assinante') {
        await sendBillingMail(student.email, `Assinatura confirmada — ${R.appName}`, [
          `Olá, ${escHtml(student.name || '')}! Recebemos seu pagamento e seu plano <b>Assinante</b> já está ativo.`,
          'Abra o aplicativo normalmente: os limites maiores e os recursos do plano já valem para você.'
        ]);
      }
      return `aplicado: plano Assinante até ${new Date(rows[0].plan_until).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
    }

    if (type === 'PAYMENT_OVERDUE') {
      if (student.plan !== 'assinante') return 'ignorado: aluno não é assinante';
      await pool.query(
        `UPDATE students SET billing_status='overdue', billing_overdue_since=COALESCE(billing_overdue_since, now()),
           asaas_customer_id=COALESCE($2, asaas_customer_id) WHERE id=$1 AND billing_status IS DISTINCT FROM 'canceled'`, [student.id, extra.customerId || null]);
      return 'aplicado: pagamento marcado como atrasado';
    }

    if (PAY_REVOKE.includes(type)) {
      if (student.plan !== 'assinante') return 'ignorado: aluno não é assinante';
      await pool.query(`UPDATE students SET plan='gratis', billing_status='refunded', plan_until=NULL, billing_overdue_since=NULL WHERE id=$1`, [student.id]);
      return 'aplicado: estorno/contestação — voltou para o Grátis';
    }

    if (SUB_END.includes(type)) {
      if (student.plan !== 'assinante') return 'ignorado: aluno não é assinante';
      await pool.query(`UPDATE students SET billing_status='canceled', billing_overdue_since=NULL WHERE id=$1`, [student.id]);
      return 'aplicado: assinatura cancelada — acesso mantido até o fim do período pago';
    }
    return 'ignorado: evento sem efeito no plano';
  }

  const RELEVANT = [...PAY_OK, 'PAYMENT_OVERDUE', ...PAY_REVOKE, ...SUB_END];

  // Processa uma linha de billing_events. Lança erro se algo temporário falhar (o Asaas tenta de novo).
  async function processRow(row, overrideEmail) {
    const ev = row.payload || {};
    if (!RELEVANT.includes(ev.event)) {
      await pool.query(`UPDATE billing_events SET processed=true, result=$2 WHERE id=$1`, [row.id, 'ignorado: evento sem efeito no plano']);
      return 'ignorado: evento sem efeito no plano';
    }
    const obj = ev.payment || ev.subscription || {};
    const customerId = obj.customer || null;
    const found = await resolveStudent(customerId, overrideEmail);
    let result, studentId = null;
    if (!found.student) {
      result = 'sem_conta: ' + (found.reason || 'aluno não encontrado');
      await pool.query(`UPDATE billing_events SET processed=true, result=$2, email=$3, customer_id=$4 WHERE id=$1`, [row.id, result, found.email || null, customerId]);
      return result;
    }
    studentId = found.student.id;
    result = await applyEvent(ev, found.student, { customerId });
    // vincula o cliente do Asaas a esta conta (também quando o evento não muda o plano)
    if (customerId) await pool.query(`UPDATE students SET asaas_customer_id=$2 WHERE id=$1 AND asaas_customer_id IS NULL`, [studentId, customerId]);
    await pool.query(`UPDATE billing_events SET processed=true, result=$2, email=$3, customer_id=$4, student_id=$5 WHERE id=$1`, [row.id, result, found.email, customerId, studentId]);
    return result;
  }

  // ---------- webhook ----------
  app.post('/webhook/asaas', async (req, res) => {
    if (!useDb) return res.status(503).json({ error: 'sem banco de dados' });
    if (!TOKEN()) return res.status(503).json({ error: 'webhook não configurado' });
    if (!safeEqual(req.get('asaas-access-token') || '', TOKEN())) return res.status(401).json({ error: 'token inválido' });
    const ev = req.body;
    if (!ev || typeof ev !== 'object' || typeof ev.event !== 'string') return res.status(400).json({ error: 'evento inválido' });
    const id = String(ev.id || crypto.createHash('sha256').update(JSON.stringify(ev)).digest('hex').slice(0, 40)).slice(0, 120);
    try {
      const ins = await pool.query(
        `INSERT INTO billing_events (id, event, payload) VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING RETURNING id`, [id, ev.event.slice(0, 80), JSON.stringify(ev)]);
      if (!ins.rows.length) {
        const old = await pool.query('SELECT processed FROM billing_events WHERE id=$1', [id]);
        if (old.rows[0] && old.rows[0].processed) return res.json({ ok: true, duplicate: true });
      }
      await processRow({ id, payload: ev });
      res.json({ ok: true });
    } catch (e) {
      console.error('webhook asaas:', e.message);
      try { await pool.query(`UPDATE billing_events SET processed=false, result=$2 WHERE id=$1`, [id, ('erro: ' + e.message).slice(0, 300)]); } catch (_) { /* segue */ }
      res.status(500).json({ error: 'falha ao processar; tente novamente' });
    }
  });

  // Aplica pagamentos recebidos antes de a pessoa ter conta (chamado após o cadastro).
  async function applyPendingFor(email) {
    if (!useDb || !email) return 0;
    const em = String(email).trim().toLowerCase();
    const { rows } = await pool.query(`SELECT id, payload FROM billing_events WHERE result LIKE 'sem_conta%' AND lower(email)=$1 ORDER BY received_at ASC`, [em]);
    let n = 0;
    for (const r of rows) { try { await processRow(r, em); n++; } catch (e) { console.error('applyPending:', e.message); } }
    return n;
  }

  // ---------- varredura (régua de cobrança) ----------
  let sweeping = false;
  async function sweep() {
    if (!useDb || sweeping) return { skipped: true };
    sweeping = true;
    try {
      const R = await rules();
      const out = { expiredToOverdue: 0, warned: 0, downgraded: 0, ended: 0 };
      // 1) período pago acabou e nenhum pagamento novo chegou: vira "atrasado"
      out.expiredToOverdue = (await pool.query(
        `UPDATE students SET billing_status='overdue', billing_overdue_since=COALESCE(billing_overdue_since, plan_until)
         WHERE plan='assinante' AND billing_status='active' AND plan_until IS NOT NULL AND plan_until < now()`)).rowCount;
      // 2) assinatura cancelada e período pago terminou: volta para o Grátis
      out.ended = (await pool.query(
        `UPDATE students SET plan='gratis', billing_status='ended', plan_until=NULL
         WHERE plan='assinante' AND billing_status='canceled' AND plan_until IS NOT NULL AND plan_until < now()`)).rowCount;
      // 3) atraso longo demais: volta para o Grátis
      out.downgraded = (await pool.query(
        `UPDATE students SET plan='gratis', billing_status='downgraded', plan_until=NULL
         WHERE plan='assinante' AND billing_status='overdue' AND billing_overdue_since IS NOT NULL
           AND billing_overdue_since <= now() - ($1 || ' days')::interval`, [String(R.downgradeDays)])).rowCount;
      // 4) aviso por e-mail (uma vez por atraso)
      const warn = await pool.query(
        `SELECT id, name, email FROM students WHERE plan='assinante' AND billing_status='overdue' AND billing_warned_at IS NULL
           AND billing_overdue_since IS NOT NULL AND billing_overdue_since <= now() - ($1 || ' days')::interval`, [String(R.warnDays)]);
      for (const s of warn.rows) {
        const left = Math.max(1, R.downgradeDays - R.warnDays);
        const ok = await sendBillingMail(s.email, `Pagamento pendente — ${R.appName}`, [
          `Olá, ${escHtml(s.name || '')}. Não identificamos o pagamento da sua assinatura do ${escHtml(R.appName)}.`,
          `Para não perder os recursos do plano Assinante, regularize em até ${left} dia(s). Depois disso, sua conta volta para o plano Grátis (seu histórico continua salvo).`,
          'Se você já pagou, pode ignorar este aviso: a confirmação do banco às vezes demora um pouco.'
        ], R.upgradeUrl ? { url: R.upgradeUrl, label: 'Regularizar pagamento' } : null);
        // sem e-mail configurado não marca como avisado, para tentar de novo quando configurar
        if (ok) { await pool.query('UPDATE students SET billing_warned_at=now() WHERE id=$1', [s.id]); out.warned++; }
      }
      return out;
    } finally { sweeping = false; }
  }
  setTimeout(() => { sweep().catch(e => console.error('sweep:', e.message)); }, 45000).unref();
  setInterval(() => { sweep().catch(e => console.error('sweep:', e.message)); }, 3600000).unref();

  // ---------- admin ----------
  app.get('/admin/pagamentos.js', requireAdmin, (req, res) => { res.set('Cache-Control', 'no-cache'); res.type('application/javascript').sendFile(path.join(adminDir, 'pagamentos.js')); });

  app.get('/api/admin/pagamentos', requireAdmin, async (req, res) => {
    try {
      const R = await rules();
      const cfg = await getSettings();
      const base = {
        integration: { db: useDb, webhookToken: Boolean(TOKEN()), apiKey: Boolean(API_KEY()), env: envName(), apiUrl: API_URL(), mail: mailConfigured(), upgradeUrl: cfg.upgradeUrl || '' },
        rules: { warnDays: R.warnDays, downgradeDays: R.downgradeDays, graceDays: R.graceDays }
      };
      if (!useDb) return res.json({ ...base, kpis: null, events: [], pending: [] });
      const cnt = await pool.query(`SELECT
          COUNT(*) FILTER (WHERE plan='assinante' AND billing_status='active')::int AS active,
          COUNT(*) FILTER (WHERE plan='assinante' AND billing_status='overdue')::int AS overdue,
          COUNT(*) FILTER (WHERE plan='assinante' AND billing_status='canceled')::int AS canceled,
          COUNT(*) FILTER (WHERE plan='assinante' AND billing_status IS NULL)::int AS manual
        FROM students`);
      const rev = await pool.query(
        `SELECT COALESCE(SUM(v),0)::float AS total FROM (
           SELECT DISTINCT ON (COALESCE(payload->'payment'->>'id', id)) CASE WHEN (payload->'payment'->>'value') ~ '^[0-9.]+$' THEN (payload->'payment'->>'value')::numeric ELSE 0 END AS v
           FROM billing_events
           WHERE event IN ('PAYMENT_CONFIRMED','PAYMENT_RECEIVED') AND received_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo'
           ORDER BY COALESCE(payload->'payment'->>'id', id), received_at) t`);
      const events = await pool.query(
        `SELECT id, event, email, result, processed, received_at AS "receivedAt", (payload->'payment'->>'value') AS value FROM billing_events ORDER BY received_at DESC LIMIT 40`);
      const pending = await pool.query(
        `SELECT id, event, email, result, received_at AS "receivedAt", (payload->'payment'->>'value') AS value FROM billing_events WHERE result LIKE 'sem_conta%' ORDER BY received_at DESC LIMIT 50`);
      const failed = await pool.query(`SELECT COUNT(*)::int AS n FROM billing_events WHERE processed=false`);
      res.json({ ...base, kpis: { ...cnt.rows[0], revenueMonth: rev.rows[0].total, pending: pending.rows.length, failed: failed.rows[0].n }, events: events.rows, pending: pending.rows });
    } catch (e) { console.error('pagamentos:', e.message); res.status(500).json({ error: 'Não foi possível carregar.' }); }
  });

  app.post('/api/admin/pagamentos/regras', requireAdmin, async (req, res) => {
    const b = req.body || {};
    const num = (v, max) => { const x = parseInt(v, 10); return Number.isFinite(x) && x >= 0 && x <= max ? String(x) : null; };
    const warn = num(b.warnDays, 60), down = num(b.downgradeDays, 90), grace = num(b.graceDays, 30);
    if (warn === null || down === null || grace === null) return res.status(400).json({ error: 'Use números inteiros: aviso até 60, volta ao Grátis até 90, tolerância até 30 dias.' });
    if (parseInt(warn, 10) > parseInt(down, 10)) return res.status(400).json({ error: 'O aviso precisa vir antes (ou no mesmo dia) da volta ao Grátis.' });
    await saveSettings({ billingWarnDays: warn, billingDowngradeDays: down, billingGraceDays: grace });
    res.json({ ok: true });
  });

  app.post('/api/admin/pagamentos/verificar', requireAdmin, async (req, res) => {
    try { res.json(await sweep()); } catch (e) { console.error('verificar:', e.message); res.status(500).json({ error: 'Falhou ao verificar.' }); }
  });

  // Reaplica um evento (ex.: pagamento sem conta). Com "email", vincula a outra conta.
  app.post('/api/admin/pagamentos/eventos/:id/aplicar', requireAdmin, async (req, res) => {
    if (!useDb) return res.status(503).json({ error: 'Precisa de banco de dados.' });
    try {
      const { rows } = await pool.query('SELECT id, payload FROM billing_events WHERE id=$1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Evento não encontrado.' });
      const email = req.body && typeof req.body.email === 'string' && req.body.email.trim() ? req.body.email.trim() : null;
      const result = await processRow(rows[0], email);
      res.json({ ok: true, result });
    } catch (e) { console.error('aplicar:', e.message); res.status(500).json({ error: 'Não foi possível aplicar agora.' }); }
  });

  return { init, applyPendingFor, sweep };
};
