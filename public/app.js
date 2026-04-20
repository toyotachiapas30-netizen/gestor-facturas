// ─────────────────────────────────────────────────────────────────────────────
// Gestor de Facturas — Frontend App  v2
// ─────────────────────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  xmlFile: null, pdfFile: null,
  cfdi: null,           // parsed CFDI fields
  satOk: false,         // step 2 done
  driveOk: false,       // step 3 done
  buzonOk: false,       // step 4 done
  mailSubject: null,    // step 5
  mailOk: false,
  portalOk: false,      // step 6
  selectedSheetId: null,// step 7
  sucursalFolderId: null, // Save selected branch
  currentSessionId: null  // For Captcha Relay
};

const TOTAL_STEPS = 4; // Archivos, SAT, Drive, Contrarecibo
const STEP_MAP = [0, 1, 2, 3]; // Mapping of logical index to HTML element IDs

const CATEGORIAS = [
  'NORMATIVAS',
  'MANTENIMIENTO DE PLANTA',
  'RECOLECCIÓN DE BASURA, DESASOLVE Y RP',
  'PROGRAMAS AVANZADOS TOYOTA',
  'ASESORÍAS (AMBIENTAL, ADACH, ETC)',
  'GESTORÍAS (CFE, PROGRAMA INTERNO, PAGO A GOBIERNO)',
  'PAGO ANUAL TOTEM',
  'ADECUACIONES A SOLICITADO POR VRI',
  'MANTENIMIENTOS Y REPARACIÓN EN GENERAL',
  'ACTIVO FIJO',
  'GPS UNIDAD MOVIL Y UTILITARIA',
  'FUMIGACIÓN',
  'FORO KAIZEN',
  'TOYOTA PONIENTE',
  'GASTO MENSUAL VIDEO WALL',
  'SISTEMA DE MONITOREO ANTIROBO',
  'VISITAS COMERCIALES',
  'OTROS'
];

// ── Helpers: dropzone ─────────────────────────────────────────────────────────
function setupDrop(dzId, inputId, tagId, nameId, key) {
  const dz = document.getElementById(dzId);
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); handleFilePick(e.dataTransfer.files[0], tagId, nameId, key); });
  document.getElementById(inputId).addEventListener('change', function() { handleFilePick(this.files[0], tagId, nameId, key); });
}

function handleFilePick(file, tagId, nameId, key) {
  if (!file) return;
  state[key] = file;
  document.getElementById(nameId).textContent = file.name;
  document.getElementById(tagId).classList.add('show');
}

setupDrop('dz-xml', 'inp-xml', 'tag-xml', 'name-xml', 'xmlFile');
setupDrop('dz-pdf', 'inp-pdf', 'tag-pdf', 'name-pdf', 'pdfFile');

// Debug duplicate check directly
async function debugDupeCheck(uuid) {
  try {
     const r = await fetch(`/api/gastos/check/${uuid}`);
     const d = await r.json();
     console.log('Dupe check for', uuid, ':', d);
     return d.exists;
  } catch(e) { console.error('Dupe check fetch error:', e); return false; }
}

// Register Chart.js Plugin
if (window.ChartDataLabels) {
  Chart.register(ChartDataLabels);
}

// Initialize UI and State
document.addEventListener('DOMContentLoaded', () => {
  const catSel = document.getElementById('inp-categoria');
  if (catSel) {
    CATEGORIAS.forEach(c => {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      if (c === 'OTROS') o.selected = true;
      catSel.appendChild(o);
    });
  }

  // Sync Branch selection
  const sucSel = document.getElementById('inp-sucursal');
  if (sucSel) {
    state.sucursalFolderId = sucSel.value;
    sucSel.addEventListener('change', e => {
      state.sucursalFolderId = e.target.value;
      console.log('Sucursal cambiada:', state.sucursalFolderId);
    });
  }
});

// ── Helpers: UI ───────────────────────────────────────────────────────────────
function showErr(id, msg) {
  const el = document.getElementById(id);
  if (!el) return console.warn('showErr: element not found', id);
  el.classList.add('show');
  const msgEl = el.querySelector('span:last-child');
  if (msgEl) msgEl.textContent = msg;
}
function hideErr(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove('show');
}
function setLoading(btnId, spinId, loading) {
  const btn=document.getElementById(btnId), spin=document.getElementById(spinId);
  btn.disabled=loading; spin.style.display=loading?'inline-block':'none';
}

