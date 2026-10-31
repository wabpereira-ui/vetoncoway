// Página "Pagamentos": situação da integração com o Asaas, assinaturas e eventos recentes.
(function(){
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const brl = n => 'R$ ' + Number(n || 0).toFixed(2).replace('.', ',');
  const when = v => v ? new Date(v).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
  let MSG = '';

  const style = document.createElement('style');
  style.textContent = `
    .pg-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr)); gap:12px; margin-bottom:12px; }
    .pg-grid > *{ min-width:0; }
    .pg-h{ font-family:'IBM Plex Mono',monospace; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:var(--ink-soft); margin:0 0 10px; }
    .pg-row{ display:flex; gap:8px; align-items:flex-start; padding:6px 0; border-bottom:1px solid var(--line); font-size:13px; }
    .pg-row:last-child{ border-bottom:0; }
    .pg-dot{ flex:0 0 auto; width:18px; text-align:center; font-weight:700; }
    .pg-ok{ color:var(--sage-dark); } .pg-bad{ color:#9A3B2E; } .pg-warn{ color:#7A4E1F; }
    .pg-small{ font-size:12px; color:var(--ink-soft); }
    .pg-fields{ display:grid; grid-template-columns:repeat(auto-fit,minmax(130px,1fr)); gap:10px; }
    .pg-fields label{ font-size:12px; color:var(--ink-soft); display:block; }
    .pg-fields input{ width:100%; margin:4px 0 0; box-sizing:border-box; }
    .pg-tbl{ overflow-x:auto; }
    .pg-tbl table{ width:100%; border-collapse:collapse; font-size:12.5px; }
    .pg-tbl th{ text-align:left; font-family:'IBM Plex Mono',monospace; font-size:10.5px; letter-spacing:.8px; text-transform:uppercase; color:var(--ink-soft); padding:6px 8px; border-bottom:1px solid var(--line); white-space:nowrap; }
    .pg-tbl td{ padding:7px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
    .pg-pend{ display:flex; gap:8px; flex-wrap:wrap; align-items:center; padding:8px 0; border-bottom:1px solid var(--line); }
    .pg-pend input{ flex:1; min-width:180px; margin:0; }
    code.pg-url{ word-break:break-all; background:#F1F3F2; padding:2px 6px; border-radius:3px; }
  `;
  document.head.appendChild(style);

  async function call(url, opt){
    const r = await fetch(url, opt);
    let j = {}; try { j = await r.json(); } catch(e){}
    if(!r.ok) throw new Error(j.error || 'Não foi possível concluir.');
    return j;
  }
  const post = (url, body) => call(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body || {}) });

  const EVT = {
    PAYMENT_CONFIRMED:'Pagamento confirmado', PAYMENT_RECEIVED:'Pagamento recebido', PAYMENT_OVERDUE:'Pagamento atrasado',
    PAYMENT_REFUNDED:'Pagamento estornado', PAYMENT_CHARGEBACK_REQUESTED:'Contestação (chargeback)',
    SUBSCRIPTION_INACTIVATED:'Assinatura cancelada', SUBSCRIPTION_DELETED:'Assinatura removida',
    SUBSCRIPTION_CREATED:'Assinatura criada', PAYMENT_CREATED:'Cobrança criada'
  };

  function row(ok, title, detail){
    const cls = ok === true ? 'pg-ok' : (ok === false ? 'pg-bad' : 'pg-warn');
    return `<div class="pg-row"><span class="pg-dot ${cls}">${ok === true ? '✓' : (ok === false ? '✕' : '!')}</span><div><div>${title}</div>${detail ? `<div class="pg-small">${detail}</div>` : ''}</div></div>`;
  }

  function render(d){
    const i = d.integration, k = d.kpis, root = $('pgRoot');
    const sandboxLink = /sandbox/i.test(i.upgradeUrl || '');
    const kp = (n, l, x) => `<div class="kpi"><div class="n">${n}</div><div class="l">${l}</div>${x ? `<div class="l" style="font-size:11.5px;margin-top:2px;">${x}</div>` : ''}</div>`;
    const result = r => {
      const t = String(r || ''); const bad = /^erro|^sem_conta/.test(t);
      return `<span class="${bad ? 'pg-warn' : ''}">${esc(t.replace(/^sem_conta: /, 'sem conta: ') || 'aguardando')}</span>`;
    };
    root.innerHTML = `
      ${MSG ? `<div class="status" style="margin:0 0 12px;">${esc(MSG)}</div>` : ''}
      ${k ? `<div class="kpis" style="margin-bottom:12px;">
        ${kp(k.active, 'Assinaturas em dia')}${kp(k.overdue, 'Pagamento atrasado')}${kp(k.canceled, 'Canceladas (ainda com acesso)')}
        ${kp(brl(k.revenueMonth), 'Recebido no mês', 'conforme avisos do Asaas')}${kp(k.pending, 'Pagamentos sem conta', 'precisam de vínculo')}
        ${k.manual ? kp(k.manual, 'Assinantes manuais', 'definidos por você, sem cobrança') : ''}</div>` : ''}
      ${k && k.failed ? `<div class="todo"><div>${k.failed} aviso(s) do Asaas não puderam ser processados. O Asaas tenta de novo sozinho; se persistir, veja a tabela abaixo.</div></div>` : ''}
      <div class="pg-grid">
        <div class="panel">
          <p class="pg-h">Integração com o Asaas</p>
          ${row(i.db, 'Banco de dados', i.db ? '' : 'Necessário para registrar pagamentos.')}
          ${row(i.webhookToken, 'Token do webhook', i.webhookToken ? 'Configurado no Render (ASAAS_WEBHOOK_TOKEN).' : 'Falta criar ASAAS_WEBHOOK_TOKEN no Render. Sem ele o Asaas é recusado.')}
          ${row(i.apiKey, 'Chave da API', i.apiKey ? 'Configurada (ASAAS_API_KEY).' : 'Falta ASAAS_API_KEY no Render. Sem ela não dá para descobrir o e-mail de quem pagou.')}
          ${row(i.env === 'sandbox' ? null : true, 'Ambiente: ' + (i.env === 'sandbox' ? 'testes (sandbox)' : 'produção'), esc(i.apiUrl))}
          ${row(i.mail, 'E-mail de avisos', i.mail ? 'Pronto para enviar confirmações e avisos de atraso.' : 'Sem e-mail configurado: os avisos de atraso não serão enviados.')}
          ${row(i.upgradeUrl ? (sandboxLink ? null : true) : false, 'Link de pagamento', i.upgradeUrl ? (sandboxLink ? 'Atenção: é um link de TESTES. Troque pelo link real em Planos e custos antes de divulgar.' : 'Definido em Planos e custos.') : 'Cole o link em Planos e custos (campo do botão Assinar).')}
          <div class="pg-small" style="margin-top:10px;">Endereço do webhook para cadastrar no Asaas:<br><code class="pg-url">${esc(location.origin)}/webhook/asaas</code></div>
        </div>
        <div class="panel">
          <p class="pg-h">Regras de cobrança</p>
          <div class="pg-fields">
            <label>Avisar por e-mail após (dias de atraso)<input type="number" min="0" max="60" id="pgWarn" value="${d.rules.warnDays}"></label>
            <label>Voltar ao Grátis após (dias de atraso)<input type="number" min="0" max="90" id="pgDown" value="${d.rules.downgradeDays}"></label>
            <label>Tolerância após o fim do período (dias)<input type="number" min="0" max="30" id="pgGrace" value="${d.rules.graceDays}"></label>
          </div>
          <div class="pg-small" style="margin:10px 0;">Quem cancela mantém o acesso até o fim do período já pago. Mentoria e planos definidos por você nunca são alterados automaticamente.</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;"><button class="btn" id="pgSave">Salvar regras</button><button class="btn ghost" id="pgSweep">Verificar atrasos agora</button></div>
        </div>
      </div>
      <div class="panel" style="margin-bottom:12px;">
        <p class="pg-h">Pagamentos sem conta no app (${d.pending.length})</p>
        ${d.pending.length ? d.pending.map(p => `<div class="pg-pend" data-id="${esc(p.id)}">
            <div style="flex:1 1 220px;min-width:0;"><div style="font-size:13px;">${esc(EVT[p.event] || p.event)}${p.value ? ' · ' + brl(p.value) : ''}</div><div class="pg-small">${esc(p.email || 'e-mail desconhecido')} · ${when(p.receivedAt)}<br>${esc(String(p.result || '').replace(/^sem_conta: /, ''))}</div></div>
            <input type="email" placeholder="e-mail da conta no app" value="${esc(p.email || '')}"><button class="btn ghost pgApply">Aplicar</button></div>`).join('')
          : '<div class="pg-small">Nenhum. Quando alguém pagar com um e-mail que ainda não tem conta, o plano é aplicado automaticamente assim que a pessoa se cadastrar. Se usou outro e-mail, vincule aqui.</div>'}
      </div>
      <div class="panel">
        <p class="pg-h">Avisos recentes do Asaas</p>
        <div class="pg-tbl">${d.events.length ? `<table><thead><tr><th>Quando</th><th>Evento</th><th>E-mail</th><th>Resultado</th></tr></thead><tbody>
          ${d.events.map(e => `<tr><td>${when(e.receivedAt)}</td><td>${esc(EVT[e.event] || e.event)}${e.value ? '<br><span class="pg-small">' + brl(e.value) + '</span>' : ''}</td><td>${esc(e.email || '—')}</td><td>${result(e.result)}</td></tr>`).join('')}
          </tbody></table>` : '<div class="pg-small">Nada recebido ainda. Depois de cadastrar o webhook no Asaas, os avisos aparecem aqui.</div>'}</div>
      </div>`;
    $('pgSave').onclick = async () => {
      try { await post('/api/admin/pagamentos/regras', { warnDays: $('pgWarn').value, downgradeDays: $('pgDown').value, graceDays: $('pgGrace').value }); MSG = 'Regras salvas.'; }
      catch(e){ MSG = e.message; }
      load();
    };
    $('pgSweep').onclick = async () => {
      try { const r = await post('/api/admin/pagamentos/verificar'); MSG = r.skipped ? 'Verificação já em andamento.' : `Verificação feita: ${r.warned} aviso(s) enviado(s), ${r.downgraded} voltaram ao Grátis, ${r.ended} cancelamento(s) encerrado(s), ${r.expiredToOverdue} marcado(s) como atrasado.`; }
      catch(e){ MSG = e.message; }
      load();
    };
    root.querySelectorAll('.pgApply').forEach(b => b.onclick = async () => {
      const box = b.closest('.pg-pend'); const email = box.querySelector('input').value.trim();
      if(!email){ MSG = 'Informe o e-mail da conta.'; return load(); }
      try { const r = await post('/api/admin/pagamentos/eventos/' + encodeURIComponent(box.dataset.id) + '/aplicar', { email }); MSG = r.result; }
      catch(e){ MSG = e.message; }
      load();
    });
  }

  async function load(){
    const root = $('pgRoot');
    try { render(await call('/api/admin/pagamentos')); }
    catch(e){ root.innerHTML = `<div class="status">${esc(e.message)}</div>`; }
  }
  window.loadPagamentos = load;
})();
