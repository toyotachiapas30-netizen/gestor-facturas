'use strict';

/* ── globals ── */
let vinData = [], kpisData = {}, procesoData = [];
let localEdits = {};
let filtered = [], currentPage = 1, pageSize = 50;
let sortCol = null, sortDir = 'asc';

const qs  = (s, c=document) => c.querySelector(s);
const qsa = (s, c=document) => [...c.querySelectorAll(s)];

/* ── toast ── */
function toast(msg, type='success') {
  const t = qs('#toast');
  t.textContent = msg; t.className = `toast show ${type}`;
  clearTimeout(t._t); t._t = setTimeout(()=>t.className='toast', 3000);
}

/* ── dates ── */
function fmtDate(v) {
  if (!v) return '—';
  const n = parseInt(v,10);
  if (!isNaN(n) && n>40000 && n<60000) {
    return new Date(Date.UTC(1900,0,n-1)).toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'});
  }
  return String(v);
}
function esc(s){ return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function pct(n,t){ return t ? (n/t*100).toFixed(1)+'%' : '0%'; }

/* ══════════════════════════════════════════
   CLOUD STORAGE (Supabase via API)
   Con fallback a localStorage si el servidor no responde
══════════════════════════════════════════ */
const API = '/api/takata';
let customVins = [];
let procesoEdits = {};

async function cloudPost(endpoint, body) {
  try {
    const r = await fetch(`${API}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error(await r.text());
    return true;
  } catch (err) {
    console.warn(`[Takata Cloud] Error en /${endpoint}:`, err.message);
    return false;
  }
}

/* Persistencia de ediciones base (contacto, cita, observacion) */
function merge(r){ const e=localEdits[r.vin]; return e ? {...r,...e} : {...r}; }

async function saveEdit(vin) {
  const e = localEdits[vin] || {};
  const ok = await cloudPost('edit', { vin, ...e });
  if (!ok) {
    // fallback: keep local copy
    localStorage.setItem('takata_edits_v2', JSON.stringify(localEdits));
  }
}

/* Persistencia de proceso */
async function saveProcesoEntry(vin) {
  const entry = procesoEdits[vin];
  if (!entry) return;
  
  // Extraer solo los campos que existen en la tabla de la nube (evitar schema errors)
  const payload = {
    vin: entry.vin,
    proceso: entry.proceso,
    cita: entry.cita,
    actualizacion: entry.actualizacion,
    unidad: entry.unidad,
    acciones: entry.acciones,
    agente: entry.agente,
    comentario: entry.comentario
  };

  const ok = await cloudPost('proceso', payload);
  if (!ok) {
    localStorage.setItem('takata_proceso_edits_v1', JSON.stringify(procesoEdits));
  }
}

async function saveProcesoEdits() {
  // llamado cuando se guarda un entry individual, ya delegamos a saveProcesoEntry
  // esta funcion se mantiene por compatibilidad con el codigo existente
}

/* Persistencia de VINs customizados */
async function saveCustomVin(nuevo) {
  const ok = await cloudPost('custom-vin', nuevo);
  if (!ok) {
    localStorage.setItem('takata_custom_vins_v1', JSON.stringify(customVins));
  }
}

/* Persistencia de reclamos de campana */
let campEdits = {};
async function saveCampEntry(mes, dealer, camp, valor) {
  const ok = await cloudPost('camp', { mes, dealer, camp, valor });
  const key = `${mes}|${dealer}|${camp}`;
  if (!ok) {
    localStorage.setItem('takata_camp_edits_v1', JSON.stringify(campEdits));
  }
  campEdits[key] = valor;
}

/* ══════════════════════════════════════════
   LOAD DATA
══════════════════════════════════════════ */
let vinDataLoaded = false; // bandera: ¿ya se cargaron los VINs?

/* ── LOGS DE PROGRESO ── */
function setStatus(msg, isError = false) {
  const b = qs('#last-updated-badge');
  if (b) {
    b.textContent = msg;
    b.style.background = isError ? '#c00' : 'rgba(255,255,255,0.1)';
    b.style.color = isError ? '#fff' : 'rgba(255,255,255,0.7)';
  }
}

async function loadAll() {
  try {
    setStatus('Conectando...');

    // 1. Cargar estado de la nube (rápido)
    const cloudResponse = await fetch(`${API}/state`, { credentials: 'same-origin' }).catch(() => null);
    if (cloudResponse && cloudResponse.ok) {
      const cloudState = await cloudResponse.json();
      localEdits   = cloudState.edits      || {};
      procesoEdits = cloudState.proceso    || {};
      customVins   = cloudState.customVins || [];
      campEdits    = cloudState.camp       || {};
      console.log('☁️ Estado cargado desde Supabase');
    } else {
      console.warn('💾 Usando datos locales (offline)');
      try { localEdits   = JSON.parse(localStorage.getItem('takata_edits_v2')        || '{}'); } catch { localEdits = {}; }
      try { procesoEdits = JSON.parse(localStorage.getItem('takata_proceso_edits_v1') || '{}'); } catch { procesoEdits = {}; }
      try { customVins   = JSON.parse(localStorage.getItem('takata_custom_vins_v1')  || '[]'); } catch { customVins = []; }
      try { campEdits    = JSON.parse(localStorage.getItem('takata_camp_edits_v1')   || '{}'); } catch { campEdits = {}; }
    }

    // 2. Cargar KPIs (rápido)
    setStatus('Cargando KPIs...');
    const kRes = await fetch('kpis_data.json', { credentials: 'same-origin' });
    if (!kRes.ok) throw new Error('No se pudo cargar kpis_data.json');
    kpisData = await kRes.json();

    // 3. Cargar Proceso (rápido)
    setStatus('Cargando proceso...');
    const pRes = await fetch('vins_proceso.json', { credentials: 'same-origin' });
    if (!pRes.ok) throw new Error('No se pudo cargar vins_proceso.json');
    procesoData = await pRes.json();

    // 4. Procesar datos de proceso
    Object.values(procesoEdits).forEach(pe => {
      const idx = procesoData.findIndex(r => r.vin === pe.vin);
      if (idx >= 0) Object.assign(procesoData[idx], pe);
      else procesoData.unshift(pe);
    });

    // 5. Inicializar UI principal
    initKpis();
    initProceso();
    
    setStatus('Actualizado: ' + new Date().toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' }));

    // 6. Cargar VINs en segundo plano (Pesado: 3MB)
    loadVinsBackground();

  } catch (err) {
    console.error('[Takata] Error crítico:', err);
    setStatus('⚠ Error de red', true);
    qs('#campaigns-body').innerHTML = `<tr><td colspan="15" style="text-align:center;padding:20px;color:#f88">
      Error al cargar datos: ${err.message}. <a href="/takata/" style="color:#fff;text-decoration:underline">Reintentar</a></td></tr>`;
  }
}

async function loadVinsBackground() {
  try {
    const r = await fetch('takata_vins.json', { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const v = await r.json();
    vinData = [...customVins, ...v];
    vinDataLoaded = true;

    // Auto-fill nombres, dealer y acciones desde la base de datos principal
    procesoData.forEach(rp => {
      const base = vinData.find(rv => rv.vin === rp.vin);
      if (base) {
        const mergedBase = merge(base); // Aplica localEdits (como dealer)
        if (!rp.cliente) rp.cliente = mergedBase.cliente;
        if (!rp.dealer) rp.dealer = mergedBase.dealer;
        if (!rp.acciones) rp.acciones = mergedBase.acciones;
      }
    });

    if (qs('#tab-matriz').classList.contains('active')) {
      initMatriz();
      qs('#tab-btn-matriz')?.classList.add('vins-ready');
    }
    
    // Forzar re-render de la tabla de proceso para mostrar los nombres recién cargados
    renderProceso();
    
    console.log(`✅ [Takata] ${vinData.length} VINs cargados en segundo plano`);
  } catch (err) {
    console.warn('[Takata] No se pudieron cargar los VINs:', err.message);
    vinDataLoaded = false;
  }
}

/* ══════════════════════════════════════════
   TAB 1 – KPIs
══════════════════════════════════════════ */
const CAMPS = ['23TA15','DSF','G0P','F0L','24TM01','23TM01'];
const MONTHS = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio'];
const OBJ = { Matriz:50, Poniente:20 };

/* ── campaign edits persistence ── */
const LS_CAMP = 'takata_camp_edits_v1';

function loadCampEdits() {
  // campEdits ya se carga desde la nube en loadAll()
  // Esta funcion se mantiene por compatibilidad
}

function saveCampEdits() {
  // Alias para compatibilidad - la persistencia real ocurre en saveCampEntry()
}

function getCampVal(mes, dealer, camp, baseVal) {
  const key = `${mes}|${dealer}|${camp}`;
  return campEdits[key] !== undefined ? campEdits[key] : (baseVal || 0);
}

function initKpis() {
  loadCampEdits();
  const monthSel = qs('#month-select');

  // Seleccionar mes actual automáticamente
  const meses = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
  const mesActual = meses[new Date().getMonth()];
  const opcionMes = Array.from(monthSel.options).find(o => o.value === mesActual);
  if (opcionMes) opcionMes.selected = true;

  monthSel.addEventListener('change', e => renderCampaignsTable(e.target.value));
  renderCampaignsTable(monthSel.value);
}

function renderKpiCards(mes) {
  const d = kpisData.data?.[mes] || {};
  ['Matriz','Poniente'].forEach(dealer => {
    const vals = d[dealer] || {};
    // Sum from base data merged with edits
    const total = CAMPS.reduce((s,c) => s + parseInt(getCampVal(mes, dealer, c, vals[c])), 0);
    const obj   = OBJ[dealer];
    const falt  = Math.max(0, obj - total);
    const pPct  = Math.min(100, Math.round(total/obj*100));
    const dl    = dealer.toLowerCase();
    
    qs(`#total-${dl}`).textContent   = total;
    qs(`#goal-${dl}`).textContent    = obj;
    qs(`#pct-${dl}`).textContent     = pPct+'%';
    qs(`#bar-${dl}`).style.width     = pPct+'%';
    qs(`#faltantes-${dl}`).textContent = falt;
  });
}

function renderCampaignsTable(activeMes) {
  const tbody = qs('#campaigns-body');
  const tfoot = qs('#campaigns-tfoot');
  const d = kpisData.data || {};
  const TM_CAMPS = new Set(['24TM01','23TM01']);

  const rows = CAMPS.map(camp => {
    const isTM = TM_CAMPS.has(camp);
    let cells = `<td style="font-size:.82rem; font-weight: 600;">${isTM ? `<span class="camp-badge-tm">${esc(camp)}</span>` : esc(camp)}</td>`;
    
    MONTHS.forEach(mes => {
      const vals = d[mes] || {};
      const baseM = (vals.Matriz || {})[camp] || 0;
      const baseP = (vals.Poniente || {})[camp] || 0;
      
      const valM = getCampVal(mes, 'Matriz', camp, baseM);
      const valP = getCampVal(mes, 'Poniente', camp, baseP);
      
      const isActive = mes === activeMes;
      const hl = isActive ? 'background:rgba(255,255,255,0.06); outline: 1px solid rgba(255,255,255,0.1);' : '';
      
      cells += `
        <td class="camp-val sub-matriz ${valM ? 'has-val' : 'no-val'}" 
            contenteditable="true" 
            style="${hl}" 
            data-mes="${mes}" data-dealer="Matriz" data-camp="${camp}">
          ${valM || (isActive ? '0' : '—')}
        </td>
        <td class="camp-val sub-poniente ${valP ? 'has-val' : 'no-val'}" 
            contenteditable="true" 
            style="${hl}" 
            data-mes="${mes}" data-dealer="Poniente" data-camp="${camp}">
          ${valP || (isActive ? '0' : '—')}
        </td>`;
    });
    return `<tr>${cells}</tr>`;
  });
  tbody.innerHTML = rows.join('');

  // Event listeners for edits
  qsa('[contenteditable="true"]', tbody).forEach(cell => {
    cell.addEventListener('input', e => {
      const { mes, dealer, camp } = e.target.dataset;
      let val = e.target.textContent.trim();
      val = val.replace(/[^0-9]/g, '');
      if (val === '') val = '0';
      const numVal = parseInt(val);
      const key = `${mes}|${dealer}|${camp}`;
      campEdits[key] = numVal;

      // Guardar en la nube
      saveCampEntry(mes, dealer, camp, numVal);
      updateTableTotals();
      renderKpiCards(qs('#month-select').value);

      e.target.classList.toggle('no-val', numVal === 0);
      e.target.classList.toggle('has-val', numVal > 0);
    });

    // Cleanup on blur
    cell.addEventListener('blur', e => {
      if (e.target.textContent.trim() === '') e.target.textContent = '0';
    });
  });

  updateTableTotals();
  renderKpiCards(activeMes);
}

function updateTableTotals() {
  const tfoot = qs('#campaigns-tfoot');
  const d = kpisData.data || {};
  
  let totRow = '<tr class="row-total"><td>Suma reclamadas</td>';
  let faltRow = '<tr class="row-faltantes"><td>Faltantes</td>';
  
  MONTHS.forEach(mes => {
    const vals = d[mes] || {};
    ['Matriz', 'Poniente'].forEach(dealer => {
      // Sum merged values
      const tot = CAMPS.reduce((s, camp) => {
        const baseVal = (vals[dealer] || {})[camp] || 0;
        return s + parseInt(getCampVal(mes, dealer, camp, baseVal));
      }, 0);
      
      const obj = OBJ[dealer];
      const falt = Math.max(0, obj - tot);
      const dl = dealer === 'Matriz' ? 'sub-matriz' : 'sub-poniente';
      
      // Color logic: if falt > 0, use dealer identity color, if 0 use green
      const colorStyle = falt > 0 
        ? (dealer === 'Matriz' ? '#ff4d4d' : '#5dade2')
        : '#1db954';

      totRow  += `<td class="${dl} camp-val has-val" style="text-align:center;">${tot}</td>`;
      faltRow += `<td class="${dl} camp-val" style="text-align:center; color:${colorStyle}; font-weight: 800;">${falt}</td>`;
    });
  });
  
  totRow += '</tr>'; 
  faltRow += '</tr>';
  tfoot.innerHTML = totRow + faltRow;
}

/* ══════════════════════════════════════════
   TAB 2 – VINs EN PROCESO
══════════════════════════════════════════ */
const PROC_COLORS = {
  'NO SHOW':                 { bg:'FFC00000', css:'#C00000', cls:'badge-noshow',   row:'proc-noshow'   },
  'EN PROCESO':              { bg:'FFFFFF00', css:'#FFD700', cls:'badge-proceso',  row:'proc-proceso'  },
  'EN ESPERA DE REFACCIONES':{ bg:'FF3498DB', css:'#3498DB', cls:'badge-refac',    row:'proc-refac'    },
  'REALIZADO Y RECLAMADO':   { bg:'FF27AE60', css:'#27AE60', cls:'badge-realizado',row:'proc-realizado'},
};

function getProcInfo(p) {
  const key = Object.keys(PROC_COLORS).find(k => p.trim().toUpperCase().includes(k)) || '';
  return PROC_COLORS[key] || { css:'#5a6080', cls:'badge-sininfo', row:'' };
}

function initProceso() {
  // populate agentes
  const agentes = [...new Set(procesoData.map(r=>r.agente).filter(Boolean))].sort();
  const sel = qs('#filter-agente');
  agentes.forEach(a => { const o=document.createElement('option'); o.value=a; o.textContent=a; sel.appendChild(o); });

  qs('#filter-proceso').addEventListener('change', renderProceso);
  qs('#filter-agente').addEventListener('change', renderProceso);
  qs('#btn-export-proceso').addEventListener('click', exportProceso);
  
  // Multi-select actions logic
  document.addEventListener('click', e => {
    if (!e.target.closest('.actions-multi-container')) {
      qsa('.actions-dropdown').forEach(d => d.style.display = 'none');
    }
  });

  renderProceso();
}

function renderProceso() {
  const fp = qs('#filter-proceso').value.toLowerCase();
  const fa = qs('#filter-agente').value;
  const rows = procesoData.filter(r =>
    (!fp || r.proceso.toLowerCase().includes(fp)) &&
    (!fa || r.agente === fa)
  );

  // mini KPI chips
  const counts = {};
  Object.keys(PROC_COLORS).forEach(k => counts[k]=0);
  procesoData.forEach(r => {
    const key = Object.keys(PROC_COLORS).find(k=>r.proceso.toUpperCase().includes(k));
    if (key) counts[key]++;
  });
  qs('#proceso-kpis').innerHTML = Object.entries(PROC_COLORS).map(([k,v])=>
    `<div class="proceso-kpi-item">
      <div class="pkpi-dot" style="background:${v.css};box-shadow:0 0 5px ${v.css}"></div>
      <div><div class="pkpi-label">${k}</div><div class="pkpi-val">${counts[k]}</div></div>
    </div>`
  ).join('');

  // ── Contador de acciones de servicio por tipo ──
  const ALL_ACTIONS = ['23TA15','DSF','G0P','F0L','24TM01','23TM01','C0M','E0M','HMA'];
  const actionColors = {
    '23TA15':'#EB001B','DSF':'#3498DB','G0P':'#27AE60','F0L':'#9B59B6',
    '24TM01':'#E67E22','23TM01':'#E91E63','C0M':'#00BCD4','E0M':'#FF9800','HMA':'#8BC34A'
  };
  const actionCounts = {};
  ALL_ACTIONS.forEach(a => actionCounts[a] = 0);
  procesoData.forEach(r => {
    const parts = (r.acciones || '').split(/[,+]/).map(s => s.trim().replace('ACS ','').toUpperCase());
    parts.forEach(p => { if (actionCounts[p] !== undefined) actionCounts[p]++; });
  });
  const accionesEl = qs('#acciones-kpis');
  if (accionesEl) {
    const totalAcciones = Object.values(actionCounts).reduce((s, n) => s + n, 0);
    const chips = ALL_ACTIONS
      .filter(a => actionCounts[a] > 0)
      .map(a => {
        const col = actionColors[a] || '#888';
        return `<div style="
          display:flex; align-items:center; gap:6px;
          background:${col}18; border:1px solid ${col}44;
          border-radius:999px; padding:4px 12px;
          font-size:.72rem; font-weight:700; color:${col};
        ">
          <span style="width:8px;height:8px;border-radius:50%;background:${col};flex-shrink:0"></span>
          ${a} <span style="font-size:.85rem;margin-left:2px">${actionCounts[a]}</span>
        </div>`;
      });

    // Chip de TOTAL al final
    chips.push(`<div style="
      display:flex; align-items:center; gap:6px;
      background:rgba(241,196,15,0.15); border:1.5px solid #F1C40F;
      border-radius:999px; padding:4px 14px;
      font-size:.72rem; font-weight:800; color:#F1C40F;
      margin-left:4px;
    ">
      <span style="width:8px;height:8px;border-radius:50%;background:#F1C40F;flex-shrink:0"></span>
      TOTAL <span style="font-size:.9rem;margin-left:4px">${totalAcciones}</span>
    </div>`);

    accionesEl.innerHTML = chips.join('');
  }

  const tbody = qs('#proceso-body');
  if (!rows.length) { tbody.innerHTML='<tr class="no-results-row"><td colspan="9">Sin registros</td></tr>'; return; }

  tbody.innerHTML = rows.map((r,i) => {
    const info = getProcInfo(r.proceso);
    const badge = `
      <select class="status-select ${info.cls}" data-vin="${esc(r.vin)}" style="border:1px solid ${info.css}22; background:${info.css}11; color:${info.css}; font-weight:700; border-radius:999px; padding:2px 8px; cursor:pointer; font-size:.72rem; outline:none">
        <option value="" ${!r.proceso?'selected':''}>— Sin info —</option>
        ${Object.keys(PROC_COLORS).map(status => 
          `<option value="${status}" ${r.proceso.toUpperCase().includes(status)?'selected':''}>${status}</option>`
        ).join('')}
      </select>`;

    // Multi-select for Actions
    const allPossibleActions = ['23TA15','DSF','G0P','F0L','24TM01','23TM01','C0M','E0M','HMA'];
    const currentActions = (r.acciones || '').split(/[,+]/).map(s => s.trim().replace('ACS ', '')).filter(Boolean);
    const actionsCount = currentActions.length;
    
    const actionsHtml = `
      <div class="actions-multi-container" style="position:relative; display:inline-block">
        <div class="actions-trigger" data-vin="${esc(r.vin)}" style="cursor:pointer; background:var(--bg-input); padding:4px 10px; border-radius:6px; font-size:.73rem; border:1px solid var(--border); display:flex; align-items:center; gap:6px">
          <span style="max-width:120px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${currentActions.join(', ') || 'Sin acciones'}</span>
          ${actionsCount > 0 ? `<b style="background:var(--red); color:white; border-radius:50%; width:18px; height:18px; display:flex; align-items:center; justify-content:center; font-size:.65rem">${actionsCount}</b>` : ''}
        </div>
        <div class="actions-dropdown" id="drop-${esc(r.vin)}" style="display:none; position:absolute; top:100%; left:0; z-index:100; background:var(--bg-surface); border:1px solid var(--border); border-radius:8px; box-shadow:0 10px 30px rgba(0,0,0,.2); padding:10px; min-width:180px">
          <div style="font-weight:700; font-size:.7rem; margin-bottom:8px; color:var(--text-3); text-transform:uppercase">Seleccionar Acciones</div>
          ${allPossibleActions.map(act => `
            <label style="display:flex; align-items:center; gap:8px; padding:4px 0; cursor:pointer; font-size:.75rem">
              <input type="checkbox" class="action-check" data-vin="${esc(r.vin)}" data-action="${act}" ${currentActions.includes(act)?'checked':''}>
              ${act}
            </label>
          `).join('')}
        </div>
      </div>
    `;

    return `<tr class="${info.row}" data-vin="${esc(r.vin)}">
      <td class="muted">${i+1}</td>
      <td class="td-vin">${esc(r.vin)}</td>
      <td style="min-width:150px;max-width:250px;line-height:1.3" title="${esc(r.cliente)}">${esc(r.cliente)||'—'}</td>
      <td>${badge}</td>
      <td class="muted">${r.cita||'—'}</td>
      <td class="muted" style="color:#3498DB">${esc(r.dealer)||'—'}</td>
      <td class="muted"><span class="editable-cell" contenteditable="true" data-vin="${esc(r.vin)}" data-field="actualizacion" style="background:var(--bg-input);border-radius:4px;padding:2px 8px;font-size:.75rem;display:inline-block;min-width:75px">${r.actualizacion ? esc(r.actualizacion) : '—'}</span></td>
      <td>${esc(r.unidad)}</td>
      <td class="muted">${actionsHtml}</td>
      <td><span class="editable-cell" contenteditable="true" data-vin="${esc(r.vin)}" data-field="agente" style="background:var(--bg-input);border-radius:4px;padding:2px 8px;font-size:.75rem;display:inline-block;min-width:60px">${esc(r.agente)}</span></td>
      <td class="muted" style="min-width:200px;max-width:350px;line-height:1.3"><div class="editable-cell" contenteditable="true" data-vin="${esc(r.vin)}" data-field="comentario" style="min-width:100%;min-height:1em;word-wrap:break-word">${esc(r.comentario)||''}</div></td>
      <td>
        <button class="btn-delete-proceso" data-vin="${esc(r.vin)}" title="Eliminar de Proceso" style="background:transparent; border:none; color:var(--red); cursor:pointer; font-size:1.1rem; padding:4px; opacity:0.6; transition:opacity 0.2s;">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
        </button>
      </td>
    </tr>`;
  }).join('');

  // Bind dropdown triggers
  qsa('.actions-trigger').forEach(trigger => {
    trigger.addEventListener('click', e => {
      e.stopPropagation();
      const vin = trigger.dataset.vin;
      qsa('.actions-dropdown').forEach(d => d.style.display = 'none'); // close others
      qs(`#drop-${vin}`).style.display = 'block';
    });
  });

  // Bind checkbox changes
  qsa('.action-check').forEach(check => {
    check.addEventListener('change', e => {
      const vin = check.dataset.vin;
      const selected = [...document.querySelectorAll(`.action-check[data-vin="${vin}"]:checked`)].map(c => c.dataset.action);
      updateVinActions(vin, selected.join(', '));
    });
  });

  // Bind status changes
  qsa('.status-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const vin = e.target.dataset.vin;
      const newStatus = e.target.value;
      updateVinProceso(vin, newStatus);
    });
  });

  // Bind direct edits (Agente / Comentario)
  qsa('.editable-cell').forEach(cell => {
    cell.addEventListener('blur', e => {
      const vin = cell.dataset.vin;
      const field = cell.dataset.field;
      const newValue = cell.textContent.trim();
      updateVinField(vin, field, newValue);
    });
    // Prevent enter from creating new lines in small cells
    cell.addEventListener('keydown', e => {
      if (e.key === 'Enter' && cell.dataset.field === 'agente') {
        e.preventDefault();
        cell.blur();
      }
    });
  });

  // Bind delete buttons
  qsa('.btn-delete-proceso').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const vin = btn.dataset.vin;
      if (confirm(`¿Estás seguro de que deseas eliminar el VIN ${vin} del seguimiento de proceso?`)) {
        deleteProcesoEntry(vin);
      }
    });
    // Add hover effect
    btn.addEventListener('mouseenter', () => btn.style.opacity = '1');
    btn.addEventListener('mouseleave', () => btn.style.opacity = '0.6');
  });
}