// ── Main view switching ───────────────────────────────────────────────────────
function switchMainView(view) {
  document.querySelectorAll('.main-tab').forEach(t => t.classList.toggle('active', t.dataset.view === view));
  document.querySelectorAll('.main-view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  if (view === 'gastos') loadGastos();
}

// ── Step navigation ───────────────────────────────────────────────────────────
function goTo(n) {
  // n is the logical step index (0 to 4)
  if (n < 0 || n >= STEP_MAP.length) return;
  
  const realStepId = STEP_MAP[n];
  const targetPanel = document.getElementById('step-' + realStepId);
  if (!targetPanel) return;

  document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
  targetPanel.classList.add('active');

  const pct = Math.round(((n+1)/TOTAL_STEPS)*100);
  document.getElementById('prog-fill').style.width = pct+'%';
  
  // Update dots and labels
  STEP_MAP.forEach((id, idx) => {
    const dot = document.getElementById('dot-' + id);
    const lbl = document.getElementById('lbl-' + id);
    if (!dot) return;
    dot.className = 'dot' + (idx < n ? ' done' : idx === n ? ' active' : '');
    if (lbl) lbl.className = 'step-label' + (idx < n ? ' done' : idx === n ? ' active' : '');
  });

  // Special behavior
  if (n === 3) {
    // We are in Paso 4 (logical 4, index 3)
    const sucName = document.getElementById('inp-sucursal').options[document.getElementById('inp-sucursal').selectedIndex].text;
    const indicator = document.getElementById('active-branch-name');
    if (indicator) indicator.textContent = sucName;
  }

  window.scrollTo({top:0,behavior:'smooth'});
}

// ── PASO 1: Cargar archivos → PASO 2 ─────────────────────────────────────────
function goStep1() {
  hideErr('err-step0');
  if (!state.xmlFile) return showErr('err-step0', 'Selecciona el archivo XML del CFDI.');
  if (!state.pdfFile) return showErr('err-step0', 'Selecciona el archivo PDF de la factura.');

  const sucursalSel = document.getElementById('inp-sucursal');
  if (!sucursalSel || !sucursalSel.value) return showErr('err-step0', 'Selecciona la sucursal destino.');

  const reader = new FileReader();
  reader.onload = async e => {
    const parsed = parseCFDI(e.target.result);
    if (!parsed) return showErr('err-step0', 'El XML no es un CFDI válido o no tiene Timbre Fiscal Digital.');

    // Save sucursal to state just in case
    state.sucursalFolderId = sucursalSel.value;
    
    // ── Check UUID duplication ──
    try {
      const res = await fetch(`/api/gastos/check/${parsed.uuid}`);
      const dbCheck = await res.json();
      if (dbCheck.exists) {
        const proceed = window.confirm(`⚠️ ADVERTENCIA DE DUPLICIDAD\n\nEl sistema detectó que esta factura (UUID: ${parsed.uuid}) ya fue introducida anteriormente en el Control de Gastos.\n\n¿Deseas continuar de todos modos? (Se creará un registro duplicado)`);
        if (!proceed) return;
      }
    } catch (err) {
      console.warn('Error al verificar duplicidad:', err);
    }

    state.cfdi = parsed;
    state.sucursalFolderId = sucursalSel.value; // Store the branch
    renderCFDI();
    
    // Populate manual copy fields
    document.getElementById('copy-uuid').value = parsed.uuid;
    document.getElementById('copy-rfc-e').value = parsed.rfcEmisor;
    document.getElementById('copy-rfc-r').value = parsed.rfcReceptor;

    goTo(1);
    // Auto-fill fields
    if (parsed.nombreEmisor) document.getElementById('inp-proveedor').value = parsed.nombreEmisor;
    if (parsed.nombreEmisor) document.getElementById('inp-proveedor-sheet').value = parsed.nombreEmisor;
    if (parsed.concepto) document.getElementById('inp-concepto').value = parsed.concepto;
  };
  reader.readAsText(state.xmlFile, 'UTF-8');
}

function parseCFDI(xml) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) return null;
  const comp = doc.querySelector('*|Comprobante, Comprobante');
  if (!comp) return null;
  const g = a => comp.getAttribute(a) || '—';
  const emisor   = doc.querySelector('*|Emisor, Emisor');
  const receptor = doc.querySelector('*|Receptor, Receptor');
  const timbre   = doc.querySelector('*|TimbreFiscalDigital, TimbreFiscalDigital');
  const uuid     = timbre ? (timbre.getAttribute('UUID') || '—') : '—';
  if (uuid === '—') return null;
  const tipoMap = {I:'Ingreso',E:'Egreso',T:'Traslado',N:'Nómina',P:'Pago'};

  // Extract concepto from Conceptos
  let conceptoDesc = '';
  const conceptos = doc.querySelectorAll('*|Concepto, Concepto');
  if (conceptos.length > 0) {
    conceptoDesc = conceptos[0].getAttribute('Descripcion') || '';
  }

  return {
    uuid,
    rfcEmisor:    emisor   ? (emisor.getAttribute('Rfc')    || '—') : '—',
    nombreEmisor: emisor   ? (emisor.getAttribute('Nombre') || '—') : '—',
    rfcReceptor:  receptor ? (receptor.getAttribute('Rfc')  || '—') : '—',
    nombreReceptor: receptor ? (receptor.getAttribute('Nombre') || '—') : '—',
    fecha:  g('Fecha'), version: g('Version') || g('version'),
    moneda: g('Moneda'), total: g('Total'), tipo: tipoMap[g('TipoDeComprobante')] || g('TipoDeComprobante'),
    noFactura: g('Folio') || g('Serie') + g('Folio'),
    concepto: conceptoDesc
  };
}

function renderCFDI() {
  const c = state.cfdi;
  document.getElementById('d-uuid').textContent    = c.uuid;
  document.getElementById('d-rfc-e').textContent   = c.rfcEmisor;
  document.getElementById('d-nom-e').textContent   = c.nombreEmisor;
  document.getElementById('d-rfc-r').textContent   = c.rfcReceptor;
  document.getElementById('d-nom-r').textContent   = c.nombreReceptor;
  document.getElementById('d-fecha').textContent   = fmtFecha(c.fecha);
  document.getElementById('d-tipo').textContent    = c.tipo;
  document.getElementById('d-ver').textContent     = c.version;
  document.getElementById('d-moneda').textContent  = c.moneda;
  document.getElementById('d-total').textContent   = fmtMonto(c.total, c.moneda);
  
  updateBookmarklet();
}

