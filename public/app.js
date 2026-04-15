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

const TOTAL_STEPS = 5; // Archivos, SAT, Drive, Buzón, Contrarecibo
const STEP_MAP = [0, 1, 2, 3, 6]; // Mapping of logical index to HTML element IDs

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

// Initialize Category Select options
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
});

// ── Helpers: UI ───────────────────────────────────────────────────────────────
function showErr(id, msg) { const el=document.getElementById(id); el.classList.add('show'); el.querySelector('span:last-child').textContent=msg; }
function hideErr(id) { document.getElementById(id).classList.remove('show'); }
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

    // ── Check UUID duplication ──
    try {
      const res = await fetch(`/api/gastos/check/${parsed.uuid}`);
      const dbCheck = await res.json();
      if (dbCheck.exists) {
        const proceed = window.confirm(`⚠️ ADVERTENCIA DE DUPLICIDAD\n\nEl sistema detectó que esta factura (UUID: ${parsed.uuid}) ya fue introducida anteriormente en el Control de Gastos.\n\n¿Estás seguro de que deseas continuar y procesarla (y pagarla) de nuevo?`);
        if (!proceed) return;
      }
    } catch (err) {
      console.warn('Network error checking UUID duplicates', err);
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
  } finally {
    setLoading('btn-sat-verify','spin-sat',false);
  }
}

// CAPTCHA RELAY — Automated workflow for Cloud
async function imprimirSAT() {
  hideErr('err-step1');
  setLoading('btn-print-sat','spin-print-sat',true);

  try {
    const c = state.cfdi;
    console.log('🏁 Iniciando proceso de impresión automática...');
    
    // First step: Initialize and get Captcha
    const r = await fetch('/api/sat/print-init', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        uuid:           c.uuid,
        rfcEmisor:      c.rfcEmisor,
        rfcReceptor:    c.rfcReceptor
      })
    });

    const data = await r.json();
    if (!data.ok) throw new Error(data.error || 'Error al iniciar sesión');

    // Show Captcha Modal
    state.currentSessionId = data.sessionId;
    document.getElementById('captcha-img').src = data.captcha;
    document.getElementById('captcha-solution').value = '';
    document.getElementById('captcha-overlay').style.display = 'flex';
    document.getElementById('captcha-solution').focus();

  } catch(err) {
    showErr('err-step1', 'Error: ' + err.message);
  } finally {
    setLoading('btn-print-sat','spin-print-sat',false);
  }
}

function closeCaptcha() {
  document.getElementById('captcha-overlay').style.display = 'none';
  state.currentSessionId = null;
}

async function submitCaptcha() {
  const solution = document.getElementById('captcha-solution').value;
  if (!solution) return alert('Por favor escribe el código de la imagen');
  if (!state.currentSessionId) return closeCaptcha();

  hideErr('err-step1');
  setLoading('btn-captcha-submit', 'spin-captcha', true); // Add small spin if needed, using primary for now
  document.getElementById('btn-captcha-submit').disabled = true;
  document.getElementById('btn-captcha-submit').textContent = '⏳ Procesando...';

  try {
    const r = await fetch('/api/sat/print-solve', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        sessionId: state.currentSessionId,
        solution: solution
      })
    });

    const contentType = r.headers.get('content-type');
    if (contentType && contentType.includes('application/pdf')) {
      console.log('✅ PDF recibido, descargando...');
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      closeCaptcha();
    } else {
      const data = await r.json();
      alert('⚠️ ' + (data.error || 'Código incorrecto. Intenta de nuevo.'));
      // If failed, we usually close and they try again or we could refresh captcha, 
      // but for simplicity we close session.
      closeCaptcha();
    }
  } catch(err) {
    alert('❌ Error al procesar: ' + err.message);
    closeCaptcha();
  } finally {
    document.getElementById('btn-captcha-submit').disabled = false;
    document.getElementById('btn-captcha-submit').textContent = '✅ Validar y Descargar';
  }
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
  setLoading('btn-drive','spin-drive',true);

  const fd = new FormData();
  fd.append('xml', state.xmlFile);
  fd.append('pdf', state.pdfFile);
  fd.append('proveedorNombre', proveedor);

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
    setLoading('btn-drive','spin-drive',false);
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
  if (state.sucursalFolderId) queryUrl += `&folderId=${state.sucursalFolderId}`;

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
    if (state.sucursalFolderId) queryUrl += `?folderId=${state.sucursalFolderId}`;

    const r = await fetch(queryUrl);
    const data = await r.json();
    if (!data.ok || !data.sheets) return;
    const sel = document.getElementById('sel-sheet');
    // Only add if not already populated
    if (sel.options.length <= 1) {
      data.sheets.forEach(s => {
        const o = document.createElement('option'); o.value=s.id; o.textContent=s.name; sel.appendChild(o);
      });
    }
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
    await autoRegistrarGasto(concepto, categoria);

    document.getElementById('final-success').style.display='block';
  } catch(err) {
    showErr('err-step6','Error: '+err.message);
  } finally {
    setLoading('btn-sheets-fill','spin-sheets',false);
  }
}

