// Seção Aparência do painel: marca e imagens, cores e estilo, pré-visualização, banners e links.
// Tudo passa pelo rascunho (/api/admin/appearance/...). Nada chega aos alunos antes de "Publicar alterações".
(function(){
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const ICONS = {
  image:'<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  palette:'<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 1 0 0 20c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.3-.3-.3-.5-.8-.5-1.3 0-1.1.9-2 2-2h2.4a4.6 4.6 0 0 0 4.6-4.6C22 6 17.5 2 12 2z"/>',
  eye:'<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  megaphone:'<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>',
  trash:'<path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>',
  undo:'<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  save:'<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  send:'<path d="m22 2-7 20-4-9-9-4 20-7z"/><path d="M22 2 11 13"/>',
  rotate:'<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  monitor:'<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  sparkle:'<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z"/>',
  edit:'<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  x:'<path d="M18 6 6 18M6 6l12 12"/>'
};
const ic = n => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n]||''}</svg>`;

// ---------- tema: mesma regra de /theme.css (guarda de contraste) ----------
const HEX = /^#[0-9a-fA-F]{6}$/;
const DEF = { primaryColor:'#223449', accentColor:'#5C8374' };
const rgb = h => { const n = parseInt(h.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const toHex = c => '#' + c.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
const lum = h => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; const [r, g, b] = rgb(h).map(f); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contrast = h => 1.05 / (lum(h) + 0.05);
const darken = (h, f) => toHex(rgb(h).map(v => v * (1 - f)));
function ensure(h, min){ let x = h; for(let i = 0; i < 60 && contrast(x) < min; i++) x = darken(x, 0.03); return x; }
function themeOf(s){
  const p = HEX.test(s.primaryColor) ? s.primaryColor : DEF.primaryColor, a = HEX.test(s.accentColor) ? s.accentColor : DEF.accentColor;
  const sageDark = a.toLowerCase() === DEF.accentColor.toLowerCase() ? '#3F5C50' : ensure(darken(a, 0.25), 4.5);
  return { navy: ensure(p, 7), sage: a, sageDark, r: ({ reto:'3px', suave:'8px', redondo:'14px' })[s.radius] || '3px' };
}
window.__apThemeOf = themeOf; // usado nos testes

const PRESETS = [
  ['Oncoway (padrão)', '#223449', '#5C8374'], ['Verde clínico', '#14532D', '#2E7D32'], ['Azul hospitalar', '#1E3A5F', '#3B7EA1'],
  ['Grafite e menta', '#263238', '#2A9D8F'], ['Vinho institucional', '#4A1D2B', '#8C4A5E']
];
const IMGS = [
  { k:'logo', t:'Logotipo principal', d:'Aparece no login e no menu lateral do app.', spec:'PNG com fundo transparente ou SVG · largura mínima de 600 px · até 1,5 MB (SVG até 200 KB).', max:600, cls:'', accept:'image/png,image/jpeg,image/webp,image/svg+xml' },
  { k:'logoLight', t:'Logotipo branco', d:'Versão clara para fundos escuros (uso futuro).', spec:'PNG ou SVG branco, fundo transparente · mesmas medidas do logotipo principal.', max:600, cls:'dark', accept:'image/png,image/jpeg,image/webp,image/svg+xml' },
  { k:'photo', t:'Fotografia da mentora', d:'Aparece em círculo na tela de login.', spec:'JPG, PNG ou WebP · quadrada, mínimo 400 × 400 px · rosto centralizado · até 1,5 MB.', max:400, cls:'round', accept:'image/png,image/jpeg,image/webp' },
  { k:'icon512', t:'Ícone do aplicativo', d:'Ícone que aparece na tela inicial do celular depois de instalar o app.', spec:'PNG quadrado, ideal 512 × 512 px (mínimo 144 px) · deixe margem ao redor do desenho.', max:1024, cls:'icon', accept:'image/png' }
];
const LABEL = { primaryColor:'Cor principal', accentColor:'Cor de destaque', fontHeading:'Fonte dos títulos', radius:'Cantos', showEntryCards:'Cartões de entrada', quickLinks:'Links rápidos' };
const NAMES = { logo:'Logotipo principal', logoLight:'Logotipo branco', photo:'Fotografia da mentora', icon512:'Ícone do aplicativo', icon192:'Ícone do aplicativo' };

let S = null, F = null, ID = { appName:'Agente Oncoway', tagline:'', mentorName:'', mentorTitle:'' };
let tab = 'marca', pvScreen = 'login', pvDevice = 'desktop', built = false, editingBanner = null, bnFile = null, bnRemoveImg = false;
try{ tab = localStorage.getItem('oncoway_ap_tab') || 'marca'; }catch(e){}

// ---------- estado local do formulário ----------
const cleanLinks = arr => (arr || []).map(l => ({ label:String(l.label || '').trim().slice(0, 40), url:String(l.url || '').trim().slice(0, 300) }))
  .filter(l => l.label && /^https?:\/\//i.test(l.url)).slice(0, 6);
function fromState(){
  const d = S.draft.settings; let links = []; try{ links = JSON.parse(d.quickLinks); }catch(e){}
  F = { primaryColor:d.primaryColor, accentColor:d.accentColor, fontHeading:d.fontHeading, radius:d.radius, showEntryCards:d.showEntryCards, links:links.map(l => ({ label:l.label, url:l.url })) };
}
function payload(){ return { primaryColor:F.primaryColor, accentColor:F.accentColor, fontHeading:F.fontHeading, radius:F.radius, showEntryCards:F.showEntryCards, quickLinks:JSON.stringify(cleanLinks(F.links)) }; }
function norm(p){ let q = []; try{ q = JSON.parse(p.quickLinks); }catch(e){} return JSON.stringify([p.primaryColor.toLowerCase(), p.accentColor.toLowerCase(), p.fontHeading, p.radius, p.showEntryCards, q.map(l => [l.label, l.url])]); }
const isDirty = () => !!(S && F && HEX.test(F.primaryColor) && HEX.test(F.accentColor) && norm(payload()) !== norm(S.draft.settings));
const fmtDate = iso => { try{ return new Date(iso).toLocaleString('pt-BR', { dateStyle:'short', timeStyle:'short' }); }catch(e){ return ''; } };

async function api(method, path, body){
  const r = await fetch('/api/admin/appearance' + path, { method, headers:{ 'Content-Type':'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if(!r.ok) throw new Error(d.error || 'Não foi possível concluir. Nada foi alterado.');
  return d;
}

// ---------- imagens ----------
function imgUrl(k){
  const st = S.draft.images[k], icon = k.startsWith('icon');
  if(st === 'new') return '/api/admin/appearance/draft-image/' + k + '?t=' + encodeURIComponent(S.draft.updatedAt || Date.now());
  if(st === 'removed') return icon ? '/brand/' + k : null;
  const v = S.imageVersions[k]; if(v) return '/brand/' + k + '?v=' + v;
  return icon ? '/brand/' + k : null;
}
function bannerImg(b){
  if(b.image === 'set') return '/api/admin/appearance/draft-image/' + b.id + '?t=' + encodeURIComponent(S.draft.updatedAt || Date.now());
  if(b.image === 'keep' && b.hasImage) return '/brand/' + b.id + '?v=' + (b.version || 1);
  return null;
}

// ---------- estrutura (montada uma vez) ----------
function build(){
  const root = $('apRoot');
  root.innerHTML = `<div class="ap">
    <div class="ap-bar">
      <div><div class="ap-chip" id="apChip"></div><div class="status" id="apSub" style="margin:4px 0 0 4px;font-size:12px;color:var(--ink-soft)"></div></div>
      <div class="ap-actions">
        <button class="ap-btn keep" data-act="save" id="apBtnSave" title="Salvar rascunho">${ic('save')}<span class="t">Salvar rascunho</span></button>
        <button class="ap-btn primary" data-act="publish" id="apBtnPub" title="Publicar alterações">${ic('send')}<span class="t">Publicar alterações</span></button>
        <button class="ap-btn quiet" data-act="restore" id="apBtnRestore" title="Restaurar padrão (só no rascunho)">${ic('rotate')}<span class="t">Restaurar padrão</span></button>
        <button class="ap-btn quiet" data-act="revert" id="apBtnRevert" title="Reverter publicação">${ic('undo')}<span class="t">Reverter publicação</span></button>
        <button class="ap-btn quiet" data-act="discard" id="apBtnDiscard" title="Descartar rascunho">${ic('x')}<span class="t">Descartar rascunho</span></button>
      </div>
    </div>
    <div class="ap-tabs" role="tablist">
      <button class="ap-tab" role="tab" data-tab="marca">${ic('image')} Marca e imagens <span class="n" id="apN-marca" hidden></span></button>
      <button class="ap-tab" role="tab" data-tab="cores">${ic('palette')} Cores e estilo <span class="n" id="apN-cores" hidden></span></button>
      <button class="ap-tab" role="tab" data-tab="previa">${ic('eye')} Pré-visualização</button>
      <button class="ap-tab" role="tab" data-tab="banners">${ic('megaphone')} Banners e links rápidos <span class="n" id="apN-banners" hidden></span></button>
    </div>

    <section class="ap-sec" id="apS-marca"><div class="ap-grid" id="apImgs"></div></section>

    <section class="ap-sec" id="apS-cores">
      <div class="ap-grid">
        <div class="ap-card wide"><h3>Paletas sugeridas</h3><p class="sub">Um ponto de partida. Você pode ajustar cada cor depois.</p><div class="ap-presets" id="apPresets"></div></div>
        <div class="ap-card wide"><h3>Paleta de cores</h3><p class="sub">Escolha no seletor ou digite o código (ex.: #14532D). Os textos brancos sobre estas cores sempre ficam legíveis: se necessário, ajustamos o tom e avisamos aqui.</p>
          <div class="ap-colors">
            <div class="ap-field"><label for="apHexP">Cor principal (menu, títulos, mensagens)</label>
              <div class="ap-colorrow"><input type="color" id="apPickP" aria-label="Seletor da cor principal"><input type="text" id="apHexP" maxlength="7" spellcheck="false"></div>
              <div class="ap-pair" id="apPairP"></div><div class="ap-note" id="apNoteP"></div></div>
            <div class="ap-field"><label for="apHexA">Cor de destaque (botões, selos, bordas)</label>
              <div class="ap-colorrow"><input type="color" id="apPickA" aria-label="Seletor da cor de destaque"><input type="text" id="apHexA" maxlength="7" spellcheck="false"></div>
              <div class="ap-pair" id="apPairA"></div><div class="ap-note" id="apNoteA"></div></div>
          </div>
          <div class="ap-row" style="margin-top:12px"><button class="ap-btn sm" data-act="suggest">${ic('sparkle')} Sugerir cores a partir do logotipo</button></div>
          <div class="ap-msg" id="apHint"></div>
        </div>
        <div class="ap-card"><h3>Fonte dos títulos</h3><p class="sub">Estilo das letras de títulos e destaques.</p><div class="ap-opts two" id="apFont"></div></div>
        <div class="ap-card"><h3>Arredondamento</h3><p class="sub">Cantos de botões, cartões e campos.</p><div class="ap-opts" id="apRadius"></div></div>
        <div class="ap-card"><h3>Tela inicial do aluno</h3><div class="ap-switch"><div><b style="font-size:14px">Cartões de entrada</b><div class="sub" style="margin:2px 0 0">Atalhos de perguntas na tela inicial do app.</div></div><button class="ap-toggle" id="apCards" role="switch" aria-label="Cartões de entrada" data-act="cards"></button></div></div>
        <div class="ap-card"><h3>Amostra ao vivo</h3><p class="sub">Como ficam os principais elementos com as escolhas atuais.</p><div class="ap-mini" id="apMini"></div></div>
      </div>
    </section>

    <section class="ap-sec" id="apS-previa">
      <div class="ap-pvbar">
        <div class="ap-seg" id="apSegScreen" role="group" aria-label="Tela"><button data-pv="login">Tela de login</button><button data-pv="app">Área dos alunos</button><button data-pv="admin">Painel administrativo</button></div>
        <div class="ap-seg" id="apSegDevice" role="group" aria-label="Dispositivo"><button data-dev="desktop">${ic('monitor')} Computador</button><button data-dev="mobile">${ic('phone')} Celular</button></div>
      </div>
      <div class="ap-stage" id="apStage"><div class="ap-frame-wrap" id="apFrameWrap"><div class="ap-frame" id="apFrame"></div></div></div>
      <p class="status" style="margin-top:10px">A pré-visualização usa o rascunho, incluindo o que você ainda não salvou. Os alunos continuam vendo a versão publicada até você clicar em <b>Publicar alterações</b>. É uma simulação das telas (os dados exibidos são ilustrativos).</p>
    </section>

    <section class="ap-sec" id="apS-banners">
      <div class="ap-grid">
        <div class="ap-card wide"><h3>Links rápidos do menu</h3><p class="sub">Até 6 atalhos no menu lateral do app dos alunos. Use “Salvar rascunho” depois de editar.</p>
          <div id="apLinks"></div>
          <div class="ap-row"><button class="ap-btn sm" data-act="addlink" id="apAddLink">${ic('plus')} Adicionar link</button></div></div>
        <div class="ap-card"><h3 id="apBnTitleH">Novo banner</h3><p class="sub">Faixa de destaque no topo do app (curso novo, imersão, comunidade). O aluno pode fechá-la. É salvo no rascunho ao clicar em salvar.</p>
          <input type="text" id="apBnTitle" maxlength="120" placeholder="Título"><input type="text" id="apBnBody" maxlength="400" placeholder="Texto curto">
          <input type="text" id="apBnUrl" placeholder="Link (https://…)"><input type="text" id="apBnLabel" maxlength="40" placeholder="Texto do botão (ex.: Saiba mais)">
          <div class="ap-row"><label class="ap-btn sm" style="margin:0">${ic('upload')} Imagem (opcional)<input type="file" id="apBnFile" accept="image/png,image/jpeg,image/webp"></label><span class="status" id="apBnFileName"></span></div>
          <label class="chk" id="apBnRemWrap" style="display:none;font-size:13px;margin-top:8px"><input type="checkbox" id="apBnRem"> Remover a imagem atual deste banner</label>
          <div class="ap-row" style="margin-top:12px"><button class="ap-btn primary sm" data-act="bnsave">${ic('save')} <span id="apBnSaveT">Salvar banner no rascunho</span></button><button class="ap-btn quiet sm" data-act="bncancel" id="apBnCancel" style="display:none">Cancelar edição</button></div>
          <div class="ap-msg" id="apBnMsg"></div></div>
        <div class="ap-card"><h3>Banners do rascunho</h3><p class="sub" id="apBnSub"></p><div id="apBnList"></div></div>
      </div>
    </section>
    <div id="apModalHost"></div>
  </div>`;
  const R = root;
  R.addEventListener('click', onClick);
  R.addEventListener('change', onChange);
  R.addEventListener('input', onInput);
  window.addEventListener('resize', layoutPreview);
  window.addEventListener('beforeunload', e => { if(S && isDirty()){ e.preventDefault(); e.returnValue = ''; } });
  built = true;
}

// ---------- renderização ----------
function render(){
  renderBar(); renderTabs(); renderImages(); renderColors(); renderLinks(); renderBanners(); renderPreview();
}
function renderBar(){
  const dirty = isDirty(), has = S.hasChanges;
  const parts = [];
  if(S.changes.settings.some(k => k !== 'quickLinks')) parts.push('cores e estilo');
  if(S.changes.settings.includes('quickLinks')) parts.push('links rápidos');
  if(S.changes.images.length) parts.push('imagens (' + S.changes.images.length + ')');
  if(S.changes.banners) parts.push('banners');
  const chip = $('apChip');
  if(dirty){ chip.className = 'ap-chip warn'; chip.innerHTML = '<span class="dot"></span>Alterações ainda não salvas no rascunho'; }
  else if(has){ chip.className = 'ap-chip warn'; chip.innerHTML = '<span class="dot"></span>Rascunho com alterações não publicadas: ' + esc(parts.join(', ')); }
  else { chip.className = 'ap-chip'; chip.innerHTML = '<span class="dot"></span>Tudo publicado. Os alunos veem esta versão'; }
  $('apSub').textContent = (dirty || has) ? 'Os alunos só veem estas mudanças depois de “Publicar alterações”.' : (S.previous.exists ? 'Versão anterior guardada em ' + fmtDate(S.previous.publishedAt) + '.' : 'Nenhuma publicação anterior guardada ainda.');
  $('apBtnRestore').disabled = false;
  $('apBtnSave').disabled = !dirty;
  $('apBtnPub').disabled = !(dirty || has);
  $('apBtnRevert').disabled = !S.previous.exists;
  $('apBtnDiscard').disabled = !(S.draft.exists || dirty);
}
function renderTabs(){
  document.querySelectorAll('.ap-tab').forEach(b => { const on = b.dataset.tab === tab; b.classList.toggle('active', on); b.setAttribute('aria-selected', on); });
  document.querySelectorAll('.ap-sec').forEach(s => s.classList.toggle('active', s.id === 'apS-' + tab));
  const dirty = isDirty();
  const colorsN = S.changes.settings.filter(k => k !== 'quickLinks').length + (dirty && !S.changes.settings.length ? 1 : 0);
  const set = (id, n) => { const e = $(id); e.hidden = !n; e.textContent = n; };
  set('apN-marca', S.changes.images.length);
  set('apN-cores', colorsN);
  set('apN-banners', (S.changes.settings.includes('quickLinks') ? 1 : 0) + (S.changes.banners ? 1 : 0));
}
function renderImages(){
  $('apImgs').innerHTML = IMGS.map(m => {
    const url = imgUrl(m.k), st = S.draft.images[m.k];
    const tag = st === 'new' ? '<span class="ap-tag new">Novo no rascunho</span>' : st === 'removed' ? '<span class="ap-tag warn">Remoção pendente</span>' : (S.imageVersions[m.k] ? '<span class="ap-tag">Publicado</span>' : '<span class="ap-tag">Padrão</span>');
    const body = url ? `<img src="${esc(url)}" alt="${esc(m.t)}" id="apImg-${m.k}">` : `<div class="empty">${ic('image')}<br>Sem imagem</div>`;
    const hasAny = !!url && !(m.k === 'icon512' && st !== 'new' && !S.imageVersions.icon512);
    return `<div class="ap-card"><h3>${esc(m.t)} ${tag}</h3><p class="sub">${esc(m.d)}</p>
      <div class="ap-drop ${m.cls}">${body}</div>
      <div class="ap-spec">${esc(m.spec)}</div>
      <div class="ap-row">
        <label class="ap-btn sm" style="margin:0">${ic('upload')} ${hasAny ? 'Substituir' : 'Enviar'}<input type="file" accept="${m.accept}" data-file="${m.k}"></label>
        ${m.k === 'icon512' ? `<button class="ap-btn sm" data-act="genicon">${ic('sparkle')} Gerar a partir do logotipo</button>` : ''}
        ${st === 'new' || st === 'removed' ? `<button class="ap-btn sm quiet" data-act="imgundo" data-k="${m.k}">${ic('undo')} Desfazer</button>` : ''}
        ${hasAny && st !== 'removed' ? `<button class="ap-btn sm danger" data-act="imgdel" data-k="${m.k}">${ic('trash')} ${m.k === 'icon512' ? 'Voltar ao padrão' : 'Remover'}</button>` : ''}
      </div><div class="ap-msg${(MSG['apMsg-' + m.k] || {}).err ? ' err' : ''}" id="apMsg-${m.k}">${esc((MSG['apMsg-' + m.k] || {}).text || '')}</div></div>`;
  }).join('');
}
function renderColors(){
  const set = (id, v) => { const e = $(id); if(e && document.activeElement !== e) e.value = v; };
  set('apPickP', HEX.test(F.primaryColor) ? F.primaryColor : DEF.primaryColor); set('apHexP', F.primaryColor.toUpperCase());
  set('apPickA', HEX.test(F.accentColor) ? F.accentColor : DEF.accentColor); set('apHexA', F.accentColor.toUpperCase());
  updateColorInfo();
  $('apPresets').innerHTML = PRESETS.map((p, i) => `<button class="ap-preset" data-act="preset" data-i="${i}"><span class="sw"><i style="background:${p[1]}"></i><i style="background:${p[2]}"></i></span>${esc(p[0])}</button>`).join('');
  $('apFont').innerHTML = [['serif', 'Serifada', 'Source Serif 4, serif'], ['sans', 'Sem serifa', 'IBM Plex Sans, sans-serif']].map(o =>
    `<button class="ap-opt ${F.fontHeading === o[0] ? 'sel' : ''}" data-act="font" data-v="${o[0]}" aria-pressed="${F.fontHeading === o[0]}"><span class="aa" style="font-family:${o[2]};font-weight:700">Aa</span>${o[1]}</button>`).join('');
  $('apRadius').innerHTML = [['reto', 'Retos', '3px'], ['suave', 'Suaves', '8px'], ['redondo', 'Arredondados', '14px']].map(o =>
    `<button class="ap-opt ${F.radius === o[0] ? 'sel' : ''}" data-act="radius" data-v="${o[0]}" aria-pressed="${F.radius === o[0]}"><span class="demo" style="border-radius:${o[2]}"></span>${o[1]}</button>`).join('');
  $('apCards').setAttribute('aria-checked', F.showEntryCards === 'sim');
}
function swatch(label, hex){ return `<div class="ap-sw"><i style="background:${esc(hex)}"></i><span>${esc(label)}<br><b style="font-family:'IBM Plex Mono',monospace">${esc(hex.toUpperCase())}</b></span></div>`; }
function updateColorInfo(){
  const t = themeOf(F), okP = HEX.test(F.primaryColor), okA = HEX.test(F.accentColor);
  $('apHexP').classList.toggle('bad', !okP); $('apHexA').classList.toggle('bad', !okA);
  if(okP){
    const adj = t.navy.toLowerCase() !== F.primaryColor.toLowerCase();
    $('apPairP').innerHTML = swatch('Escolhida', F.primaryColor) + swatch('Aplicada', t.navy);
    $('apNoteP').className = 'ap-note' + (adj ? ' warn' : '');
    $('apNoteP').innerHTML = adj ? `<b>Ajuste automático:</b> a cor ${esc(F.primaryColor.toUpperCase())} ficaria clara demais para texto branco. Aplicamos ${esc(t.navy.toUpperCase())} (contraste ${contrast(t.navy).toFixed(1)}:1) para manter tudo legível.` : `Contraste com texto branco: ${contrast(t.navy).toFixed(1)}:1. Legível.`;
  } else { $('apPairP').innerHTML = ''; $('apNoteP').className = 'ap-note warn'; $('apNoteP').textContent = 'Digite um código válido, como #223449.'; }
  if(okA){
    $('apPairA').innerHTML = swatch('Escolhida', F.accentColor) + swatch('Botões (tom mais escuro)', t.sageDark);
    $('apNoteA').className = 'ap-note';
    $('apNoteA').innerHTML = `Os botões usam um tom mais escuro da cor de destaque, com contraste ${contrast(t.sageDark).toFixed(1)}:1 sobre o texto branco.`;
  } else { $('apPairA').innerHTML = ''; $('apNoteA').className = 'ap-note warn'; $('apNoteA').textContent = 'Digite um código válido, como #5C8374.'; }
  const mini = $('apMini'); if(mini){
    mini.style.cssText = `--navy:${t.navy};--sage:${t.sage};--sage-dark:${t.sageDark};--r:${t.r}`;
    mini.innerHTML = `<div class="m-head" style="background:var(--navy);border-radius:var(--r) var(--r) 0 0;font-family:${F.fontHeading === 'sans' ? "'IBM Plex Sans'" : "'Source Serif 4'"},serif">${esc(ID.appName)}</div>
      <div style="background:#fff;border:1px solid #CBD3C4;border-top:3px solid var(--sage);border-radius:0 0 var(--r) var(--r);padding:12px;font-size:13px">Exemplo de cartão com borda de destaque.
      <div style="margin-top:10px;display:inline-block;background:var(--sage-dark);color:#fff;border-radius:var(--r);padding:8px 14px;font-size:12px;text-transform:uppercase;letter-spacing:.5px">Botão</div></div>`;
  }
}
function renderLinks(){
  $('apLinks').innerHTML = F.links.length ? F.links.map((l, i) => `<div class="ap-linkrow"><input type="text" data-link="${i}" data-f="label" value="${esc(l.label)}" maxlength="40" placeholder="Nome (ex.: Mentoria Oncoway)" aria-label="Nome do link ${i + 1}"><input type="text" data-link="${i}" data-f="url" value="${esc(l.url)}" placeholder="https://…" aria-label="Endereço do link ${i + 1}"><button class="ap-btn sm danger" data-act="dellink" data-i="${i}" title="Remover link">${ic('trash')}</button></div>`).join('') : '<p class="status" style="margin:0 0 10px">Nenhum link rápido.</p>';
  $('apAddLink').disabled = F.links.length >= 6;
}
function renderBanners(){
  const B = S.banners, list = B.list;
  const removed = B.live.filter(l => !list.some(b => b.id === l.id)).length;
  $('apBnSub').textContent = (S.draft.exists && B.changed ? 'Alterações de banners aguardam publicação.' : 'Banners publicados no app dos alunos.') + (removed ? ` ${removed} será(ão) removido(s) ao publicar.` : '');
  $('apBnList').innerHTML = list.length ? list.map(b => {
    const img = bannerImg(b);
    const tag = b.status === 'novo' ? '<span class="ap-tag new">Novo</span>' : b.status === 'alterado' ? '<span class="ap-tag warn">Alterado</span>' : '<span class="ap-tag">Publicado</span>';
    return `<div class="ap-bn ${b.active === false ? 'off' : ''}"><div class="th">${img ? `<img src="${esc(img)}" alt="">` : 'sem imagem'}</div>
      <div class="tx"><b>${esc(b.title || '(sem título)')} ${tag}</b><span>${b.active === false ? 'OCULTO' : 'VISÍVEL'}${b.link_url ? ' · ' + esc(b.link_url) : ''}</span></div>
      <div class="ap-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <button class="ap-btn sm" data-act="bnedit" data-id="${esc(b.id)}" title="Editar">${ic('edit')}</button>
        <button class="ap-btn sm quiet" data-act="bntoggle" data-id="${esc(b.id)}" title="${b.active === false ? 'Mostrar' : 'Ocultar'}">${ic('eye')}</button>
        <button class="ap-btn sm danger" data-act="bndel" data-id="${esc(b.id)}" title="Excluir">${ic('trash')}</button></div></div>`;
  }).join('') : '<p class="status" style="margin:0">Nenhum banner.</p>';
}

// ---------- pré-visualização ----------
function pvVars(){ const t = themeOf(F); return `--navy:${t.navy};--sage:${t.sage};--sage-dark:${t.sageDark};--r:${t.r}`; }
function pvLogo(){ const u = imgUrl('logo'); return u ? `<img class="logo" src="${esc(u)}" alt="">` : `<div class="hf" style="font-size:22px;font-weight:700;color:var(--navy)">${esc(ID.appName)}</div>`; }
function pvLoginHtml(){
  const ph = imgUrl('photo');
  return `<div class="pv-login"><div class="card">${imgUrl('logo') ? pvLogo() : ''}${ph ? `<img class="ph" src="${esc(ph)}" alt="">` : ''}
    <div class="eb">${esc([ID.mentorName, ID.mentorTitle].filter(Boolean).join(' · ') || 'Oncologia Veterinária')}</div>
    ${imgUrl('logo') ? '' : `<h4 class="hf">${esc(ID.appName)}</h4>`}
    <div class="tabs"><span class="on">Entrar</span><span>1º acesso</span><span>Criar conta</span></div>
    <div class="lb">E-mail</div><div class="in"></div><div class="lb">Senha</div><div class="in"></div><div class="btn">Entrar</div></div></div>`;
}
function pvAppHtml(m){
  const banners = S.banners.list.filter(b => b.active !== false).slice(0, 2).map(b => { const u = bannerImg(b); return `<div class="banner">${u ? `<img src="${esc(u)}" alt="">` : ''}<div><div class="bt hf">${esc(b.title)}</div>${b.body ? `<div class="bb">${esc(b.body)}</div>` : ''}${b.link_url ? `<span class="bl">${esc(b.link_label || 'Saiba mais')}</span>` : ''}</div></div>`; }).join('');
  const links = cleanLinks(F.links).map(l => `<div class="ql">${esc(l.label)}</div>`).join('');
  const cards = F.showEntryCards === 'sim' ? `<div class="cards"><div><b class="hf">Interpretar exame</b>Envie um laudo ou foto</div><div><b class="hf">Dose de fármaco</b>Consulte com segurança</div><div><b class="hf">Protocolo</b>Caso clínico</div><div><b class="hf">Dúvida do acervo</b>Pergunte à mentora</div></div>` : '';
  return `<div class="pv-app ${m ? 'm' : ''}"><div class="sb">${pvLogo()}<div class="nw">+ Nova conversa</div><div class="cv">Conversas recentes…</div>${links}<div class="us">Plano gratuito<div class="bar"><i></i></div></div></div>
    <div class="mn"><div class="hd">${m ? '<span class="burger"></span>' : ''}<div class="t hf">${esc(ID.appName)}</div></div>
    <div class="bd">${banners}<div class="welcome"><div class="wt hf">Como posso ajudar hoje?</div><div class="ws">${esc(ID.tagline || '')}</div></div>${cards}</div>
    <div class="cp"><div class="in"></div><div class="btn">Enviar</div></div></div></div>`;
}
function pvAdminHtml(m){
  const items = ['Visão geral', 'Acervo', 'Triagem e doses', 'Alunos', 'Planos e custos', 'Aparência', 'Identidade e IA'];
  return `<div class="pv-adm ${m ? 'm' : ''}"><div class="sd"><b class="hf">Oncoway</b>${items.map((x, i) => `<div class="it ${i === 5 ? 'on' : ''}">${x}</div>`).join('')}</div>
    <div class="ct"><h5 class="hf">Visão geral</h5><p>O que está acontecendo agora e o que precisa da sua atenção.</p>
    <div class="kp"><div><b class="hf">128</b><span>Alunos</span></div><div><b class="hf">1.240</b><span>Perguntas</span></div><div><b class="hf">R$ 86</b><span>Custo do mês</span></div></div>
    <div class="todo">Existem perguntas sem cobertura no acervo.</div><span class="go">Ver lacunas</span></div></div>`;
}
const PV_SIZE = { desktop:{ w:1100, h:640 }, mobile:{ w:390, h:760 } };
function renderPreview(){
  if(!$('apFrame')) return;
  document.querySelectorAll('#apSegScreen button').forEach(b => b.classList.toggle('on', b.dataset.pv === pvScreen));
  document.querySelectorAll('#apSegDevice button').forEach(b => b.classList.toggle('on', b.dataset.dev === pvDevice));
  const m = pvDevice === 'mobile';
  const inner = pvScreen === 'login' ? pvLoginHtml() : pvScreen === 'app' ? pvAppHtml(m) : pvAdminHtml(m);
  const frame = $('apFrame');
  frame.className = 'ap-frame' + (m ? ' phone' : '');
  frame.innerHTML = `<div class="pv ${F.fontHeading === 'sans' ? 'sans' : ''}" style="${pvVars()}">${inner}</div>`;
  layoutPreview();
}
function layoutPreview(){
  const stage = $('apStage'), wrap = $('apFrameWrap'), frame = $('apFrame'); if(!stage || !frame) return;
  const sz = PV_SIZE[pvDevice], avail = stage.clientWidth - 36; if(avail <= 0) return;
  const s = Math.min(1, avail / sz.w);
  frame.style.width = sz.w + 'px'; frame.style.height = sz.h + 'px'; frame.style.transform = `scale(${s})`;
  wrap.style.width = Math.round(sz.w * s) + 'px'; wrap.style.height = Math.round(sz.h * s) + 'px';
}

// ---------- modal ----------
function modal(o){
  return new Promise(resolve => {
    const host = $('apModalHost'); const bg = document.createElement('div'); bg.className = 'ap-modal-bg';
    bg.innerHTML = `<div class="ap-modal" role="dialog" aria-modal="true" aria-label="${esc(o.title)}"><h3>${esc(o.title)}</h3>${o.html}
      ${o.check ? `<label class="chk"><input type="checkbox" id="apModalChk"> <span>${esc(o.check)}</span></label>` : ''}
      <div class="foot"><button class="ap-btn quiet" data-m="no">Cancelar</button><button class="ap-btn ${o.danger ? 'danger' : 'primary'}" data-m="yes">${esc(o.confirm)}</button></div></div>`;
    const done = v => { const chk = bg.querySelector('#apModalChk'); const c = !!(chk && chk.checked); bg.remove(); document.removeEventListener('keydown', onKey); resolve(v ? { ok:true, checked:c } : { ok:false }); };
    const onKey = e => { if(e.key === 'Escape') done(false); };
    bg.addEventListener('click', e => { if(e.target === bg || e.target.dataset.m === 'no') done(false); else if(e.target.closest('[data-m=yes]')) done(true); });
    document.addEventListener('keydown', onKey);
    host.appendChild(bg); const y = bg.querySelector('[data-m=yes]'); if(y) y.focus();
  });
}
function publishSummary(){
  const p = payload(), live = S.live, items = [];
  const t = themeOf(F), tl = themeOf(live);
  if(p.primaryColor.toLowerCase() !== live.primaryColor.toLowerCase()) items.push(`${LABEL.primaryColor}: ${live.primaryColor.toUpperCase()} → ${p.primaryColor.toUpperCase()}${t.navy.toLowerCase() !== p.primaryColor.toLowerCase() ? ` (aplicada com ajuste de contraste: ${t.navy.toUpperCase()})` : ''}`);
  if(p.accentColor.toLowerCase() !== live.accentColor.toLowerCase()) items.push(`${LABEL.accentColor}: ${live.accentColor.toUpperCase()} → ${p.accentColor.toUpperCase()}`);
  if(p.fontHeading !== live.fontHeading) items.push(`${LABEL.fontHeading}: ${p.fontHeading === 'sans' ? 'sem serifa' : 'serifada'}`);
  if(p.radius !== live.radius) items.push(`${LABEL.radius}: ${p.radius}`);
  if(p.showEntryCards !== live.showEntryCards) items.push(`${LABEL.showEntryCards}: ${p.showEntryCards === 'sim' ? 'mostrar' : 'ocultar'}`);
  if(norm({ ...p, primaryColor:live.primaryColor, accentColor:live.accentColor, fontHeading:live.fontHeading, radius:live.radius, showEntryCards:live.showEntryCards }) !== norm(live)) items.push('Links rápidos alterados');
  for(const k of ['logo', 'logoLight', 'photo', 'icon512']){ const st = S.draft.images[k]; if(st === 'new') items.push(NAMES[k] + ': nova imagem'); if(st === 'removed') items.push(NAMES[k] + ': será removido' + (k === 'icon512' ? ' (volta ao ícone padrão)' : '')); }
  const nNew = S.banners.list.filter(b => b.status === 'novo').length, nAlt = S.banners.list.filter(b => b.status === 'alterado').length, nRem = S.banners.live.filter(l => !S.banners.list.some(b => b.id === l.id)).length;
  if(nNew || nAlt || nRem) items.push(`Banners: ${nNew} novo(s), ${nAlt} alterado(s), ${nRem} removido(s)`);
  void tl; return items;
}

// ---------- ações ----------
const MSG = {}; // mensagens das imagens sobrevivem à renderização
function note(id, text, err){ MSG[id] = { text:text || '', err:!!err }; const e = $(id); if(e){ e.textContent = text || ''; e.className = 'ap-msg' + (err ? ' err' : ''); } }
function setBusy(b){ document.querySelectorAll('.ap-actions .ap-btn').forEach(x => { if(b) x.disabled = true; }); if(!b) renderBar(); }
async function run(fn, msgId){
  try{ setBusy(true); await fn(); }
  catch(e){ if(msgId) note(msgId, e.message, true); else alert(e.message); }
  finally{ setBusy(false); render(); }
}
async function doSave(){ S = await api('PUT', '/draft', { settings: payload() }); }
async function uploadImage(k, file){
  note('apMsg-' + k, 'Enviando…');
  try{
    if(k === 'icon512'){
      const img = await loadImg(await dataUrlOf(file, 1024));
      await postIcons((x, n) => x.drawImage(img, 0, 0, n, n));
    } else {
      const max = IMGS.find(m => m.k === k).max;
      S = await api('POST', '/draft/image/' + k, { dataUrl: await dataUrlOf(file, max) });
    }
    if(!isDirty()) fromState();
    render(); note('apMsg-' + k, 'Salvo no rascunho ✓ (os alunos ainda não veem)');
    if(k === 'logo') note('apHint', 'Novo logotipo no rascunho. Se quiser, use “Sugerir cores a partir do logotipo”.');
  }catch(e){ note('apMsg-' + k, e.message, true); }
}
function dataUrlOf(file, maxDim){
  return new Promise((resolve, reject) => {
    if(file.type === 'image/svg+xml'){ const fr = new FileReader(); fr.onload = () => resolve(fr.result); fr.onerror = reject; fr.readAsDataURL(file); return; }
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
      resolve(file.type === 'image/png' ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('Não consegui abrir a imagem.'));
    img.src = url;
  });
}
const loadImg = src => new Promise((resolve, reject) => { const i = new Image(); i.onload = () => resolve(i); i.onerror = () => reject(new Error('Não consegui abrir a imagem.')); i.src = src; });
async function postIcons(draw){
  for(const n of [512, 192]){
    const c = document.createElement('canvas'); c.width = c.height = n; draw(c.getContext('2d'), n);
    S = await api('POST', '/draft/image/icon' + n, { dataUrl: c.toDataURL('image/png') });
  }
}
async function genIcon(){
  const k = 'icon512'; note('apMsg-' + k, 'Gerando…');
  try{
    const u = imgUrl('logo'); if(!u) throw new Error('Envie um logotipo primeiro.');
    const img = await loadImg(u); const bg = themeOf(F).navy;
    await postIcons((x, n) => {
      x.fillStyle = bg; x.fillRect(0, 0, n, n);
      const box = n * 0.56, w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height, kf = Math.min(box / w0, box / h0), w = w0 * kf, h = h0 * kf;
      x.drawImage(img, (n - w) / 2, (n - h) / 2, w, h);
    });
    if(!isDirty()) fromState();
    render(); note('apMsg-' + k, 'Ícone gerado no rascunho ✓');
  }catch(e){ note('apMsg-' + k, e.message, true); }
}
async function imgDelete(k){
  const keys = k === 'icon512' ? ['icon512', 'icon192'] : [k];
  for(const x of keys) S = await api('DELETE', '/draft/image/' + x);
}
async function imgUndo(k){
  const keys = k === 'icon512' ? ['icon512', 'icon192'] : [k];
  for(const x of keys) S = await api('POST', '/draft/image/' + x + '/undo');
}
function suggestColors(){
  const img = $('apImg-logo'), hint = $('apHint');
  if(!img){ hint.textContent = 'Envie um logotipo primeiro.'; return; }
  try{
    const c = document.createElement('canvas'), w = 96; c.width = w; c.height = Math.max(1, Math.round(w * (img.naturalHeight || 1) / (img.naturalWidth || 1)));
    const x = c.getContext('2d'); x.drawImage(img, 0, 0, c.width, c.height);
    const px = x.getImageData(0, 0, c.width, c.height).data, bins = {};
    for(let i = 0; i < px.length; i += 4){
      const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3]; if(a < 200) continue;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b), sat = mx ? (mx - mn) / mx : 0; if(sat < 0.25 || mx > 245) continue;
      const k = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4), o = bins[k] || (bins[k] = { n:0, r:0, g:0, b:0, sat:0 }); o.n++; o.r += r; o.g += g; o.b += b; o.sat += sat;
    }
    const list = Object.values(bins).map(o => ({ r:Math.round(o.r / o.n), g:Math.round(o.g / o.n), b:Math.round(o.b / o.n), score:o.n * (o.sat / o.n + 0.3) })).sort((a, b) => b.score - a.score);
    if(!list.length){ hint.textContent = 'O logotipo não tem cores marcantes; escolha as cores manualmente.'; return; }
    const hex = o => toHex([o.r, o.g, o.b]), lm = o => 0.299 * o.r + 0.587 * o.g + 0.114 * o.b;
    const main = list[0], dark = list.slice(0, 6).sort((a, b) => lm(a) - lm(b))[0];
    F.accentColor = hex(main); F.primaryColor = hex(lm(dark) < 120 ? dark : { r:main.r * .45, g:main.g * .45, b:main.b * .45 });
    hint.textContent = 'Cores sugeridas a partir do logotipo. Ajuste se quiser e clique em Salvar rascunho.';
    render();
  }catch(e){ hint.textContent = 'Não consegui ler as cores deste logotipo.'; }
}

async function actSave(){ await run(async () => { await doSave(); fromState(); note('apHint', 'Rascunho salvo ✓'); }); }
async function actPublish(){
  if(!(isDirty() || S.hasChanges)) return;
  const bad = !HEX.test(F.primaryColor) || !HEX.test(F.accentColor);
  if(bad){ alert('Corrija os códigos de cor antes de publicar.'); return; }
  const items = publishSummary();
  const iconChanged = S.draft.images.icon512 !== 'unchanged';
  const r = await modal({ title:'Publicar alterações?', confirm:'Publicar agora', html:
    `<p>Os alunos passarão a ver estas mudanças ao abrir ou recarregar o app (até 1 minuto):</p><ul>${(items.length ? items : ['Alterações do rascunho']).map(i => `<li>${esc(i)}</li>`).join('')}</ul>
     <p style="color:var(--ink-soft)">A versão atual fica guardada e você pode usar “Reverter publicação”.${iconChanged ? ' O ícone na tela inicial do iPhone só muda se a pessoa instalar o app de novo.' : ''}</p>` });
  if(!r.ok) return;
  await run(async () => {
    if(isDirty()) await doSave();
    S = await api('POST', '/publish', { confirm:true }); fromState(); note('apHint', 'Publicado ✓');
  });
}
async function actRestore(){
  const r = await modal({ title:'Restaurar o padrão?', confirm:'Restaurar no rascunho', danger:true, check:'Também marcar logotipos, fotografia e ícone para remoção',
    html:'<p>Cores, fonte, arredondamento, cartões de entrada e links rápidos voltam ao padrão original <b>apenas no rascunho</b>. Os banners não são afetados.</p><p>Os alunos continuam vendo a versão atual até você clicar em “Publicar alterações”.</p>' });
  if(!r.ok) return;
  await run(async () => { S = await api('POST', '/draft/restore-defaults', { includeImages: r.checked }); fromState(); note('apHint', 'Padrão restaurado no rascunho. Revise e publique quando quiser.'); });
}
async function actRevert(){
  if(!S.previous.exists) return;
  const r = await modal({ title:'Reverter a publicação?', confirm:'Reverter agora', danger:true, html:
    `<p>O app dos alunos <b>volta imediatamente</b> à versão publicada antes de ${esc(fmtDate(S.previous.publishedAt))} (cores, imagens, banners e links).</p><p>A versão de hoje fica guardada como “anterior”, então você pode desfazer a reversão. Seu rascunho atual não é apagado.</p>` });
  if(!r.ok) return;
  await run(async () => { S = await api('POST', '/revert', { confirm:true }); if(!isDirty()) fromState(); });
}
async function actDiscard(){
  const r = await modal({ title:'Descartar o rascunho?', confirm:'Descartar', danger:true, html:'<p>Todas as alterações não publicadas (cores, imagens, links e banners) serão apagadas e o rascunho volta a ser igual ao publicado.</p>' });
  if(!r.ok) return;
  await run(async () => { S = await api('POST', '/draft/discard', {}); fromState(); });
}

// banners
function bnReset(){ editingBanner = null; bnFile = null; bnRemoveImg = false; ['apBnTitle', 'apBnBody', 'apBnUrl', 'apBnLabel'].forEach(i => $(i).value = ''); $('apBnFile').value = ''; $('apBnFileName').textContent = ''; $('apBnRemWrap').style.display = 'none'; $('apBnRem').checked = false; $('apBnTitleH').textContent = 'Novo banner'; $('apBnSaveT').textContent = 'Salvar banner no rascunho'; $('apBnCancel').style.display = 'none'; }
async function bnSave(){
  const title = $('apBnTitle').value.trim(); if(!title){ note('apBnMsg', 'Informe um título.', true); return; }
  try{
    setBusy(true);
    const cur = editingBanner ? S.banners.list.find(b => b.id === editingBanner) : null;
    const d = await api('POST', '/draft/banners', { id: editingBanner || undefined, title, body:$('apBnBody').value, link_url:$('apBnUrl').value, link_label:$('apBnLabel').value, active: cur ? cur.active !== false : true, position: cur ? cur.position : S.banners.list.length });
    S = d; const id = d.id;
    const f = $('apBnFile').files[0];
    if(f) S = await api('POST', '/draft/banner-image/' + id, { dataUrl: await dataUrlOf(f, 900) });
    else if(editingBanner && $('apBnRem').checked) S = await api('DELETE', '/draft/banner-image/' + id);
    bnReset(); note('apBnMsg', 'Banner salvo no rascunho ✓ (os alunos ainda não veem)');
  }catch(e){ note('apBnMsg', e.message, true); }
  finally{ setBusy(false); render(); }
}
function bnEdit(id){
  const b = S.banners.list.find(x => x.id === id); if(!b) return;
  editingBanner = id; $('apBnTitle').value = b.title || ''; $('apBnBody').value = b.body || ''; $('apBnUrl').value = b.link_url || ''; $('apBnLabel').value = b.link_label || '';
  $('apBnTitleH').textContent = 'Editar banner'; $('apBnSaveT').textContent = 'Salvar alterações no rascunho'; $('apBnCancel').style.display = ''; $('apBnRemWrap').style.display = bannerImg(b) ? 'flex' : 'none';
  $('apBnTitle').focus(); $('apBnTitle').scrollIntoView({ behavior:'smooth', block:'center' });
}

// ---------- eventos ----------
function onClick(e){
  const t = e.target.closest('[data-tab],[data-pv],[data-dev],[data-act]'); if(!t) return;
  if(t.dataset.tab){ tab = t.dataset.tab; try{ localStorage.setItem('oncoway_ap_tab', tab); }catch(x){} renderTabs(); if(tab === 'previa') renderPreview(); return; }
  if(t.dataset.pv){ pvScreen = t.dataset.pv; renderPreview(); return; }
  if(t.dataset.dev){ pvDevice = t.dataset.dev; renderPreview(); return; }
  const a = t.dataset.act, k = t.dataset.k;
  if(a === 'save') actSave(); else if(a === 'publish') actPublish(); else if(a === 'restore') actRestore(); else if(a === 'revert') actRevert(); else if(a === 'discard') actDiscard();
  else if(a === 'suggest') suggestColors();
  else if(a === 'preset'){ const p = PRESETS[+t.dataset.i]; F.primaryColor = p[1]; F.accentColor = p[2]; render(); }
  else if(a === 'font'){ F.fontHeading = t.dataset.v; render(); }
  else if(a === 'radius'){ F.radius = t.dataset.v; render(); }
  else if(a === 'cards'){ F.showEntryCards = F.showEntryCards === 'sim' ? 'nao' : 'sim'; render(); }
  else if(a === 'addlink'){ if(F.links.length < 6){ F.links.push({ label:'', url:'' }); renderLinks(); renderBar(); } }
  else if(a === 'dellink'){ F.links.splice(+t.dataset.i, 1); renderLinks(); renderBar(); renderPreview(); renderTabs(); }
  else if(a === 'genicon') genIcon();
  else if(a === 'imgdel'){ run(() => imgDelete(k), 'apMsg-' + k).then(() => note('apMsg-' + k, 'Marcado para remoção no rascunho.')); }
  else if(a === 'imgundo'){ run(() => imgUndo(k), 'apMsg-' + k); }
  else if(a === 'bnsave') bnSave();
  else if(a === 'bncancel'){ bnReset(); }
  else if(a === 'bnedit') bnEdit(t.dataset.id);
  else if(a === 'bntoggle'){ const b = S.banners.list.find(x => x.id === t.dataset.id); if(b) run(async () => { S = await api('POST', '/draft/banners', { ...b, active: b.active === false }); }); }
  else if(a === 'bndel'){ modal({ title:'Excluir este banner?', confirm:'Excluir do rascunho', danger:true, html:'<p>O banner sai do rascunho e será removido do app dos alunos somente quando você publicar.</p>' }).then(r => { if(r.ok) run(async () => { S = await api('DELETE', '/draft/banners/' + t.dataset.id); }); }); }
}
function onChange(e){
  const f = e.target;
  if(f.dataset && f.dataset.file){ const file = f.files[0]; f.value = ''; if(file) run(() => uploadImage(f.dataset.file, file)); return; }
  if(f.id === 'apBnFile'){ $('apBnFileName').textContent = f.files[0] ? f.files[0].name : ''; }
}
function onInput(e){
  const f = e.target;
  if(f.id === 'apPickP' || f.id === 'apPickA'){ const isP = f.id === 'apPickP'; F[isP ? 'primaryColor' : 'accentColor'] = f.value; $(isP ? 'apHexP' : 'apHexA').value = f.value.toUpperCase(); afterColor(); }
  else if(f.id === 'apHexP' || f.id === 'apHexA'){
    const isP = f.id === 'apHexP'; let v = f.value.trim(); if(/^[0-9a-fA-F]{6}$/.test(v)) v = '#' + v;
    F[isP ? 'primaryColor' : 'accentColor'] = v; if(HEX.test(v)) $(isP ? 'apPickP' : 'apPickA').value = v; afterColor();
  } else if(f.dataset && f.dataset.link !== undefined){ F.links[+f.dataset.link][f.dataset.f] = f.value; renderBar(); renderTabs(); renderPreview(); }
}
function afterColor(){ updateColorInfo(); renderBar(); renderTabs(); renderPreview(); }

// ---------- carregamento ----------
window.loadAppearance = async function(){
  const root = $('apRoot'); if(!root) return;
  if(!built) build();
  try{
    const [st, br] = await Promise.all([api('GET', ''), fetch('/api/branding').then(r => r.json()).catch(() => ({}))]);
    S = st; ID = { appName:br.appName || ID.appName, tagline:br.tagline || '', mentorName:br.mentorName || '', mentorTitle:br.mentorTitle || '' };
    if(!F || !isDirty()) fromState();
    render();
  }catch(e){ root.innerHTML = `<div class="ap-card"><h3>Não foi possível carregar a aparência</h3><p class="sub">${esc(e.message)}</p></div>`; built = false; }
};
})();