function updateBookmarklet() {
  const c = state.cfdi;
  if (!c) return;

  const code = `javascript:(function(){
    const fill = (id, val) => { 
      const el = document.getElementById(id); 
      if(el) { 
        el.value = val; 
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } 
    };
    fill('ctl00_MainContent_TxtUUID', '${c.uuid}');
    fill('ctl00_MainContent_TxtRfcEmisor', '${c.rfcEmisor}');
    fill('ctl00_MainContent_TxtRfcReceptor', '${c.rfcReceptor}');
    console.log('✅ Datos de factura ${c.noFactura} llenados por el Gestor.');
    const cap = document.getElementById('ctl00_MainContent_TxtGenerico');
    if(cap) { cap.focus(); cap.scrollIntoView(); }
  })();`.replace(/\s+/g, ' ');

  const btn = document.getElementById('btn-bookmarklet');
  if (btn) btn.href = code;

  // Also update legacy copy fields
  document.getElementById('copy-uuid').value = c.uuid;
  document.getElementById('copy-rfc-e').value = c.rfcEmisor;
  document.getElementById('copy-rfc-r').value = c.rfcReceptor;
}

function toggleManualData() {
  const el = document.getElementById('manual-data-copy');
  el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// ── PASO 2: Verificar SAT ─────────────────────────────────────────────────────
async function verificarSAT() {
  hideErr('err-step1');
  setLoading('btn-sat-verify','spin-sat',true);
  document.getElementById('sat-badge').style.display='flex';
  document.getElementById('sat-details').innerHTML='';
  document.getElementById('btn-print-sat').style.display='none';
  document.getElementById('btn-next1').disabled=true;

  try {
    const r = await fetch('/api/sat/verificar', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ uuid:state.cfdi.uuid, rfcEmisor:state.cfdi.rfcEmisor, rfcReceptor:state.cfdi.rfcReceptor, total:state.cfdi.total })
    });
    const data = await r.json();
    if (!data.ok) return showErr('err-step1', data.error);

    const estado = (data.estado||'').toLowerCase();
    const badge = document.getElementById('sat-badge');
    badge.className='badge '+(estado==='vigente'?'vigente':estado==='cancelado'?'cancelado':'warning');
    document.getElementById('sat-icon').textContent  = estado==='vigente'?'✅':estado==='cancelado'?'❌':'⚠️';
    document.getElementById('sat-title').textContent = estado==='vigente'?'CFDI Vigente':estado==='cancelado'?'CFDI Cancelado':'No Encontrado';
    document.getElementById('sat-sub').textContent   = data.codigoEstatus || '';

    document.getElementById('sat-details').innerHTML = [
      {k:'Código de Estatus',v:data.codigoEstatus},{k:'Estado',v:data.estado},
      {k:'Es Cancelable',v:data.esCancelable},{k:'Estatus Cancelación',v:data.estatusCancelacion},{k:'Validez EFOS',v:data.efos}
    ].map(x=>`<div class="rrow"><span class="rk">${x.k}</span><span class="rv">${x.v||'—'}</span></div>`).join('');

    state.satOk = estado==='vigente';
    document.getElementById('btn-print-sat').style.display='inline-flex';
    document.getElementById('btn-next1').disabled=false;
    
    // Auto-trigger print if requested (optional logic)
  } catch(err) {
    showErr('err-step1', 'No se pudo conectar: '+err.message);
    document.getElementById('sat-badge').style.display='none';
  } finally {
    setLoading('btn-sat-verify','spin-sat',false);
  }
}

// SAT server-side printing removed to save resources on older Macs.


function closeCaptcha() {
    const overlay = document.getElementById('captcha-overlay');
    if (overlay) overlay.style.display = 'none';
}

function copiarAlPortapapeles(id) {
  const el = document.getElementById(id);
  el.select();
  el.setSelectionRange(0, 99999);
  navigator.clipboard.writeText(el.value).then(() => {
    const btn = event.target;
    const originalText = btn.textContent;
    btn.textContent = '¡Copiado!';
    btn.classList.add('btn-success');
    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove('btn-success');
    }, 2000);
  });
}

// ── PASO 3: Google Drive ──────────────────────────────────────────────────────
async function subirDrive() {
  hideErr('err-step2');
  const proveedor = document.getElementById('inp-proveedor').value.trim();
  if (!proveedor) return showErr('err-step2', 'Escribe el nombre del proveedor.');
  setLoading('btn-drive-upload','spin-drive',true);

  const fd = new FormData();
  fd.append('xml', state.xmlFile);
  fd.append('pdf', state.pdfFile);
  fd.append('proveedorNombre', proveedor);
  if (state.sucursalFolderId) fd.append('parentFolderId', state.sucursalFolderId);

  try {
    const r = await fetch('/api/drive/upload', { method:'POST', body:fd });
    const data = await r.json();
    if (!data.ok) return showErr('err-step2', data.error);

    document.getElementById('drive-result').style.display='block';
    document.getElementById('drive-sub').textContent = `Carpeta: ${data.carpeta} (${data.archivos.length} archivos subidos)`;
    const link=document.getElementById('drive-link'); link.href=data.folderLink;
    state.driveOk=true;
    document.getElementById('btn-next2').disabled=false;
  } catch(err) {
    showErr('err-step2','Error: '+err.message);
  } finally {
    setLoading('btn-drive-upload','spin-drive',false);
  }
}

// ── PASO 4: Autotec Buzón ─────────────────────────────────────────────────────
async function subirBuzon() {
  hideErr('err-step3');
  setLoading('btn-buzon','spin-buzon',true);
  const fd = new FormData();
  fd.append('xml', state.xmlFile);
  // Add optional orden de compra
  const ordenCompra = document.getElementById('inp-orden-compra').value.trim();
  if (ordenCompra) fd.append('ordenCompra', ordenCompra);

  try {
    const r = await fetch('/api/autotec/buzon', { method:'POST', body:fd });
    const data = await r.json();
    if (!data.ok) return showErr('err-step3', data.error);
    document.getElementById('buzon-result').style.display='block';
    if (data.screenshot) document.getElementById('buzon-screenshot').src=data.screenshot;
    state.buzonOk=true;
    document.getElementById('btn-next3').disabled=false;
    // Debounce sheet search since we have the provider name now
    buscarSheetPorNombre();
  } catch(err) {
    showErr('err-step3','Error: '+err.message);
  } finally {
    setLoading('btn-buzon','spin-buzon',false);
  }
}