// Auto-register expense at the end of the flow
async function autoRegistrarGasto(concepto, categoria) {
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
        categoria: categoria || 'OTROS'
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
  const cat = document.getElementById('filter-cat').value;
  const est = document.getElementById('filter-estatus').value;

  let url = '/api/gastos?';
  if (mes) url += `mes=${encodeURIComponent(mes)}&`;
  if (cat) url += `categoria=${encodeURIComponent(cat)}&`;
  if (est) url += `estatus=${encodeURIComponent(est)}&`;

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
        <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(g.concepto)}">${escHtml(g.concepto)}</td>
        <td style="white-space:nowrap;">${fmtShortDate(g.fecha_solicitud)}</td>
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

let chartMensual = null;
let chartAnual = null;

async function loadStats() {
  try {
    const rango = document.getElementById('chart-filter-rango')?.value || 'todo';
    const r = await fetch(`/api/gastos/stats?rango=${rango}`);
    const data = await r.json();
    if (!data.ok) return;

    renderCharts(data.stats, rango);
  } catch (err) {
    console.error('Stats error:', err);
  }
}

function renderCharts(stats, rango) {
  const ctxA = document.getElementById('chart-anual').getContext('2d');

  if (chartAnual) chartAnual.destroy();

  // Color config for Light Theme
  const textColor = '#475569';
  const gridColor = 'rgba(0,0,0,0.05)';

  // Category Chart matches styling of the old layout
  chartAnual = new Chart(ctxA, {
    type: 'bar',
    data: {
      labels: stats.byCategory.slice(0, 5).map(c => c.categoria),
      datasets: [{
        label: 'Gasto por Categoría ($)',
        data: stats.byCategory.slice(0, 5).map(c => c.total),
        backgroundColor: ['#eb0a1e', '#1e293b', '#f59e0b', '#0ea5e9', '#8b5cf6'], // Toyota colors
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, grid: { color: gridColor }, ticks: { color: textColor } },
        y: { grid: { display: false }, ticks: { color: textColor } }
      }
    }
  });
}

function escHtml(str) {
  if (!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function toggleEstatus(id, current) {
  const newEstatus = current === 'en_proceso' ? 'pagado' : 'en_proceso';
  try {
    await fetch(`/api/gastos/${id}/estatus`, {
      method: 'PATCH', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ estatus: newEstatus })
    });
    loadGastos();
  } catch (err) {
    console.error('Toggle estatus error:', err);
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
    categoria: document.getElementById('gf-categoria').value
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
  // Filter dropdown
  const filterCat = document.getElementById('filter-cat');
  CATEGORIAS.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    filterCat.appendChild(o);
  });

  // Form dropdown
  const formCat = document.getElementById('gf-categoria');
  CATEGORIAS.forEach(c => {
    const o = document.createElement('option');
    o.value = c; o.textContent = c;
    formCat.appendChild(o);
  });
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  checkGoogleAuth();
  populateCategorias();
  loadMeses();
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