async function deleteProcesoEntry(vin) {
  // 1. Remover de memoria
  delete procesoEdits[vin];
  const idx = procesoData.findIndex(r => r.vin === vin);
  if (idx >= 0) {
    procesoData.splice(idx, 1);
  }
  
  // Regresar a la base de datos como NO CONTACTADO
  localEdits[vin] = { ...(localEdits[vin] || {}), contactado: 'NO CONTACTADO', cita: '', observacion: '' };
  saveEdit(vin);
  applyFilters(); // Refrescar la tabla base de datos
  
  // 2. Guardar en localStorage
  saveProcesoEdits();
  
  // 3. Renderizar vista inmediatamente
  renderProceso();
  
  // 4. Borrar de la BD (Supabase)
  try {
    const res = await fetch(`/api/takata/proceso/${vin}`, {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' }
    });
    if (!res.ok) throw new Error('Error al borrar en BD');
    toast('✔ VIN eliminado de Proceso');
  } catch(e) {
    console.error('Error deleteProcesoEntry:', e);
    toast('⚠️ Error al eliminar en la nube, pero se ocultó localmente');
  }
}

function updateVinField(vin, field, value) {
  const idx = procesoData.findIndex(r => r.vin === vin);
  if (idx < 0) return;

  let finalValue = value;
  if (finalValue === '—') finalValue = '';

  if (procesoData[idx][field] === finalValue) return;

  const update = {
    ...procesoData[idx],
    [field]: finalValue
  };

  if (field !== 'actualizacion') {
    update.actualizacion = new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'});
  }

  procesoData[idx] = update;
  procesoEdits[vin] = update;
  // Guardar en la nube
  saveProcesoEntry(vin);

  toast(`✔ ${field.charAt(0).toUpperCase() + field.slice(1)} actualizado`);
}

