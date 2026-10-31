// Controle de acesso por perfil profissional.
// Cadastro espontâneo: CRMV obrigatório. Sem CRMV (ou estudante): envia o atestado de matrícula
// e só acessa o agente depois que a mentora aprova.
//   students.access_status: NULL = liberado | 'pending' = aguardando análise | 'rejected' = recusado
// O arquivo do atestado fica no banco só até a decisão e é apagado em seguida.
module.exports = function registerAccess(deps) {
  const { app, pool, useDb, requireAdmin, requireStudentApi, rateLimit, sendInfoMail, getSettings, escHtml } = deps;

  const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
  const MAX_PROOF = 5 * 1024 * 1024;

  async function init() {
    if (!useDb) return;
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS crmv TEXT;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS crmv_uf TEXT;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS access_status TEXT;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS access_note TEXT;`);
    await pool.query(`ALTER TABLE students ADD COLUMN IF NOT EXISTS access_reviewed_at TIMESTAMPTZ;`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS student_proofs (
        student_id TEXT PRIMARY KEY REFERENCES students(id) ON DELETE CASCADE,
        mime TEXT NOT NULL,
        filename TEXT,
        data BYTEA NOT NULL,
        created_at TIMESTAMPTZ DEFAULT now()
      );
    `);
  }

  // ---------- validação ----------
  function sniffProof(buf) {
    if (buf.length >= 5 && buf.toString('latin1', 0, 5) === '%PDF-') return 'application/pdf';
    if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
    return null;
  }
  function parseProof(dataUrl) {
    const m = /^data:([a-z0-9.+\/-]+);base64,([A-Za-z0-9+\/=\s]+)$/i.exec(String(dataUrl || ''));
    if (!m) return { error: 'Envie o atestado em PDF, JPG, PNG ou WebP.' };
    const b64 = m[2].replace(/\s/g, '');
    if (b64.length > Math.ceil(MAX_PROOF * 4 / 3) + 8) return { error: 'O arquivo passa de 5 MB. Envie um menor.' };
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length || buf.length > MAX_PROOF) return { error: 'O arquivo passa de 5 MB. Envie um menor.' };
    const mime = sniffProof(buf);
    if (!mime) return { error: 'Formato não aceito. Envie PDF, JPG, PNG ou WebP.' };
    return { mime, buf };
  }
  // Lê o perfil informado no cadastro. Devolve { crmv, uf, status, proof } ou { error }.
  function parseProfile(body) {
    const b = body || {};
    if (b.profile === 'crmv') {
      const crmv = String(b.crmv || '').trim().toUpperCase().replace(/^CRMV[-\s]*/, '');
      const uf = String(b.crmvUf || '').trim().toUpperCase();
      if (!/^[0-9]{1,8}(\s?-\s?[A-Z])?$/.test(crmv)) return { error: 'Informe o número do CRMV (somente números).' };
      if (!UFS.includes(uf)) return { error: 'Escolha o estado do CRMV.' };
      return { crmv, uf, status: null, proof: null };
    }
    if (b.profile === 'sem_crmv') {
      const p = parseProof(b.proof);
      if (p.error) return { error: p.error };
      return { crmv: null, uf: null, status: 'pending', proof: { ...p, filename: String(b.proofName || '').slice(0, 120) } };
    }
    return { error: 'Informe se você tem CRMV ou se é estudante.' };
  }
  async function saveProof(studentId, proof) {
    await pool.query(
      `INSERT INTO student_proofs (student_id, mime, filename, data) VALUES ($1,$2,$3,$4)
       ON CONFLICT (student_id) DO UPDATE SET mime=EXCLUDED.mime, filename=EXCLUDED.filename, data=EXCLUDED.data, created_at=now()`,
      [studentId, proof.mime, proof.filename || null, proof.buf]);
  }

  // ---------- estado de acesso (com cache curto) ----------
  const cache = new Map();
  async function accessState(studentId) {
    if (!useDb || !studentId) return { status: null, note: '' };
    const hit = cache.get(studentId);
    if (hit && Date.now() - hit.at < 10000) return hit.v;
    const { rows } = await pool.query('SELECT access_status, access_note FROM students WHERE id=$1', [studentId]);
    const v = { status: rows[0] ? rows[0].access_status || null : null, note: rows[0] ? rows[0].access_note || '' : '' };
    cache.set(studentId, { at: Date.now(), v });
    return v;
  }
  const forget = id => cache.delete(id);

  // Igual ao requireStudentApi, mas barra quem ainda não foi aprovado.
  function requireApprovedApi(req, res, next) {
    requireStudentApi(req, res, async () => {
      try {
        const a = await accessState(req.student.studentId);
        if (a.status) return res.status(403).json({ error: 'access_pending', status: a.status, message: 'Seu acesso ainda não foi liberado.' });
        next();
      } catch (e) { console.error('access:', e.message); res.status(500).json({ error: 'Não foi possível verificar o acesso.' }); }
    });
  }

  async function notifyMentor(name, email) {
    try {
      const cfg = await getSettings();
      if (cfg.supportEmail) await sendInfoMail(cfg.supportEmail, 'Novo atestado para analisar', `<p><b>${escHtml(name)}</b> (${escHtml(email)}) enviou o atestado de matrícula e aguarda aprovação.</p><p>Abra o painel, aba Alunos, filtro "Aguardando aprovação".</p>`);
    } catch (e) { console.error('notifyMentor:', e.message); }
  }

  // ---------- aluno ----------
  // Reenvio do atestado (aluno recusado ou ainda sem arquivo).
  app.post('/api/proof', requireStudentApi, async (req, res) => {
    try {
      if (!useDb) return res.status(503).json({ error: 'Indisponível.' });
      const id = req.student.studentId;
      if (!rateLimit('proof:' + id, 6, 3600000)) return res.status(429).json({ error: 'Muitas tentativas. Tente mais tarde.' });
      const a = await accessState(id);
      if (!a.status) return res.status(400).json({ error: 'Seu acesso já está liberado.' });
      const p = parseProof(req.body && req.body.proof);
      if (p.error) return res.status(400).json({ error: p.error });
      await saveProof(id, { ...p, filename: String((req.body && req.body.proofName) || '').slice(0, 120) });
      await pool.query(`UPDATE students SET access_status='pending', access_note=NULL WHERE id=$1`, [id]);
      forget(id);
      const { rows } = await pool.query('SELECT name, email FROM students WHERE id=$1', [id]);
      if (rows[0]) notifyMentor(rows[0].name, rows[0].email);
      res.json({ ok: true, status: 'pending' });
    } catch (e) { console.error('proof:', e.message); res.status(500).json({ error: 'Não foi possível enviar agora.' }); }
  });

  // ---------- admin ----------
  app.get('/api/admin/students/:id/proof', requireAdmin, async (req, res) => {
    if (!useDb) return res.status(404).end();
    const { rows } = await pool.query('SELECT mime, filename, data FROM student_proofs WHERE student_id=$1', [req.params.id]);
    if (!rows[0]) return res.status(404).send('Nenhum atestado guardado para este aluno.');
    res.set({ 'Content-Type': rows[0].mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      'Content-Disposition': 'inline; filename="atestado' + ({ 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }[rows[0].mime] || '') + '"' });
    res.send(rows[0].data);
  });

  app.get('/api/admin/access-pending', requireAdmin, async (req, res) => {
    if (!useDb) return res.json({ count: 0 });
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM students WHERE access_status='pending'`);
    res.json({ count: rows[0].n });
  });

  app.post('/api/admin/students/:id/access', requireAdmin, async (req, res) => {
    try {
      if (!useDb) return res.status(503).json({ error: 'Precisa de banco de dados.' });
      const action = req.body && req.body.action;
      const note = String((req.body && req.body.note) || '').trim().slice(0, 300);
      if (!['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Ação inválida.' });
      const { rows } = await pool.query('SELECT id, name, email FROM students WHERE id=$1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Aluno não encontrado.' });
      const s = rows[0], cfg = await getSettings();
      if (action === 'approve') {
        await pool.query(`UPDATE students SET access_status=NULL, access_note=NULL, access_reviewed_at=now() WHERE id=$1`, [s.id]);
      } else {
        await pool.query(`UPDATE students SET access_status='rejected', access_note=$2, access_reviewed_at=now() WHERE id=$1`, [s.id, note || null]);
      }
      await pool.query('DELETE FROM student_proofs WHERE student_id=$1', [s.id]); // não guardamos o documento depois da decisão
      forget(s.id);
      try {
        if (action === 'approve') await sendInfoMail(s.email, 'Seu acesso foi liberado', `<p>Olá, ${escHtml(s.name)}! Seu cadastro foi aprovado. Já pode entrar no aplicativo.</p>`);
        else await sendInfoMail(s.email, 'Não conseguimos aprovar seu cadastro', `<p>Olá, ${escHtml(s.name)}. Não foi possível aprovar seu cadastro com o documento enviado.${note ? `</p><p><b>Motivo:</b> ${escHtml(note)}` : ''}</p><p>Entre no aplicativo e envie um novo atestado de matrícula${cfg.supportEmail ? ` ou fale conosco: ${escHtml(cfg.supportEmail)}` : ''}.</p>`);
      } catch (e) { console.error('access mail:', e.message); }
      res.json({ ok: true });
    } catch (e) { console.error('access:', e.message); res.status(500).json({ error: 'Não foi possível concluir.' }); }
  });

  return { init, parseProfile, saveProof, accessState, requireApprovedApi, notifyMentor, UFS };
};
