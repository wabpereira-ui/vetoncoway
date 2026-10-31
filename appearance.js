// Rascunho, publicação e reversão da aparência.
//
// Modelo:
//  - "Publicado" = o que os alunos veem: app_settings + app_assets + app_banners (como sempre foi). Nada é migrado.
//  - "Rascunho"  = tabela appearance_versions (slot 'draft'): só as diferenças em relação ao publicado
//                  (configurações visuais, imagens novas/removidas e, se editados, a lista de banners).
//                  Imagens do rascunho ficam em app_assets com a chave "draft:<nome>", que NÃO é servida
//                  publicamente (/brand só aceita chaves conhecidas).
//  - "Anterior"  = cópia da última configuração publicada (slot 'previous' + imagens "prev:<nome>").
//  Publicar e reverter rodam em UMA transação do Postgres: ou tudo muda, ou nada muda.
//  Não há tabelas novas além de appearance_versions (etapa 3): banners em rascunho ficam dentro do JSON do rascunho.
//
// Tudo exige banco de dados (Supabase). Sem banco, as rotas respondem 503 e o app segue como está.

const VISUAL_KEYS = ['primaryColor', 'accentColor', 'fontHeading', 'radius', 'showEntryCards', 'quickLinks'];
const IMAGE_KEYS = ['logo', 'logoLight', 'photo', 'icon192', 'icon512'];
const BANNER_ID = /^banner-[a-z0-9]{6,20}$/;
const MAX_BANNERS = 12;
const LOCK_ID = 727001; // trava consultiva: uma operação de aparência por vez