function updateVinProceso(vin, status) {
  const idx = procesoData.findIndex(r => r.vin === vin);
  if (idx < 0) return;

  const update = {
    ...procesoData[idx],
    proceso: status,
    actualizacion: new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'})
  };

  procesoData[idx] = update;
  procesoEdits[vin] = update;
  // Guardar en la nube
  saveProcesoEntry(vin);

  renderProceso();
  toast('✔ Estado actualizado');
}

function updateVinActions(vin, actionsString) {
  const idx = procesoData.findIndex(r => r.vin === vin);
  if (idx < 0) return;

  const update = {
    ...procesoData[idx],
    acciones: actionsString,
    actualizacion: new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'})
  };

  procesoData[idx] = update;
  procesoEdits[vin] = update;
  // Guardar en la nube
  saveProcesoEntry(vin);

  renderProceso();
  toast('✔ Acciones actualizadas');
}

function exportProceso() {
  const hdr = ['VIN','Cliente','Proceso','Fecha Cita','Distribuidor','Fecha Actualización','Unidad','Acciones','Agente','Comentario'];
  const fp = qs('#filter-proceso').value.toLowerCase();
  const fa = qs('#filter-agente').value;
  const rows = procesoData.filter(r=>(!fp||r.proceso.toLowerCase().includes(fp))&&(!fa||r.agente===fa));
  const csv = [hdr.join(','), ...rows.map(r=>[r.vin,r.cliente,r.proceso,r.cita,r.dealer,r.actualizacion,r.unidad,r.acciones,r.agente,r.comentario].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(','))].join('\r\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
  a.download=`takata_proceso_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  toast(`📥 ${rows.length} registros exportados`);
}

/* ══════════════════════════════════════════
   TAB 3 – BASE MATRIZ
══════════════════════════════════════════ */
function initMatriz() {
  // populate selects
  const estados  = [...new Set(vinData.map(r=>r.estado ).filter(Boolean))].sort();
  const modelos  = [...new Set(vinData.map(r=>r.descripcion).filter(Boolean))].sort();
  const selE = qs('#filter-estado'), selM = qs('#filter-modelo');
  estados.forEach(e=>{ const o=document.createElement('option'); o.value=e; o.textContent=e; selE.appendChild(o); });
  modelos.forEach(m=>{ const o=document.createElement('option'); o.value=m; o.textContent=m; selM.appendChild(o); });

  // bind
  let debounce;
  qs('#search-input').addEventListener('input', ()=>{ clearTimeout(debounce); debounce=setTimeout(applyFilters,220); });
  qs('#search-clear').addEventListener('click', ()=>{ qs('#search-input').value=''; applyFilters(); });
  ['#filter-estado','#filter-contacto','#filter-modelo'].forEach(s=>qs(s).addEventListener('change',applyFilters));
  qs('#btn-reset').addEventListener('click',()=>{
    qs('#search-input').value='';
    qs('#filter-estado').value=''; qs('#filter-contacto').value=''; qs('#filter-modelo').value='';
    sortCol=null; sortDir='asc';
    qsa('th.sortable').forEach(t=>t.classList.remove('sort-asc','sort-desc'));
    applyFilters();
  });
  qs('#btn-export').addEventListener('click', exportCSV);
  qs('#btn-prev').addEventListener('click', ()=>{ if(currentPage>1){ currentPage--; renderTable(); renderPagination(); updateCount(); } });
  qs('#btn-next').addEventListener('click', ()=>{
    const pages=Math.ceil(filtered.length/pageSize);
    if(currentPage<pages){ currentPage++; renderTable(); renderPagination(); updateCount(); }
  });
  qs('#page-size-select').addEventListener('change', e=>{ pageSize=parseInt(e.target.value); currentPage=1; renderTable(); renderPagination(); updateCount(); });
  qsa('th.sortable').forEach(th=>th.addEventListener('click',()=>sortBy(th.dataset.col)));

  applyFilters();
}

function applyFilters() {
  const q  = qs('#search-input').value.trim().toLowerCase();
  const fe = qs('#filter-estado').value;
  const fc = qs('#filter-contacto').value;
  const fm = qs('#filter-modelo').value;
  qs('#search-clear').style.display = q?'block':'none';

  const merged = vinData.map(merge);
  filtered = merged.filter(r=>{
    if (fe && r.estado!==fe) return false;
    if (fc && r.contactado!==fc) return false;
    if (fm && r.descripcion!==fm) return false;
    if (q && ![r.vin,r.cliente,r.descripcion,r.ciudad,r.estado,r.observacion].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });

  if (sortCol) sortFiltered();
  currentPage=1;
  updateBaseKpis(merged);
  renderTable(); renderPagination(); updateCount();
}

function updateBaseKpis(rows) {
  const total   = rows.length;
  const conCita = rows.filter(r => r.cita && r.cita !== '').length;
  const contPuro= rows.filter(r => r.contactado === 'CONTACTADO' && !(r.cita && r.cita !== '')).length;
  const cont    = contPuro + conCita; // Contactados + Con Cita juntos
  const noCont  = total - cont;
  const progP   = total ? Math.round(cont / total * 100) : 0;

  qs('#base-kpis-grid').innerHTML = [
    {label:'Total VINs',   val:total.toLocaleString('es-MX'),  cls:'kpi-c1', p:''},
    {label:'Contactados',  val:cont.toLocaleString('es-MX'),   cls:'kpi-c2', p:pct(cont,total), tip:'Incluye con cita'},
    {label:'Sin Contactar',val:noCont.toLocaleString('es-MX'), cls:'kpi-c3', p:pct(noCont,total)},
    {label:'Con Cita',     val:conCita.toLocaleString('es-MX'),cls:'kpi-c4', p:pct(conCita,total)},
  ].map(k=>`<div class="kpi-card ${k.cls}" title="${k.tip||''}">
    <div class="kpi-body"><span class="kpi-label">${k.label}</span><span class="kpi-value">${k.val}</span>${k.p?`<span class="kpi-pct">${k.p}</span>`:''}</div>
  </div>`).join('');

  qs('#progress-bar-fill').style.width = progP+'%';
  qs('#progress-pct-label').textContent = progP+'%';
  qs('#matriz-summary').textContent = `${total.toLocaleString('es-MX')} VINs totales`;
}

function sortFiltered() {
  filtered.sort((a,b)=>{
    let va=a[sortCol]??'', vb=b[sortCol]??'';
    if (sortCol==='modelo'){ va=parseInt(va)||0; vb=parseInt(vb)||0; return sortDir==='asc'?va-vb:vb-va; }
    va=String(va).toLowerCase(); vb=String(vb).toLowerCase();
    return sortDir==='asc'?(va<vb?-1:va>vb?1:0):(va>vb?-1:va<vb?1:0);
  });
}

function sortBy(col) {
  sortDir = sortCol===col ? (sortDir==='asc'?'desc':'asc') : 'asc';
  sortCol = col;
  qsa('th.sortable').forEach(t=>t.classList.remove('sort-asc','sort-desc'));
  const th=qs(`th[data-col="${col}"]`); if(th) th.classList.add(sortDir==='asc'?'sort-asc':'sort-desc');
  sortFiltered(); currentPage=1; renderTable(); renderPagination();
}

function getContactBadge(r) {
  if (r.cita&&r.cita!=='') return `<span class="status-badge badge-cita"><span class="status-dot" style="background:#F1C40F"></span>Con Cita</span>`;
  if (r.contactado==='CONTACTADO') return `<span class="status-badge badge-contactado"><span class="status-dot dot-green"></span>Contactado</span>`;
  return `<span class="status-badge badge-no-contact"><span class="status-dot dot-red"></span>Sin Contactar</span>`;
}

function getRowBorder(r) {
  if (r.cita&&r.cita!=='') return 'border-left:3px solid #F1C40F';
  if (r.contactado==='CONTACTADO') return 'border-left:3px solid #1db954';
  return 'border-left:3px solid #e74c3c';
}

function renderTable() {
  const tbody = qs('#table-body');
  if (!filtered.length) { tbody.innerHTML='<tr class="no-results-row"><td colspan="12">🔍 Sin resultados</td></tr>'; return; }
  const start=(currentPage-1)*pageSize;
  const page=filtered.slice(start,start+pageSize);
  tbody.innerHTML = page.map((r,i)=>{
    const gi=start+i+1;
    const hasEdits=!!localEdits[r.vin];
    return `<tr data-vin="${esc(r.vin)}" style="${getRowBorder(r)}">
      <td class="muted" style="font-size:.7rem">${gi}</td>
      <td class="td-vin">${esc(r.vin)}${hasEdits?' <span style="color:#F1C40F" title="Editado">✎</span>':''}</td>
      <td>${esc(r.descripcion)}</td>
      <td class="muted">${esc(r.modelo)}</td>
      <td style="min-width:180px;max-width:280px;line-height:1.3">${esc(r.cliente)}</td>
      <td class="muted">${esc(r.ciudad)}</td>
      <td class="muted">${esc(r.estado)}</td>
      <td class="muted">${getContactBadge(r)}</td>
      <td class="muted"><span class="editable-base" contenteditable="true" data-vin="${esc(r.vin)}" data-field="cita" style="color:#F1C40F;min-width:80px;display:inline-block">${r.cita?esc(fmtDate(r.cita)):'—'}</span></td>
      <td class="muted"><span class="editable-base" data-vin="${esc(r.vin)}" data-field="dealer" style="min-width:80px;display:inline-block">${esc(r.dealer)||'—'}</span></td>
      <td class="muted"><span style="background:var(--bg-input);border-radius:4px;padding:2px 6px;font-size:0.75rem;font-weight:600">${esc(r.acciones)||'—'}</span></td>
      <td class="muted" style="min-width:180px;max-width:320px;line-height:1.3" title="${esc(r.observacion)}">
        <div class="editable-base" contenteditable="true" data-vin="${esc(r.vin)}" data-field="observacion" style="min-width:100px;min-height:1em">${esc(r.observacion)||''}</div>
      </td>
      <td><button class="btn-action" data-vin="${esc(r.vin)}">Ver detalle</button></td>
    </tr>`;
  }).join('');

  qsa('#table-body tr[data-vin]').forEach(row=>{
    row.addEventListener('click', e=>{
      if (e.target.classList.contains('editable-base') || e.target.closest('.editable-base')) return; // ignore clicks in editable cells
      if(e.target.classList.contains('btn-action')) openModal(e.target.dataset.vin);
      else openModal(row.dataset.vin);
    });
  });

  // Bind direct edits for Base de Datos
  qsa('.editable-base').forEach(cell => {
    cell.addEventListener('blur', e => {
      const vin = cell.dataset.vin;
      const field = cell.dataset.field;
      let newValue = cell.textContent.trim();
      if (newValue === '—') newValue = '';
      updateBaseField(vin, field, newValue);
    });
    cell.addEventListener('keydown', e => {
      if(e.key === 'Enter') { e.preventDefault(); cell.blur(); }
    });
  });
}

function updateBaseField(vin, field, value) {
  let finalValue = value;
  if (field === 'cita' && value) {
    const parts = value.split('/');
    if (parts.length === 3) {
      const [d,m,y] = parts;
      if (y.length === 4) finalValue = `${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}`;
    }
  }

  const current = localEdits[vin] || {};
  if (current[field] === finalValue) return;

  localEdits[vin] = { ...current, [field]: finalValue };

  // Guardar en la nube
  saveEdit(vin);

  if (field === 'cita' && finalValue) {
    currentVin = vin;
    syncToProceso(vin, finalValue, localEdits[vin].observacion || '');
    currentVin = null;
  }

  toast(`✔ ${field === 'cita' ? 'Cita' : 'Observación'} actualizada`);
  applyFilters();
}

function syncToProceso(vin, citaRaw, obs) {
  const base = vinData.find(r => r.vin === vin) || {};
  const merged = { ...base, ...localEdits[vin] };
  const existing = procesoEdits[vin];
  
  let citaDisplay = '';
  if (citaRaw) {
    const [y,m,d] = citaRaw.split('-');
    citaDisplay = `${d}/${m}/${y}`;
  }

  const procesoEntry = {
    vin:         vin,
    cliente:     merged.cliente || '',
    proceso:     existing?.proceso || 'EN PROCESO',
    cita:        citaDisplay,
    dealer:      merged.dealer || '',
    actualizacion: new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'}),
    unidad:      `${merged.descripcion||''} ${merged.modelo||''}`.trim(),
    acciones:    merged.acciones || '23TA15',
    agente:      merged.agente   || '',
    comentario:  obs || merged.observacion || '',
  };

  procesoEdits[vin] = procesoEntry;
  saveProcesoEdits();

  const idx = procesoData.findIndex(r => r.vin === vin);
  if (idx >= 0) Object.assign(procesoData[idx], procesoEntry);
  else procesoData.unshift(procesoEntry);
  renderProceso();
}

function renderPagination() {
  const total=filtered.length, pages=Math.ceil(total/pageSize);
  const wrap=qs('#pagination-wrap');
  if(pages<=1){ wrap.style.display='none'; return; }
  wrap.style.display='flex';
  qs('#btn-prev').disabled=currentPage===1;
  qs('#btn-next').disabled=currentPage===pages;
  const pn=qs('#page-numbers'); pn.innerHTML='';
  buildPageRange(currentPage,pages).forEach(item=>{
    if(item==='…'){ const s=document.createElement('span'); s.className='page-ellipsis'; s.textContent='…'; pn.appendChild(s); }
    else { const b=document.createElement('button'); b.className='page-btn'+(item===currentPage?' active':''); b.textContent=item; b.addEventListener('click',()=>{ currentPage=item; renderTable(); renderPagination(); updateCount(); }); pn.appendChild(b); }
  });
}

function buildPageRange(c,t) {
  if(t<=7) return Array.from({length:t},(_,i)=>i+1);
  const r=[1]; if(c>3) r.push('…');
  for(let i=Math.max(2,c-1);i<=Math.min(t-1,c+1);i++) r.push(i);
  if(c<t-2) r.push('…'); r.push(t); return r;
}

function updateCount() {
  const start=(currentPage-1)*pageSize+1, end=Math.min(currentPage*pageSize,filtered.length);
  qs('#results-count').textContent = filtered.length
    ? `Mostrando ${start}–${end} de ${filtered.length.toLocaleString('es-MX')} VINs${filtered.length<vinData.length?` (de ${vinData.length.toLocaleString('es-MX')} totales)`:''}`
    : 'Sin resultados';
}

function exportCSV() {
  const hdr=['VIN','Descripcion','Modelo','Cliente','Ciudad','Estado','CP','Email','TelCel','TelCasa','Contactado','Cita','Distribuidor','Observacion'];
  const csv=[hdr.join(','),...filtered.map(r=>[r.vin,r.descripcion,r.modelo,r.cliente,r.ciudad,r.estado,r.cp,r.email,r.telcel,r.telcasa,r.contactado,fmtDate(r.cita),r.dealer,r.observacion].map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(','))].join('\r\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob(['\uFEFF'+csv],{type:'text/csv;charset=utf-8'}));
  a.download=`takata_matriz_${new Date().toISOString().slice(0,10)}.csv`; a.click();
  toast(`📥 ${filtered.length} registros exportados`);
}

/* ── Modal ── */
let currentVin=null;
function openModal(vin) {
  const base=vinData.find(r=>r.vin.trim()===vin.trim()); if(!base) return;
  currentVin=base.vin; const r=merge(base);
  const c = r.contactado || 'NO CONTACTADO';
  const dotColor = c === 'CON CITA' ? '#F1C40F' : (c === 'CONTACTADO' ? '#1db954' : '#e74c3c');
  qs('#modal-status-dot').style.cssText=`background:${dotColor};box-shadow:0 0 8px ${dotColor};width:14px;height:14px;border-radius:50%;margin-top:5px;flex-shrink:0`;
  qs('#modal-title').textContent=r.vin;
  qs('#modal-sub').textContent=`${r.descripcion} ${r.modelo}`.trim();
  const tel=[r.telcel?`<a href="tel:${r.telcel}">${r.telcel}</a> (cel)`:'',r.telcasa?`<a href="tel:${r.telcasa}">${r.telcasa}</a> (casa)`:'',r.telofic?`<a href="tel:${r.telofic}">${r.telofic}</a> (ofic)`:''].filter(Boolean).join('<br>');
  qs('#modal-body').innerHTML=`
    <div class="modal-field"><span class="field-label">VIN</span><span class="field-value" style="font-family:monospace;font-size:.8rem">${esc(r.vin)}</span></div>
    <div class="modal-field"><span class="field-label">Vehículo</span><span class="field-value">${esc(r.descripcion)} · ${esc(r.modelo)}</span></div>
    <div class="modal-field full-width"><span class="field-label">Cliente</span><span class="field-value">${esc(r.cliente)}</span></div>
    <div class="modal-field full-width"><span class="field-label">Dirección</span><span class="field-value">${esc([r.direccion,r.colonia,r.ciudad,r.estado,r.cp].filter(Boolean).join(', '))}</span></div>
    <div class="modal-field"><span class="field-label">Teléfonos</span><span class="field-value">${tel||'—'}</span></div>
    <div class="modal-field"><span class="field-label">Email</span><span class="field-value">${r.email?`<a href="mailto:${esc(r.email)}">${esc(r.email)}</a>`:'—'}</span></div>
    <div class="modal-field"><span class="field-label">Cita</span><span class="field-value" style="color:#F1C40F">${fmtDate(r.cita)}</span></div>
    <div class="modal-field"><span class="field-label">Distribuidor</span><span class="field-value" style="color:#3498DB">${esc(r.dealer)||'—'}</span></div>
    <div class="modal-field full-width"><span class="field-label">Observación</span><span class="field-value">${esc(r.observacion)||'—'}</span></div>`;
  qs('#modal-contacto-select').value=r.contactado||'NO CONTACTADO';
  qs('#modal-dealer-select').value=localEdits[r.vin]?.dealer||r.dealer||'';
  qs('#modal-obs-input').value=localEdits[r.vin]?.observacion??r.observacion??'';
  // Pre-fill cita: stored as yyyy-mm-dd in localEdits, or empty
  const citaVal = localEdits[r.vin]?.cita ?? '';
  qs('#modal-cita-input').value = citaVal;
  qs('#modal-overlay').style.display='flex';
}
function closeModal(){ qs('#modal-overlay').style.display='none'; currentVin=null; }

function saveModal(){
  if(!currentVin) return;
  const contactado = qs('#modal-contacto-select').value;
  const dealer = qs('#modal-dealer-select').value;
  const observacion = qs('#modal-obs-input').value.trim();
  const citaRaw = qs('#modal-cita-input').value.trim(); // yyyy-mm-dd or empty

  // Format date for display
  let citaDisplay = '';
  if (citaRaw) {
    const [y,m,d] = citaRaw.split('-');
    citaDisplay = `${d}/${m}/${y}`;
  }

  // Save to localEdits
  localEdits[currentVin] = {
    ...localEdits[currentVin],
    contactado,
    dealer,
    observacion,
    cita: citaRaw,
  };
  
  // Guardar en localStorage inmediatamente
  localStorage.setItem('takata_edits_v2', JSON.stringify(localEdits));

  // ─── Auto-sync to VINs en Proceso ───
  if (citaRaw) {
    const base = vinData.find(r => r.vin === currentVin) || {};
    const merged = { ...base, ...localEdits[currentVin] };
    const existing = procesoEdits[currentVin];

    const procesoEntry = {
      vin:         currentVin,
      cliente:     merged.cliente || '',
      proceso:     existing?.proceso || 'EN PROCESO',
      cita:        citaDisplay,
      dealer:      dealer,
      actualizacion: new Date().toLocaleDateString('es-MX',{day:'2-digit',month:'2-digit',year:'numeric'}),
      unidad:      `${merged.descripcion||''} ${merged.modelo||''}`.trim(),
      acciones:    merged.acciones || '23TA15',
      agente:      merged.agente   || '',
      comentario:  merged.observacion || '',
    };

    // Store in persistent proceso edits
    procesoEdits[currentVin] = procesoEntry;
    // Guardar en la nube
    saveProcesoEntry(currentVin);

    // Update in-memory procesoData
    const idx = procesoData.findIndex(r => r.vin === currentVin);
    if (idx >= 0) Object.assign(procesoData[idx], procesoEntry);
    else procesoData.unshift(procesoEntry);

    renderProceso();
    toast('✔ Cita agendada · VIN agregado a Proceso');
  } else {
    toast('✔ Cambios guardados');
  }

  // Guardar edicion de contacto/observacion en la nube
  saveEdit(currentVin);

  applyFilters();
  closeModal();
}

let matrizInited = false;
function initTabs() {
  qsa('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.tab-btn').forEach(b => b.classList.remove('active'));
      qsa('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      const target = qs(`#tab-content-${btn.dataset.tab}`);
      if (target) target.classList.add('active');

      if (btn.dataset.tab === 'matriz' && !matrizInited) {
        if (vinDataLoaded) {
          initMatriz();
          matrizInited = true;
        } else {
          const tbody = qs('#table-body');
          if (tbody) tbody.innerHTML = '<tr><td colspan="12" style="text-align:center;padding:24px"><div class="spinner"></div> Cargando base de datos (3MB)...</td></tr>';
          const poll = setInterval(() => {
            if (vinDataLoaded) {
              clearInterval(poll);
              initMatriz();
              matrizInited = true;
            }
          }, 500);
        }
      }
    });
  });
}