// Pasos eliminados
function buscarCorreo() {}
function imprimirCorreo() {}
function enviarPortal() {}

// ── PASO 7: Contrarecibo Google Sheets ──────────────────────────────────────

// Debounce for provider name search
let sheetSearchTimer = null;
function debounceBuscarSheet() {
  clearTimeout(sheetSearchTimer);
  sheetSearchTimer = setTimeout(buscarSheetPorNombre, 500);
}

async function buscarSheetPorNombre() {
  const nombre = document.getElementById('inp-proveedor-sheet').value.trim();
  const statusEl = document.getElementById('sheet-search-status');
  const sel = document.getElementById('sel-sheet');

  if (!nombre) {
    statusEl.textContent = '';
    return;
  }

  statusEl.textContent = '🔍 Buscando...';
  statusEl.style.color = 'var(--text-muted)';

  let queryUrl = `/api/sheets/find?nombre=${encodeURIComponent(nombre)}`;
  if (state.sucursalFolderId) {
    queryUrl += `&folderId=${state.sucursalFolderId}`;
  } else {
    // Fallback: try to get it directly from the select just in case
    const currentSuc = document.getElementById('inp-sucursal').value;
    if (currentSuc) queryUrl += `&folderId=${currentSuc}`;
  }

  try {
    const r = await fetch(queryUrl);
    const data = await r.json();
    if (!data.ok) {
      statusEl.textContent = '❌ Error: ' + data.error;
      statusEl.style.color = '#fca5a5';
      return;
    }

    // Clear and repopulate dropdown
    sel.innerHTML = '<option value="">— Selecciona la hoja —</option>';
    data.sheets.forEach(s => {
      const o = document.createElement('option');
      o.value = s.id;
      o.textContent = s.name;
      sel.appendChild(o);
    });

    if (data.matched && data.sheets.length > 0) {
      // Auto-select the first match
      sel.value = data.sheets[0].id;
      state.selectedSheetId = data.sheets[0].id;
      statusEl.textContent = `✅ Encontrada: "${data.sheets[0].name}"`;
      statusEl.style.color = '#6ee7b7';
      // Auto-trigger preview
      setTimeout(previewSheet, 100);
    } else if (data.sheets.length > 0) {
      statusEl.textContent = data.mensaje || `⚠️ No se encontró coincidencia exacta. Mostrando ${data.sheets.length} hojas.`;
      statusEl.style.color = '#fde68a';
    } else {
      statusEl.textContent = '❌ No se encontraron hojas de cálculo.';
      statusEl.style.color = '#fca5a5';
    }
  } catch (err) {
    statusEl.textContent = '❌ Error de conexión';
    statusEl.style.color = '#fca5a5';
  }
}

async function loadSheets() {
  try {
    let queryUrl = '/api/sheets/find';
    const currentSuc = state.sucursalFolderId || document.getElementById('inp-sucursal').value;
    if (currentSuc) queryUrl += `?folderId=${currentSuc}`;

    console.log(`📡 Solicitando hojas para sucursal: ${currentSuc}`);
    const r = await fetch(queryUrl);
    const data = await r.json();
    if (!data.ok || !data.sheets) return;
    const sel = document.getElementById('sel-sheet');
    
    // Always refresh the dropdown content
    sel.innerHTML = '<option value="">— Selecciona la hoja —</option>';
    data.sheets.forEach(s => {
      const o = document.createElement('option'); o.value=s.id; o.textContent=s.name; sel.appendChild(o);
    });
  } catch {}
}

function onSheetChange() {
  state.selectedSheetId = document.getElementById('sel-sheet').value;
}

function previewSheet() {
  hideErr('err-step6');
  const sheetId  = document.getElementById('sel-sheet').value;
  const concepto = document.getElementById('inp-concepto').value.trim();
  if (!sheetId)  return showErr('err-step6','Selecciona la hoja de cálculo.');
  if (!concepto) return showErr('err-step6','Escribe el concepto del gasto.');
  if (!state.cfdi) return showErr('err-step6','No hay datos de CFDI cargados.');

  document.getElementById('prev-nofact').textContent  = state.cfdi.noFactura || '—';
  document.getElementById('prev-fecha').textContent   = fmtFecha(state.cfdi.fecha);
  document.getElementById('prev-importe').textContent = fmtMonto(state.cfdi.total, state.cfdi.moneda);
  document.getElementById('prev-concepto').textContent= concepto;
  document.getElementById('sheet-preview').style.display='block';
  document.getElementById('btn-sheets-fill').style.display='inline-flex';
}