module.exports = function registerAppearance(deps) {
  const { app, pool, useDb, requireAdmin, parseDataUrl, DEFAULT_SETTINGS, OPTIONS, HEX, sanitizeQuickLinks, invalidateCaches, buildTheme, randomId } = deps;

  let _ready = null;
  function ensureTables() {
    if (!_ready) {
      _ready = pool.query(`
        CREATE TABLE IF NOT EXISTS appearance_versions (
          slot TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT now()
        );`).catch(e => { _ready = null; throw e; });
    }
    return _ready;
  }

  // Valida um valor visual; devolve o valor limpo ou null se for inválido.
  function cleanVisual(k, v) {
    if (typeof v !== 'string' && k !== 'quickLinks') return null;
    if (k === 'primaryColor' || k === 'accentColor') { const s = String(v).trim(); return HEX.test(s) ? s : null; }
    if (OPTIONS[k]) { const s = String(v).trim(); return OPTIONS[k].includes(s) ? s : null; }
    if (k === 'quickLinks') return sanitizeQuickLinks(typeof v === 'string' ? v : JSON.stringify(v));
    return null;
  }
  // Mesma limpeza usada no salvamento direto de banners.
  function cleanBanner(b, id) {
    return {
      id,
      title: String(b.title || '').trim().slice(0, 120),
      body: String(b.body || '').trim().slice(0, 400),
      link_url: /^https?:\/\//i.test(String(b.link_url || '').trim()) ? String(b.link_url).trim().slice(0, 300) : '',
      link_label: String(b.link_label || '').trim().slice(0, 40),
      active: b.active !== false,
      position: Number.isFinite(+b.position) ? Math.max(0, Math.min(999, Math.round(+b.position))) : 0
    };
  }

  async function tx(fn) {
    await ensureTables();
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (e2) {}
      throw e;
    } finally { c.release(); }
  }

  const getSlot = async (q, slot) => { const { rows } = await q.query('SELECT data, updated_at FROM appearance_versions WHERE slot=$1', [slot]); return rows[0] || null; };
  const putSlot = (q, slot, data) => q.query(
    `INSERT INTO appearance_versions (slot, data) VALUES ($1,$2)
     ON CONFLICT (slot) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`, [slot, JSON.stringify(data)]);
  const copyAsset = (q, from, to) => q.query(
    `INSERT INTO app_assets (key, mime, data) SELECT $2, mime, data FROM app_assets WHERE key=$1
     ON CONFLICT (key) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, [from, to]);
  const upsertSetting = (q, k, v) => q.query(
    `INSERT INTO app_settings (key, value) VALUES ($1,$2)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`, [k, v]);
  const upsertBannerRow = (q, b) => q.query(
    `INSERT INTO app_banners (id,title,body,link_url,link_label,active,position) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET title=EXCLUDED.title, body=EXCLUDED.body, link_url=EXCLUDED.link_url,
       link_label=EXCLUDED.link_label, active=EXCLUDED.active, position=EXCLUDED.position`,
    [b.id, b.title, b.body, b.link_url, b.link_label, b.active, b.position]);

  // ---- leitura do que está publicado ----
  async function liveRaw(q) {
    const { rows } = await q.query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [VISUAL_KEYS]);
    const raw = Object.fromEntries(VISUAL_KEYS.map(k => [k, null]));
    rows.forEach(r => { raw[r.key] = r.value; });
    return raw;
  }
  async function liveBanners(q) {
    const { rows } = await q.query('SELECT id, title, body, link_url, link_label, active, position FROM app_banners ORDER BY position, created_at');
    return rows;
  }
  // chave -> versão (ms) das imagens publicadas (logotipos, ícones e banners); ausente = sem imagem
  async function liveVersions(q) {
    const { rows } = await q.query(
      `SELECT key, (extract(epoch from updated_at)*1000)::bigint AS v FROM app_assets
       WHERE key = ANY($1) OR key LIKE 'banner-%'`, [IMAGE_KEYS]);
    return Object.fromEntries(rows.map(r => [r.key, Number(r.v)]));
  }
  function effective(raw) {
    const out = {};
    for (const k of VISUAL_KEYS) {
      const v = raw[k] == null ? null : cleanVisual(k, raw[k]);
      out[k] = v == null ? DEFAULT_SETTINGS[k] : v;
    }
    return out;
  }
  const normDraft = d => ({ settings: (d && d.settings) || {}, images: (d && d.images) || {}, banners: d && Array.isArray(d.banners) ? d.banners : null });

  // O rascunho de banners nasce como cópia da lista publicada.
  const bannersFromLive = (rows, versions) => rows.map(r => ({ ...cleanBanner(r, r.id), image: versions[r.id] ? 'keep' : 'none' }));
  const sameBanner = (a, b) => ['title', 'body', 'link_url', 'link_label', 'active', 'position'].every(k => a[k] === b[k]);

  async function state(q) {
    const raw = await liveRaw(q);
    const live = effective(raw);
    const versions = await liveVersions(q);
    const dSlot = await getSlot(q, 'draft');
    const draft = normDraft(dSlot && dSlot.data);
    const draftEff = { ...live, ...draft.settings };
    const changes = VISUAL_KEYS.filter(k => draftEff[k] !== live[k]);
    const images = {};
    for (const k of IMAGE_KEYS) images[k] = draft.images[k] === 'set' ? 'new' : draft.images[k] === 'remove' ? 'removed' : 'unchanged';
    const imgChanges = IMAGE_KEYS.filter(k => images[k] !== 'unchanged');

    const lRows = await liveBanners(q);
    const liveList = lRows.map(r => ({ ...cleanBanner(r, r.id), hasImage: !!versions[r.id], version: versions[r.id] || null }));
    let bannerList = liveList.map(b => ({ ...b, image: b.hasImage ? 'keep' : 'none', status: 'publicado' }));
    let bannersChanged = false;
    if (draft.banners) {
      const liveById = Object.fromEntries(liveList.map(b => [b.id, b]));
      bannerList = draft.banners.map(b => {
        const l = liveById[b.id];
        let status = 'novo';
        if (l) status = (sameBanner(l, b) && (b.image === 'keep' || (b.image === 'none' && !l.hasImage))) ? 'publicado' : 'alterado';
        return { ...b, hasImage: b.image === 'set' || (b.image === 'keep' && !!(l && l.hasImage)), version: l ? l.version : null, status };
      });
      const removed = liveList.filter(l => !draft.banners.some(b => b.id === l.id)).map(l => l.id);
      bannersChanged = removed.length > 0 || bannerList.some(b => b.status !== 'publicado')
        || draft.banners.map(b => b.id).join() !== liveList.map(b => b.id).join();
    }
    const prev = await getSlot(q, 'previous');
    return {
      live, liveTheme: buildTheme(live),
      draft: { exists: !!dSlot, settings: draftEff, images, updatedAt: dSlot ? dSlot.updated_at : null },
      draftTheme: buildTheme(draftEff),
      imageVersions: Object.fromEntries(IMAGE_KEYS.map(k => [k, versions[k] || null])),
      banners: { list: bannerList, live: liveList, changed: bannersChanged, max: MAX_BANNERS },
      changes: { settings: changes, images: imgChanges, banners: bannersChanged },
      hasChanges: changes.length + imgChanges.length > 0 || bannersChanged,
      previous: { exists: !!prev, publishedAt: prev ? prev.data.publishedAt : null }
    };
  }

  // Guarda o que está publicado agora (configurações, imagens e banners) como "versão anterior".
  async function snapshotCurrent(c) {
    const raw = await liveRaw(c);
    const versions = await liveVersions(c);
    const banners = await liveBanners(c);
    const keys = [...IMAGE_KEYS, ...banners.map(b => b.id)].filter(k => versions[k]);
    await c.query(`DELETE FROM app_assets WHERE key LIKE 'prev:%'`);
    for (const k of keys) await copyAsset(c, k, 'prev:' + k);
    return { settings: raw, images: Object.fromEntries(keys.map(k => [k, true])), banners: banners.map(b => cleanBanner(b, b.id)), publishedAt: new Date().toISOString() };
  }

  const guard = fn => async (req, res) => {
    if (!useDb) return res.status(503).json({ error: 'Rascunho e publicação precisam do banco de dados (Supabase) configurado.' });
    try { await fn(req, res); }
    catch (e) { console.error('Aparência:', e.message); if (!res.headersSent) res.status(500).json({ error: 'Não foi possível concluir a operação. Nada foi alterado.' }); }
  };
  const draftOf = async c => normDraft((await getSlot(c, 'draft') || {}).data);
  // Garante que existe lista de banners no rascunho (cópia da publicada) para poder editá-la.
  async function draftWithBanners(c) {
    const d = await draftOf(c);
    if (!d.banners) d.banners = bannersFromLive(await liveBanners(c), await liveVersions(c));
    return d;
  }

  // ---- Leitura ----
  app.get('/api/admin/appearance', requireAdmin, guard(async (req, res) => {
    await ensureTables();
    res.json(await state(pool));
  }));

  // Imagem do rascunho (só administrador): usada pela pré-visualização.
  app.get('/api/admin/appearance/draft-image/:key', requireAdmin, guard(async (req, res) => {
    const key = req.params.key;
    if (!IMAGE_KEYS.includes(key) && !BANNER_ID.test(key)) return res.status(404).end();
    const { rows } = await pool.query('SELECT mime, data FROM app_assets WHERE key=$1', ['draft:' + key]);
    if (!rows[0]) return res.status(404).end();
    res.set('Content-Type', rows[0].mime);
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    res.send(Buffer.from(rows[0].data, 'base64'));
  }));

  // ---- Rascunho: configurações ----
  app.put('/api/admin/appearance/draft', requireAdmin, guard(async (req, res) => {
    const input = (req.body && req.body.settings) || {};
    const clean = {};
    for (const k of VISUAL_KEYS) {
      if (input[k] === undefined) continue;
      const v = cleanVisual(k, input[k]);
      if (v === null) return res.status(400).json({ error: `Valor inválido para "${k}".` });
      clean[k] = v;
    }
    await tx(async c => {
      const cur = await draftOf(c);
      await putSlot(c, 'draft', { ...cur, settings: { ...cur.settings, ...clean } });
    });
    res.json(await state(pool));
  }));

  // ---- Rascunho: imagens ----
  app.post('/api/admin/appearance/draft/image/:key', requireAdmin, guard(async (req, res) => {
    const key = req.params.key;
    if (!IMAGE_KEYS.includes(key)) return res.status(400).json({ error: 'Chave inválida.' });
    const parsed = parseDataUrl(req.body && req.body.dataUrl, key); // mesma validação rígida dos uploads
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    await tx(async c => {
      await c.query(
        `INSERT INTO app_assets (key, mime, data) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, ['draft:' + key, parsed.mime, parsed.data]);
      const cur = await draftOf(c);
      cur.images[key] = 'set';
      await putSlot(c, 'draft', cur);
    });
    res.json(await state(pool));
  }));
  // Marca a imagem para ser removida na publicação (a publicada continua até publicar).
  app.delete('/api/admin/appearance/draft/image/:key', requireAdmin, guard(async (req, res) => {
    const key = req.params.key;
    if (!IMAGE_KEYS.includes(key)) return res.status(400).json({ error: 'Chave inválida.' });
    await tx(async c => {
      await c.query('DELETE FROM app_assets WHERE key=$1', ['draft:' + key]);
      const cur = await draftOf(c);
      cur.images[key] = 'remove';
      await putSlot(c, 'draft', cur);
    });
    res.json(await state(pool));
  }));
  // Desfaz a mudança do rascunho para essa imagem (volta a valer a publicada).
  app.post('/api/admin/appearance/draft/image/:key/undo', requireAdmin, guard(async (req, res) => {
    const key = req.params.key;
    if (!IMAGE_KEYS.includes(key)) return res.status(400).json({ error: 'Chave inválida.' });
    await tx(async c => {
      await c.query('DELETE FROM app_assets WHERE key=$1', ['draft:' + key]);
      const cur = await draftOf(c);
      delete cur.images[key];
      await putSlot(c, 'draft', cur);
    });
    res.json(await state(pool));
  }));

  // ---- Rascunho: banners ----
  // Cria ou edita um banner no rascunho (a imagem tem rota própria).
  app.post('/api/admin/appearance/draft/banners', requireAdmin, guard(async (req, res) => {
    const b = req.body || {};
    if (b.id !== undefined && b.id !== null && b.id !== '' && !BANNER_ID.test(b.id)) return res.status(400).json({ error: 'id inválido' });
    let id = b.id || null; let out = null;
    await tx(async c => {
      const d = await draftWithBanners(c);
      const idx = id ? d.banners.findIndex(x => x.id === id) : -1;
      if (idx < 0 && d.banners.length >= MAX_BANNERS) { out = { error: `Limite de ${MAX_BANNERS} banners.` }; return; }
      if (idx < 0) id = id || randomId();
      const clean = cleanBanner({ position: idx >= 0 ? d.banners[idx].position : d.banners.length, ...b }, id);
      if (idx >= 0) d.banners[idx] = { ...d.banners[idx], ...clean };
      else d.banners.push({ ...clean, image: 'none' });
      await putSlot(c, 'draft', d);
      out = { id };
    });
    if (out.error) return res.status(400).json({ error: out.error });
    res.json({ id: out.id, ...(await state(pool)) });
  }));
  app.delete('/api/admin/appearance/draft/banners/:id', requireAdmin, guard(async (req, res) => {
    const id = req.params.id;
    if (!BANNER_ID.test(id)) return res.status(400).json({ error: 'id inválido' });
    await tx(async c => {
      const d = await draftWithBanners(c);
      d.banners = d.banners.filter(x => x.id !== id);
      await c.query('DELETE FROM app_assets WHERE key=$1', ['draft:' + id]);
      await putSlot(c, 'draft', d);
    });
    res.json(await state(pool));
  }));
  app.post('/api/admin/appearance/draft/banner-image/:id', requireAdmin, guard(async (req, res) => {
    const id = req.params.id;
    if (!BANNER_ID.test(id)) return res.status(400).json({ error: 'id inválido' });
    const parsed = parseDataUrl(req.body && req.body.dataUrl, id);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    let found = true;
    await tx(async c => {
      const d = await draftWithBanners(c);
      const b = d.banners.find(x => x.id === id);
      if (!b) { found = false; return; }
      await c.query(
        `INSERT INTO app_assets (key, mime, data) VALUES ($1,$2,$3)
         ON CONFLICT (key) DO UPDATE SET mime=EXCLUDED.mime, data=EXCLUDED.data, updated_at=now()`, ['draft:' + id, parsed.mime, parsed.data]);
      b.image = 'set';
      await putSlot(c, 'draft', d);
    });
    if (!found) return res.status(404).json({ error: 'Banner não encontrado no rascunho.' });
    res.json(await state(pool));
  }));
  app.delete('/api/admin/appearance/draft/banner-image/:id', requireAdmin, guard(async (req, res) => {
    const id = req.params.id;
    if (!BANNER_ID.test(id)) return res.status(400).json({ error: 'id inválido' });
    let found = true;
    await tx(async c => {
      const d = await draftWithBanners(c);
      const b = d.banners.find(x => x.id === id);
      if (!b) { found = false; return; }
      await c.query('DELETE FROM app_assets WHERE key=$1', ['draft:' + id]);
      b.image = 'none';
      await putSlot(c, 'draft', d);
    });
    if (!found) return res.status(404).json({ error: 'Banner não encontrado no rascunho.' });
    res.json(await state(pool));
  }));

  // ---- Rascunho: restaurar padrão (só no rascunho; nada é publicado) ----
  // Cores, estilo e links voltam ao padrão. Banners são conteúdo e não são afetados.
  app.post('/api/admin/appearance/draft/restore-defaults', requireAdmin, guard(async (req, res) => {
    const includeImages = !!(req.body && req.body.includeImages); // por padrão preserva logotipos e fotos
    await tx(async c => {
      const cur = await draftOf(c);
      const settings = Object.fromEntries(VISUAL_KEYS.map(k => [k, DEFAULT_SETTINGS[k]]));
      let images = cur.images;
      if (includeImages) {
        await c.query(`DELETE FROM app_assets WHERE key IN ('draft:logo','draft:logoLight','draft:photo','draft:icon192','draft:icon512')`);
        images = Object.fromEntries(IMAGE_KEYS.map(k => [k, 'remove']));
      }
      await putSlot(c, 'draft', { ...cur, settings, images });
    });
    res.json(await state(pool));
  }));

  // ---- Rascunho: descartar ----
  app.post('/api/admin/appearance/draft/discard', requireAdmin, guard(async (req, res) => {
    await tx(async c => {
      await c.query(`DELETE FROM app_assets WHERE key LIKE 'draft:%'`);
      await c.query(`DELETE FROM appearance_versions WHERE slot='draft'`);
    });
    res.json(await state(pool));
  }));

  // ---- Publicar (atômico) ----
  app.post('/api/admin/appearance/publish', requireAdmin, guard(async (req, res) => {
    if (!(req.body && req.body.confirm === true)) return res.status(400).json({ error: 'Confirmação obrigatória para publicar.' });
    const out = await tx(async c => {
      const s = await state(c);
      if (!s.hasChanges) return { nothing: true };
      const draft = normDraft((await getSlot(c, 'draft')).data);
      const prev = await snapshotCurrent(c);
      await putSlot(c, 'previous', prev);
      for (const k of VISUAL_KEYS) if (draft.settings[k] !== undefined) await upsertSetting(c, k, draft.settings[k]);
      for (const k of IMAGE_KEYS) {
        if (draft.images[k] === 'set') {
          const ex = await c.query('SELECT 1 FROM app_assets WHERE key=$1', ['draft:' + k]);
          if (!ex.rows.length) throw new Error('imagem do rascunho ausente: ' + k); // desfaz tudo
          await copyAsset(c, 'draft:' + k, k);
        } else if (draft.images[k] === 'remove') await c.query('DELETE FROM app_assets WHERE key=$1', [k]);
      }
      if (draft.banners) {
        const keep = new Set(draft.banners.map(b => b.id));
        for (const l of await liveBanners(c)) {
          if (!keep.has(l.id)) { await c.query('DELETE FROM app_banners WHERE id=$1', [l.id]); await c.query('DELETE FROM app_assets WHERE key=$1', [l.id]); }
        }
        for (const b of draft.banners) {
          await upsertBannerRow(c, cleanBanner(b, b.id));
          if (b.image === 'set') {
            const ex = await c.query('SELECT 1 FROM app_assets WHERE key=$1', ['draft:' + b.id]);
            if (!ex.rows.length) throw new Error('imagem de banner ausente: ' + b.id);
            await copyAsset(c, 'draft:' + b.id, b.id);
          } else if (b.image === 'none') await c.query('DELETE FROM app_assets WHERE key=$1', [b.id]);
        }
      }
      await c.query(`DELETE FROM app_assets WHERE key LIKE 'draft:%'`);
      await c.query(`DELETE FROM appearance_versions WHERE slot='draft'`);
      return { published: true };
    });
    if (out.nothing) return res.status(400).json({ error: 'Não há alterações para publicar.' });
    invalidateCaches(); // só depois de confirmar a transação
    res.json({ ok: true, ...(await state(pool)) });
  }));

  // ---- Reverter para a versão anterior (atômico; a atual vira a "anterior", então dá para desfazer a reversão) ----
  app.post('/api/admin/appearance/revert', requireAdmin, guard(async (req, res) => {
    if (!(req.body && req.body.confirm === true)) return res.status(400).json({ error: 'Confirmação obrigatória para reverter.' });
    const out = await tx(async c => {
      const prevSlot = await getSlot(c, 'previous');
      if (!prevSlot) return { none: true };
      const p = prevSlot.data;
      const curRows = await liveBanners(c);
      const curVersions = await liveVersions(c);
      const curKeys = [...IMAGE_KEYS, ...curRows.map(b => b.id)].filter(k => curVersions[k]);
      const curSnap = { settings: await liveRaw(c), images: Object.fromEntries(curKeys.map(k => [k, true])), banners: curRows.map(b => cleanBanner(b, b.id)), publishedAt: new Date().toISOString() };
      // 1) guarda as imagens atuais em área temporária
      await c.query(`DELETE FROM app_assets WHERE key LIKE 'tmp:%'`);
      for (const k of curKeys) await copyAsset(c, k, 'tmp:' + k);
      // 2) aplica a anterior
      for (const k of VISUAL_KEYS) {
        const v = p.settings[k];
        if (v == null) await c.query('DELETE FROM app_settings WHERE key=$1', [k]);
        else await upsertSetting(c, k, v);
      }
      for (const k of IMAGE_KEYS) {
        if (p.images[k]) await copyAsset(c, 'prev:' + k, k);
        else await c.query('DELETE FROM app_assets WHERE key=$1', [k]);
      }
      if (Array.isArray(p.banners)) { // versões antigas do registro não tinham banners: nesse caso não mexe neles
        for (const r of curRows) { await c.query('DELETE FROM app_banners WHERE id=$1', [r.id]); await c.query('DELETE FROM app_assets WHERE key=$1', [r.id]); }
        for (const b of p.banners) {
          await upsertBannerRow(c, cleanBanner(b, b.id));
          if (p.images[b.id]) await copyAsset(c, 'prev:' + b.id, b.id);
        }
      }
      // 3) a que estava publicada passa a ser a "anterior"
      await c.query(`DELETE FROM app_assets WHERE key LIKE 'prev:%'`);
      for (const k of curKeys) await copyAsset(c, 'tmp:' + k, 'prev:' + k);
      await c.query(`DELETE FROM app_assets WHERE key LIKE 'tmp:%'`);
      await putSlot(c, 'previous', curSnap);
      return { reverted: true };
    });
    if (out.none) return res.status(400).json({ error: 'Ainda não existe uma versão anterior.' });
    invalidateCaches();
    res.json({ ok: true, ...(await state(pool)) });
  }));
};