/* ── INIT ── */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    initTabs();
    
    // modal bindings
    const mClose = qs('#modal-close'), mOverlay = qs('#modal-overlay'), mSave = qs('#modal-save');
    if (mClose) mClose.addEventListener('click', closeModal);
    if (mOverlay) mOverlay.addEventListener('click', e => { if(e.target===mOverlay) closeModal(); });
    if (mSave) mSave.addEventListener('click', saveModal);
    
    // Nuevo VIN
    const btnNuevo = qs('#btn-nuevo-vin'), modalNuevo = qs('#modal-nuevo-overlay'), formNuevo = qs('#form-nuevo-vin');
    if (btnNuevo && modalNuevo && formNuevo) {
      btnNuevo.addEventListener('click', () => modalNuevo.style.display = 'flex');
      qs('#modal-nuevo-close')?.addEventListener('click', () => modalNuevo.style.display = 'none');
      modalNuevo.addEventListener('click', e => { if(e.target === modalNuevo) modalNuevo.style.display = 'none'; });
      formNuevo.addEventListener('submit', async e => {
        e.preventDefault();
        const nuevo = Object.fromEntries(new FormData(formNuevo).entries());
        if (vinData.some(r => r.vin === nuevo.vin)) return toast('Error: VIN duplicado', 'error');
        await saveCustomVin(nuevo);
        customVins.unshift(nuevo);
        vinData = [nuevo, ...vinData];
        applyFilters();
        toast('✔ VIN registrado');
        modalNuevo.style.display = 'none';
        formNuevo.reset();
      });
    }

    document.addEventListener('keydown', e => { 
      if (e.key === 'Escape') { closeModal(); if(modalNuevo) modalNuevo.style.display='none'; }
    });
    
    qs('#month-select')?.addEventListener('change', e => renderCampaignsTable(e.target.value));

    // Cargar datos
    await loadAll();

  } catch (err) {
    console.error('Error fatal init:', err);
    setStatus('⚠ Error de script', true);
  }
});