async function llenarSheet() {
  hideErr('err-step6');
  const sheetId  = document.getElementById('sel-sheet').value;
  const tabName  = document.getElementById('inp-tab').value.trim() || 'Hoja1';
  const concepto = document.getElementById('inp-concepto').value.trim();
  setLoading('btn-sheets-fill','spin-sheets',true);

  try {
    const r = await fetch('/api/sheets/llenar', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({
        sheetId, sheetName:tabName,
        noFact:  state.cfdi.noFactura || state.cfdi.uuid,
        fecha:   state.cfdi.fecha,
        importe: state.cfdi.total,
        concepto
      })
    });
    const data = await r.json();
    if (!data.ok) return showErr('err-step6', data.error);

    document.getElementById('sheets-result').style.display='block';
    document.getElementById('sheets-link-wrap').innerHTML=`<a href="${data.sheetUrl}" target="_blank" style="color:#60a5fa">Abrir Google Sheets ↗</a>`;

    // Auto-register as expense
    const categoria = document.getElementById('inp-categoria').value || 'OTROS';
    await autoRegistrarGasto(concepto, categoria, data.sheetUrl);

    document.getElementById('final-success').style.display='flex';
    document.getElementById('btn-sheets-fill').style.display='none';
  } catch(err) {
    showErr('err-step6','Error: '+err.message);
  } finally {
    setLoading('btn-sheets-fill','spin-sheets',false);
  }
}

// Auto-register expense at the end of the flow
async function autoRegistrarGasto(concepto, categoria, sheetUrl) {
  if (!state.cfdi) return;
  const c = state.cfdi;
  const fechaFactura = c.fecha ? c.fecha.substring(0, 10) : '';
  const hoy = new Date().toISOString().substring(0, 10);

  try {
    await fetch('/api/gastos', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        uuid: c.uuid,
        proveedor: c.nombreEmisor || '—',
        folio: c.noFactura || c.uuid,
        fechaFactura,
        monto: parseFloat(c.total) || 0,
        concepto: concepto || c.concepto || '',
        fechaSolicitud: hoy,
        estatus: 'en_proceso',
        categoria: categoria || 'OTROS',
        sheet_url: sheetUrl || ''
      })
    });
  } catch (err) {
    console.error('Auto-registro gasto error:', err.message);
  }
}

// ── Settings / Google Auth ────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-overlay').classList.add('open');
  checkGoogleAuth();
}
function closeSettings() { document.getElementById('settings-overlay').classList.remove('open'); }

async function checkGoogleAuth() {
  try {
    const r = await fetch('/api/drive/status');
    const d = await r.json();
    const el = document.getElementById('google-status');
    el.textContent = d.authorized ? '✅ Google autorizado correctamente' : '❌ No autorizado. Haz clic en el botón para conectar.';
    el.style.color = d.authorized ? '#6ee7b7' : '#fca5a5';
    document.getElementById('config-banner').classList.toggle('hidden', d.authorized);
    if (d.authorized) loadSheets();
  } catch {}
}

async function authGoogle() {
  try {
    const r = await fetch('/api/drive/auth-url');
    const d = await r.json();
    if (d.url) window.open(d.url,'_blank');
    // Poll for auth completion
    setTimeout(async () => { await checkGoogleAuth(); if(document.getElementById('sel-sheet').options.length<=1) loadSheets(); }, 5000);
  } catch(err) { alert('Error: '+err.message); }
}

function resetFlow() {
  // Clear state
  state.xmlFile = null;
  state.pdfFile = null;
  state.cfdi = null;
  state.satOk = false;
  state.driveOk = false;

  // Clear inputs
  document.getElementById('inp-xml').value = '';
  document.getElementById('inp-pdf').value = '';
  document.getElementById('name-xml').textContent = '—';
  document.getElementById('name-pdf').textContent = '—';
  document.getElementById('tag-xml').classList.remove('show');
  document.getElementById('tag-pdf').classList.remove('show');
  
  // Clear results
  document.getElementById('sat-badge').style.display = 'none';
  document.getElementById('drive-result').style.display = 'none';
  document.getElementById('sheet-preview').style.display = 'none';
  document.getElementById('sheets-result').style.display = 'none';
  document.getElementById('final-success').style.display = 'none';
  document.getElementById('btn-sheets-fill').style.display = 'none';

  // Clear sheet selection so it reloads correctly next time
  const sel = document.getElementById('sel-sheet');
  if (sel) sel.innerHTML = '<option value="">— Selecciona la hoja —</option>';
  
  // Back to start
  goTo(0);
}

// ── Formatting ────────────────────────────────────────────────────────────────
function fmtFecha(f) {
  if (!f||f==='—') return '—';
  try { return new Date(f).toLocaleString('es-MX',{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'}); } catch { return f; }
}
function fmtShortDate(f) {
  if (!f||f==='—') return '—';
  try { return new Date(f+'T00:00:00').toLocaleDateString('es-MX',{year:'numeric',month:'short',day:'numeric'}); } catch { return f; }
}
function fmtMonto(t,m) {
  if (!t||t==='—') return '—';
  const n=parseFloat(t); if(isNaN(n)) return t;
  const c=(m&&m!=='—')?m:'MXN';
  try { return new Intl.NumberFormat('es-MX',{style:'currency',currency:c}).format(n); } catch { return '$'+n.toFixed(2)+' '+c; }
}
function fmtMes(mes) {
  if (!mes) return 'Todos';
  const [y, m] = mes.split('-');
  const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  return `${meses[parseInt(m)-1]} ${y}`;
}

// ── Reset ─────────────────────────────────────────────────────────────────────
function resetAll() {
  Object.assign(state,{xmlFile:null,pdfFile:null,cfdi:null,satOk:false,driveOk:false,buzonOk:false,mailSubject:null,mailOk:false,portalOk:false,selectedSheetId:null});
  document.getElementById('tag-xml').classList.remove('show');
  document.getElementById('tag-pdf').classList.remove('show');
  ['drive-result','buzon-result','mail-result','portal-result','sheets-result','sheet-preview','final-success'].forEach(id=>{ const e=document.getElementById(id); if(e) e.style.display='none'; });
  document.getElementById('sat-badge').style.display='none';
  document.getElementById('inp-proveedor-sheet').value='';
  document.getElementById('sheet-search-status').textContent='';
  document.getElementById('inp-orden-compra').value='';
  goTo(0);
}

// ══════════════════════════════════════════════════════════════════════════════
// CONTROL DE GASTOS
// ══════════════════════════════════════════════════════════════════════════════

async function loadGastos() {
  const mes = document.getElementById('filter-mes').value;
  const est = document.getElementById('filter-estatus').value;
  const desde = document.getElementById('filter-desde').value;
  const hasta = document.getElementById('filter-hasta').value;

  // Multi-select categories
  const selectedCats = [];
  const cbs = document.querySelectorAll('#cat-checklist input[type="checkbox"]:checked');
  cbs.forEach(cb => selectedCats.push(cb.value));
  const cat = selectedCats.join(',');

  let url = '/api/gastos?';
  if (mes) url += `mes=${encodeURIComponent(mes)}&`;
  if (cat) url += `categoria=${encodeURIComponent(cat)}&`;
  if (est) url += `estatus=${encodeURIComponent(est)}&`;
  if (desde) url += `desde=${encodeURIComponent(desde)}&`;
  if (hasta) url += `hasta=${encodeURIComponent(hasta)}&`;

  try {
    const r = await fetch(url);
    const data = await r.json();
    if (!data.ok) return;

    // Update summary
    document.getElementById('gs-count').textContent = data.resumen.count;
    document.getElementById('gs-total').textContent = fmtMonto(String(data.resumen.total), 'MXN');
    document.getElementById('gs-proceso').textContent = data.resumen.enProceso;
    document.getElementById('gs-pagados').textContent = data.resumen.pagados;

    const tbody = document.getElementById('gastos-tbody');
    const empty = document.getElementById('gastos-empty');
    const tableContainer = document.getElementById('gastos-table-container');

    tbody.innerHTML = data.gastos.map(g => `
      <tr>
        <td style="font-weight:600;white-space:nowrap;">${escHtml(g.proveedor)}</td>
        <td>${escHtml(g.folio)}</td>
        <td style="white-space:nowrap;">${fmtShortDate(g.fecha_factura)}</td>
        <td class="monto-cell" style="font-weight:600;color:var(--primary);">${fmtMonto(String(g.monto), 'MXN')}</td>
        <td class="pago-cell" ondragover="event.preventDefault(); this.classList.add('drag-over')" ondragleave="this.classList.remove('drag-over')" ondrop="handlePagoDrop(event, '${g.id}')">
          <div class="pago-cell-content">
            ${g.comprobante_pago_url ? 
              `<div class="pago-link-wrap">
                <a href="/api/gastos/${g.id}/download-comprobante" target="_blank" title="Descargar Comprobante" style="font-size:18px;text-decoration:none;">📄</a>
                <button class="pago-delete-btn" onclick="borrarComprobante('${g.id}')" title="Eliminar Comprobante">×</button>
              </div>` : 
              `<span class="pago-placeholder" style="opacity:0.3;cursor:default;" title="Arrastra el PDF aquí">＋</span>`
            }
          </div>
        </td>
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(g.concepto)}">${escHtml(g.concepto)}</td>
        <td style="white-space:nowrap;">${fmtShortDate(g.fecha_solicitud)}</td>
        <td style="text-align:center;">
          ${g.sheet_url ? `<a href="${g.sheet_url}" target="_blank" title="Ver Contrarecibo" style="font-size:16px;text-decoration:none;">📊</a>` : '—'}
        </td>
        <td>
          <span class="estatus-tag ${g.estatus}" onclick="toggleEstatus('${g.id}','${g.estatus}')" style="cursor:pointer" title="Hacer clic para cambiar estado">
            <span class="estatus-dot"></span>
            ${g.estatus === 'en_proceso' ? 'En proceso' : 'Pagado'}
          </span>
        </td>
        <td><span class="cat-tag">${escHtml(g.categoria || '')}</span></td>
        <td>
          <div class="tbl-action">
            <button class="tbl-btn edit" onclick="editGasto('${g.id}')" title="Editar">✏️</button>
            <button class="tbl-btn" onclick="deleteGasto('${g.id}')" title="Eliminar" style="color:#fca5a5">🗑️</button>
          </div>
        </td>
      </tr>
    `).join('');

    loadStats(); // Update charts too

  } catch (err) {
    console.error('Error loading gastos:', err);
  }
}

// ── Manejo de Comprobante de Pago (Drag & Drop) ──
async function handlePagoDrop(e, id) {
  e.preventDefault();
  const cell = e.currentTarget;
  cell.classList.remove('drag-over');

  const file = e.dataTransfer.files[0];
  if (!file) return;

  if (file.type !== 'application/pdf') {
    alert('Por favor, sube solo archivos PDF.');
    return;
  }

  // Visual feedback
  const content = cell.querySelector('.pago-cell-content');
  const oldHtml = content.innerHTML;
  content.innerHTML = '<span class="spin-small"></span>';

  try {
    await uploadComprobante(id, file);
  } catch (err) {
    alert('Error al subir: ' + err.message);
    content.innerHTML = oldHtml;
  }
}

async function uploadComprobante(id, file) {
  const fd = new FormData();
  fd.append('file', file);

  const r = await fetch(`/api/gastos/${id}/upload-pago`, {
    method: 'POST',
    body: fd
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error);

  // Success: reload table to show the icon and update status to 'pagado'
  loadGastos();
}

async function borrarComprobante(id) {
  if (!confirm('¿Estás seguro de que deseas eliminar este comprobante?')) return;
  try {
    const r = await fetch(`/api/gastos/${id}/pago`, { method: 'DELETE' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error);
    loadGastos();
  } catch (err) {
    alert('Error al eliminar: ' + err.message);
  }
}

let chartDist = null;

function renderCharts(stats, rango) {
  const canvasDist = document.getElementById('chart-dist');
  if (!canvasDist) return;
  const ctxDist = canvasDist.getContext('2d');

  if (chartDist) chartDist.destroy();

  const textColor = '#1e293b';
  const gridColor = 'rgba(226, 232, 240, 0.8)';
  
  // High-Contrast Toyota Branding Palette
  const palette = ['#eb0a1e', '#1e293b', '#64748b', '#94a3b8', '#cbd5e1', '#000000'];

  const catData = stats.byCategory || [];

  chartDist = new Chart(ctxDist, {
    type: 'bar',
    data: {
      labels: catData.map(c => c.categoria),
      datasets: [{
        label: 'Monto Total',
        data: catData.map(c => c.total),
        backgroundColor: palette,
        borderRadius: 4,
        barThickness: 24,
        maxBarThickness: 32
      }]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: {
        padding: { left: 10, right: 30, top: 0, bottom: 0 }
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          enabled: true,
          mode: 'index',
          intersect: false,
          backgroundColor: '#1e293b',
          titleFont: { size: 13, weight: 'bold' },
          bodyFont: { size: 13 },
          padding: 12,
          cornerRadius: 8,
          callbacks: {
            label: (ctx) => ' ' + new Intl.NumberFormat('es-MX', {style:'currency', currency:'MXN'}).format(ctx.raw)
          }
        },
        datalabels: { display: false }
      },
      interaction: {
        mode: 'nearest',
        axis: 'y',
        intersect: false
      },
      scales: {
        x: { 
          grid: { color: gridColor, drawBorder: false }, 
          ticks: { 
            color: '#64748b', 
            font: { size: 10 },
            callback: (v) => '$' + v.toLocaleString()
          } 
        },
        y: { 
          grid: { display: false }, 
          ticks: { 
            color: '#1e293b', 
            font: { size: 11, weight: '600' },
            callback: function(value) {
              const label = this.getLabelForValue(value);
              return label.length > 25 ? label.substring(0, 22) + '...' : label;
            }
          } 
        }
      }
    }
  });
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function toggleEstatus(id, current) {
  // One-click to 'pagado' if it's currently 'en_proceso'
  const newEstatus = current === 'en_proceso' ? 'pagado' : 'en_proceso';
  try {
    await fetch(`/api/gastos/${id}/estatus`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ estatus: newEstatus })
    });
    loadGastos();
  } catch (err) {
    console.error('Toggle estatus error:', err);
    alert('Error al cambiar estatus');
  }
}

async function deleteGasto(id) {
  if (!confirm('¿Eliminar este gasto?')) return;
  try {
    await fetch(`/api/gastos/${id}`, { method: 'DELETE' });
    loadGastos();
  } catch (err) {
    console.error('Delete error:', err);
  }
}

// Store gastos data for editing
let gastosCache = [];

async function editGasto(id) {
  try {
    const r = await fetch('/api/gastos?');
    const data = await r.json();
    const gasto = data.gastos.find(g => g.id === id);
    if (!gasto) return;

    document.getElementById('gasto-edit-id').value = id;
    document.getElementById('gasto-form-title').textContent = '✏️ Editar Gasto';
    document.getElementById('gf-proveedor').value = gasto.proveedor || '';
    document.getElementById('gf-folio').value = gasto.folio || '';
    document.getElementById('gf-fecha-factura').value = gasto.fecha_factura || '';
    document.getElementById('gf-monto').value = gasto.monto || '';
    document.getElementById('gf-concepto').value = gasto.concepto || '';
    document.getElementById('gf-fecha-solicitud').value = gasto.fecha_solicitud || '';
    document.getElementById('gf-estatus').value = gasto.estatus || 'en_proceso';
    document.getElementById('gf-categoria').value = gasto.categoria || '';
    document.getElementById('gf-sheet-url').value = gasto.sheet_url || '';

    document.getElementById('gastos-form-overlay').classList.add('open');
  } catch (err) {
    console.error('Edit gasto error:', err);
  }
}

function openGastoForm() {
  document.getElementById('gasto-edit-id').value = '';
  document.getElementById('gasto-form-title').textContent = '➕ Nuevo Gasto';
  document.getElementById('gf-proveedor').value = '';
  document.getElementById('gf-folio').value = '';
  document.getElementById('gf-fecha-factura').value = '';
  document.getElementById('gf-monto').value = '';
  document.getElementById('gf-concepto').value = '';
  document.getElementById('gf-fecha-solicitud').value = new Date().toISOString().substring(0, 10);
  document.getElementById('gf-estatus').value = 'en_proceso';
  document.getElementById('gf-categoria').value = '';
  document.getElementById('gf-sheet-url').value = '';
  hideErr('err-gasto-form');
  document.getElementById('gastos-form-overlay').classList.add('open');
}

function closeGastoForm() {
  document.getElementById('gastos-form-overlay').classList.remove('open');
}

async function saveGasto() {
  hideErr('err-gasto-form');
  const editId = document.getElementById('gasto-edit-id').value;
  const proveedor = document.getElementById('gf-proveedor').value.trim();
  const folio = document.getElementById('gf-folio').value.trim();

  if (!proveedor) return showErr('err-gasto-form', 'El nombre del proveedor es requerido.');
  if (!folio) return showErr('err-gasto-form', 'El folio es requerido.');

  const body = {
    proveedor,
    folio,
    fechaFactura: document.getElementById('gf-fecha-factura').value,
    monto: parseFloat(document.getElementById('gf-monto').value) || 0,
    concepto: document.getElementById('gf-concepto').value.trim(),
    fechaSolicitud: document.getElementById('gf-fecha-solicitud').value,
    estatus: document.getElementById('gf-estatus').value,
    categoria: document.getElementById('gf-categoria').value,
    sheet_url: document.getElementById('gf-sheet-url').value.trim()
  };

  setLoading('btn-save-gasto','spin-gasto',true);

  try {
    const url = editId ? `/api/gastos/${editId}` : '/api/gastos';
    const method = editId ? 'PUT' : 'POST';
    const r = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await r.json();
    if (!data.ok) return showErr('err-gasto-form', data.error);

    closeGastoForm();
    loadGastos();
    loadMeses();
  } catch (err) {
    showErr('err-gasto-form', 'Error: ' + err.message);
  } finally {
    setLoading('btn-save-gasto','spin-gasto',false);
  }
}

async function loadStats() {
  const rango = document.getElementById('filter-rango')?.value || '30';
  const mes = document.getElementById('filter-mes')?.value || '';
  const desde = document.getElementById('filter-desde')?.value || '';
  const hasta = document.getElementById('filter-hasta')?.value || '';
  
  // Multi-select categories
  const selectedCats = [];
  const cbs = document.querySelectorAll('#cat-checklist input[type="checkbox"]:checked');
  cbs.forEach(cb => selectedCats.push(cb.value));
  const cat = selectedCats.join(',');

  try {
    const r = await fetch(`/api/gastos/stats?rango=${rango}&mes=${mes}&desde=${desde}&hasta=${hasta}&categoria=${cat}`);
    const data = await r.json();
    if (data.ok) renderCharts(data.stats, rango);
  } catch(e) { 
    console.error('Stats error:', e); 
  }
}

// ── Multi-select Helpers ──────────────────────────────────────────────────────
function toggleCatDropdown(e) {
  e.stopPropagation();
  document.getElementById('cat-dropdown').classList.toggle('open');
}

window.addEventListener('click', () => {
  document.getElementById('cat-dropdown').classList.remove('open');
});

function handleCatChange(cb) {
  const allCb = document.getElementById('cat-all');
  const checklist = document.querySelectorAll('#cat-checklist input[type="checkbox"]');
  const trigger = document.getElementById('cat-trigger');

  if (cb.id === 'cat-all') {
    if (cb.checked) {
      checklist.forEach(c => c.checked = false);
    }
  } else {
    if (cb.checked) {
      allCb.checked = false;
    }
  }

  // Update Trigger Text
  const checked = document.querySelectorAll('#cat-checklist input[type="checkbox"]:checked');
  if (allCb.checked || checked.length === 0) {
    if (checked.length === 0) allCb.checked = true;
    trigger.textContent = 'Todas';
  } else if (checked.length === 1) {
    trigger.textContent = checked[0].value;
  } else {
    trigger.textContent = `Varios (${checked.length})`;
  }

  loadGastos();
  loadStats();
}

function selectOnlyAll() {
  const allCb = document.getElementById('cat-all');
  if (!allCb.checked) {
    allCb.checked = true;
    handleCatChange(allCb);
  }
}

async function loadMeses() {
  try {
    const r = await fetch('/api/gastos/meses');
    const data = await r.json();
    if (!data.ok) return;

    const sel = document.getElementById('filter-mes');
    const current = sel.value;
    sel.innerHTML = '<option value="">Todos los meses</option>';
    data.meses.forEach(m => {
      const o = document.createElement('option');
      o.value = m;
      o.textContent = fmtMes(m);
      sel.appendChild(o);
    });
    sel.value = current;
  } catch {}
}

function populateCategorias() {
  // Filter Checklist
  const checklist = document.getElementById('cat-checklist');
  if (checklist) {
    checklist.innerHTML = '';
    CATEGORIAS.forEach((c, idx) => {
      const id = `cat-item-${idx}`;
      const div = document.createElement('div');
      div.className = 'multi-option';
      div.innerHTML = `
        <input type="checkbox" id="${id}" value="${c}" onchange="handleCatChange(this)">
        <label for="${id}">${c}</label>
      `;
      checklist.appendChild(div);
    });
  }

  // Form dropdown (keep as single select)
  const formCat = document.getElementById('gf-categoria');
  if (formCat) {
    formCat.innerHTML = '<option value="">— Selecciona —</option>';
    CATEGORIAS.forEach(c => {
      const o = document.createElement('option');
      o.value = c; o.textContent = c;
      formCat.appendChild(o);
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  checkGoogleAuth();
  populateCategorias();
  loadMeses();
  loadGastos();
});

/** Helper to convert base64 to Blob for PDF display */
function b64toBlob(b64Data, contentType = '', sliceSize = 512) {
  // Clean string: remove any whitespace, newlines or Data-URI prefix
  const cleaned = b64Data.replace(/^data:application\/pdf;base64,/, '').replace(/\s/g, '');
  
  try {
    const byteCharacters = atob(cleaned);
    const byteArrays = [];
    for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
      const slice = byteCharacters.slice(offset, offset + sliceSize);
      const byteNumbers = new Array(slice.length);
      for (let i = 0; i < slice.length; i++) {
        byteNumbers[i] = slice.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      byteArrays.push(byteArray);
    }
    return new Blob(byteArrays, { type: contentType });
  } catch (e) {
    console.error('Error decoding base64:', e);
    throw new Error('El archivo PDF recibido no es válido (Base64 corrupto).');
  }
}
