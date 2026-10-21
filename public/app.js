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
  if (view === 'bandeja') loadBandeja();
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
    loadSheets(); // Cargar automáticamente todas las hojas de esta sucursal
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
    
    // Capturar enlace del PDF de factura
    const pdfArchivo = data.archivos ? data.archivos.find(a => a.tipo === 'PDF') : null;
    state.facturaUrl = pdfArchivo ? pdfArchivo.link : null;

    // Auto-registrar inmediatamente el gasto al subir los archivos a Drive
    await autoRegistrarGasto(null, null, null, state.facturaUrl);
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
    loadSheets(); // Si se vacía el buscador, cargar de nuevo todos los proveedores
    return;
  }

  statusEl.textContent = '🔍 Buscando...';
  statusEl.style.color = 'var(--text-muted)';

  const sucursalSel = document.getElementById('inp-sucursal');
  const sucursalName = sucursalSel.options[sucursalSel.selectedIndex].text;
  const prefix = sucursalName.includes('Poniente') ? 'PTE' : 'MATRIZ';
  let queryUrl = `/api/sheets/find?nombre=${encodeURIComponent(nombre)}&prefix=${prefix}`;

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
    const sucursalSel = document.getElementById('inp-sucursal');
    const sucursalName = sucursalSel.options[sucursalSel.selectedIndex].text;
    const prefix = sucursalName.includes('Poniente') ? 'PTE' : 'MATRIZ';
    
    let queryUrl = `/api/sheets/find?prefix=${prefix}`;
    console.log(`📡 Solicitando hojas para prefijo sucursal: ${prefix}`);
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
    await autoRegistrarGasto(concepto, categoria, data.sheetUrl, state.facturaUrl);

    document.getElementById('final-success').style.display='flex';
    document.getElementById('btn-sheets-fill').style.display='none';
  } catch(err) {
    showErr('err-step6','Error: '+err.message);
  } finally {
    setLoading('btn-sheets-fill','spin-sheets',false);
  }
}

// Auto-register expense at the end of the flow
async function autoRegistrarGasto(concepto, categoria, sheetUrl, facturaUrl) {
  if (!state.cfdi) return;
  const c = state.cfdi;
  const fechaFactura = c.fecha ? c.fecha.substring(0, 10) : '';
  const hoy = new Date().toISOString().substring(0, 10);

  const sucursalSel = document.getElementById('inp-sucursal');
  const sucursalName = sucursalSel.options[sucursalSel.selectedIndex].text;

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
        sheet_url: sheetUrl || '',
        factura_url: facturaUrl || state.facturaUrl || '',
        sucursal: sucursalName
      })
    });
    // Si esta factura provino de la Bandeja de Entrada, actualizar su estado en memoria
    if (c.uuid && Array.isArray(window.bandejaEmails)) {
      const targetUuid = String(c.uuid).toUpperCase();
      window.bandejaEmails.forEach(em => {
        (em.facturas || []).forEach(f => {
          if (String(f.uuid || '').toUpperCase() === targetUuid) {
            f.estatus = 'procesado';
            f.origenEstatus = 'gastos_db';
          }
        });
      });
      renderBandeja();
    }
  } catch (err) {
    console.error('Auto-registro gasto error:', err.message);
  }
}

// ── Settings / Google Auth ────────────────────────────────────────────────────
function openSettings() {
  document.getElementById('settings-overlay').classList.add('open');
  checkGoogleAuth();

  // Show tips for Render/Cloud environments
  const isLocal = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
  const renderNote = document.getElementById('render-note');
  if (renderNote) renderNote.style.display = isLocal ? 'none' : 'block';
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
    return d.authorized;
  } catch {
    return false;
  }
}

async function authGoogle() {
  try {
    const r = await fetch('/api/drive/auth-url');
    const d = await r.json();
    if (d.url) window.open(d.url,'_blank');
    // Poll for auth completion (more aggressive for better UX)
    let checks = 0;
    const interval = setInterval(async () => {
        const authorized = await checkGoogleAuth();
        checks++;
        if (authorized) {
            loadBandeja(true);
        }
        if (authorized || checks > 12) {
            clearInterval(interval);
            if (authorized) loadSheets();
        }
    }, 4000);
  } catch(err) { alert('Error: '+err.message); }
}

async function logoutGoogle() {
  if (!confirm('¿Seguro que quieres cerrar la sesión de Google?')) return;
  try {
    const r = await fetch('/api/drive/logout', { method: 'POST' });
    const d = await r.json();
    alert(d.message);
    await checkGoogleAuth();
  } catch(err) { alert('Error: ' + err.message); }
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

function updateSummaryCards(data) {
  if (!data || !data.resumen || !data.gastos) return;

  // 1. Actualizar totales generales
  document.getElementById('gs-count').textContent = data.resumen.count;
  document.getElementById('gs-total').textContent = fmtMonto(String(data.resumen.total), 'MXN');
  document.getElementById('gs-proceso').textContent = data.resumen.enProceso;
  document.getElementById('gs-pagados').textContent = data.resumen.pagados;

  // 2. Calcular montos divididos para Oriente (Chiapas) y Poniente
  let totalOriente = 0;
  let totalPoniente = 0;
  let countOriente = 0;
  let countPoniente = 0;
  let procesoOriente = 0;
  let procesoPoniente = 0;
  let pagadoOriente = 0;
  let pagadoPoniente = 0;

  data.gastos.forEach(g => {
    const rawSuc = g.sucursal || (g.categoria === 'TOYOTA PONIENTE' ? 'Toyota Farrera Poniente' : 'Toyota Chiapas');
    const isPoniente = rawSuc.includes('Poniente');
    const monto = g.monto || 0;
    
    if (isPoniente) {
      totalPoniente += monto;
      countPoniente++;
      if (g.estatus === 'en_proceso') procesoPoniente++;
      if (g.estatus === 'pagado') pagadoPoniente++;
    } else {
      totalOriente += monto;
      countOriente++;
      if (g.estatus === 'en_proceso') procesoOriente++;
      if (g.estatus === 'pagado') pagadoOriente++;
    }
  });

  // 3. Escribir texto de desglose en el pie de las tarjetas
  const elCountSplit = document.getElementById('gs-count-split');
  const elTotalSplit = document.getElementById('gs-total-split');
  const elProcesoSplit = document.getElementById('gs-proceso-split');
  const elPagadosSplit = document.getElementById('gs-pagados-split');

  if (elCountSplit) elCountSplit.textContent = `Oriente: ${countOriente} | Poniente: ${countPoniente}`;
  if (elTotalSplit) elTotalSplit.textContent = `Oriente: ${fmtMonto(String(totalOriente), 'MXN')} | Poniente: ${fmtMonto(String(totalPoniente), 'MXN')}`;
  if (elProcesoSplit) elProcesoSplit.textContent = `Oriente: ${procesoOriente} | Poniente: ${procesoPoniente}`;
  if (elPagadosSplit) elPagadosSplit.textContent = `Oriente: ${pagadoOriente} | Poniente: ${pagadoPoniente}`;
}

async function loadGastos() {
  const mes = document.getElementById('filter-mes').value;
  const anio = document.getElementById('filter-anio').value;
  const prov = document.getElementById('filter-proveedor')?.value || '';
  const est = document.getElementById('filter-estatus').value;
  const desde = document.getElementById('filter-desde').value;
  const hasta = document.getElementById('filter-hasta').value;

  // Multi-select categories
  const selectedCats = [];
  const cbs = document.querySelectorAll('#cat-checklist input[type="checkbox"]:checked');
  cbs.forEach(cb => selectedCats.push(cb.value));
  const cat = selectedCats.join('|');

  const suc = document.getElementById('filter-sucursal')?.value || '';
  let url = '/api/gastos?';
  if (mes) url += `mes=${encodeURIComponent(mes)}&`;
  if (anio) url += `anio=${encodeURIComponent(anio)}&`;
  if (cat) url += `categoria=${encodeURIComponent(cat)}&`;
  if (prov) url += `proveedor=${encodeURIComponent(prov.trim())}&`;
  if (est) url += `estatus=${encodeURIComponent(est)}&`;
  if (desde) url += `desde=${encodeURIComponent(desde)}&`;
  if (hasta) url += `hasta=${encodeURIComponent(hasta)}&`;
  if (suc) url += `sucursal=${encodeURIComponent(suc)}&`;

  try {
    const r = await fetch(url);
    const data = await r.json();
    
    const tbody = document.getElementById('gastos-tbody');
    const empty = document.getElementById('gastos-empty');
    const tableContainer = document.getElementById('gastos-table-container');

    gastosCache = (data.ok && data.gastos) ? data.gastos : [];

    if (!data.ok || !data.gastos || data.gastos.length === 0) {
      tbody.innerHTML = '';
      if (empty) empty.style.display = 'block';
      if (tableContainer) tableContainer.style.display = 'none';
      
      updateSummaryCards(data);
      loadStats();
      return;
    }

    if (empty) empty.style.display = 'none';
    if (tableContainer) tableContainer.style.display = 'block';

    updateSummaryCards(data);

    tbody.innerHTML = data.gastos.map(g => {
      const rawSuc = g.sucursal || (g.categoria === 'TOYOTA PONIENTE' ? 'Toyota Farrera Poniente' : 'Toyota Chiapas');
      const cleanSuc = rawSuc.includes('Poniente') ? 'Poniente' : 'Chiapas';
      
      return `
        <tr>
          <td class="prov-cell">${escHtml(g.proveedor)}</td>
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
                `<span class="pago-placeholder" onclick="triggerUploadPago('${g.id}')" style="opacity:0.3;cursor:pointer;" title="Clic para subir o arrastra el PDF aquí">＋</span>`
              }
            </div>
          </td>
          <td class="concepto-cell">${escHtml(g.concepto)}</td>
          <td style="white-space:nowrap;">${fmtShortDate(g.fecha_solicitud)}</td>
          <td style="text-align:center;">
            ${g.sheet_url ? `<a href="${g.sheet_url}" target="_blank" title="Ver Contrarecibo" style="font-size:16px;text-decoration:none;">📊</a>` : '—'}
          </td>
          <td class="factura-cell" style="text-align:center;" ondragover="event.preventDefault(); this.classList.add('drag-over')" ondragleave="this.classList.remove('drag-over')" ondrop="handleFacturaDrop(event, '${g.id}')">
            <div class="factura-cell-content">
              ${g.factura_url ? 
                `<div class="pago-link-wrap">
                  <a href="/api/gastos/${g.id}/download-factura" target="_blank" title="Ver Factura (PDF)" style="font-size:18px;text-decoration:none;">🧾</a>
                  <button class="pago-delete-btn" onclick="borrarFactura('${g.id}')" title="Eliminar Factura">×</button>
                </div>` : 
                `<span class="pago-placeholder" onclick="triggerUploadFactura('${g.id}')" style="opacity:0.3;cursor:pointer;" title="Clic para subir o arrastra el PDF de la factura">＋</span>`
              }
            </div>
          </td>
          <td>
            <span class="estatus-tag ${g.estatus}" onclick="toggleEstatus('${g.id}','${g.estatus}')" style="cursor:pointer" title="Hacer clic para cambiar estado">
              <span class="estatus-dot"></span>
              ${g.estatus === 'en_proceso' ? 'En proceso' : 'Pagado'}
            </span>
          </td>
          <td>
            <span class="suc-tag" style="background:#1e293b; color:#cbd5e1; padding:4px 8px; border-radius:6px; font-size:11px; font-weight:600; text-transform:uppercase;">
              ${escHtml(cleanSuc)}
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
      `;
    }).join('');

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

function triggerUploadPago(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await uploadComprobante(id, file);
    } catch (err) {
      alert('Error al subir comprobante: ' + err.message);
    }
  };
  input.click();
}

// ── Manejo de Factura (PDF) ──
function triggerUploadFactura(id) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/pdf';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await uploadFactura(id, file);
    } catch (err) {
      alert('Error al subir factura: ' + err.message);
    }
  };
  input.click();
}

async function handleFacturaDrop(e, id) {
  e.preventDefault();
  const cell = e.currentTarget;
  cell.classList.remove('drag-over');

  const file = e.dataTransfer.files[0];
  if (!file) return;

  if (file.type !== 'application/pdf') {
    alert('Por favor, sube solo archivos PDF.');
    return;
  }

  const content = cell.querySelector('.factura-cell-content');
  const oldHtml = content ? content.innerHTML : '';
  if (content) content.innerHTML = '<span class="spin-small"></span>';

  try {
    await uploadFactura(id, file);
  } catch (err) {
    alert('Error al subir factura: ' + err.message);
    if (content) content.innerHTML = oldHtml;
  }
}

async function uploadFactura(id, file) {
  const fd = new FormData();
  fd.append('file', file);

  const r = await fetch(`/api/gastos/${id}/upload-factura`, {
    method: 'POST',
    body: fd
  });
  const data = await r.json();
  if (!data.ok) throw new Error(data.error);

  loadGastos();
}

async function borrarFactura(id) {
  if (!confirm('¿Estás seguro de que deseas eliminar el enlace a esta factura?')) return;
  try {
    const r = await fetch(`/api/gastos/${id}/factura`, { method: 'DELETE' });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error);
    loadGastos();
  } catch (err) {
    alert('Error al eliminar factura: ' + err.message);
  }
}

// ── Memo de Comprobantes Pendientes ──
function abrirMemoPendientes() {
  const pendientes = (gastosCache || []).filter(g => g.estatus !== 'pagado' || !g.comprobante_pago_url);

  if (pendientes.length === 0) {
    alert('✅ ¡Excelente! No hay comprobantes de pago pendientes con los filtros actualmente seleccionados.');
    return;
  }

  // Contexto de los filtros para el subtítulo
  const mesEl = document.getElementById('filter-mes');
  const anioEl = document.getElementById('filter-anio');
  const sucEl = document.getElementById('filter-sucursal');
  const mesNombre = (mesEl && mesEl.options[mesEl.selectedIndex]) ? mesEl.options[mesEl.selectedIndex].text : '';
  const anioVal = anioEl ? anioEl.value : '';
  const sucVal = (sucEl && sucEl.options[sucEl.selectedIndex]) ? sucEl.options[sucEl.selectedIndex].text : 'Todas';

  let sub = `${pendientes.length} pago(s) pendiente(s)`;
  if (mesNombre && mesNombre !== 'Todos los meses') sub += ` • Mes: ${mesNombre}`;
  if (anioVal) sub += ` ${anioVal}`;
  if (sucVal && sucVal !== 'Todas') sub += ` • Sucursal: ${sucVal}`;
  const subEl = document.getElementById('memo-subtitle');
  if (subEl) subEl.textContent = sub;

  // Calcular total
  let totalMonto = 0;

  // Construir cuerpo del memo según lo solicitado exactamente
  let cuerpo = `Buen día, ¿me pueden apoyar con los comprobantes de pago faltantes?\n\n`;
  cuerpo += `Detalle de pagos pendientes:\n`;
  cuerpo += `──────────────────────────────────────────────────\n\n`;

  pendientes.forEach((g, idx) => {
    const montoNum = parseFloat(g.monto) || 0;
    totalMonto += montoNum;
    const fechaSol = g.fecha_solicitud ? fmtShortDate(g.fecha_solicitud) : (g.fecha_factura ? fmtShortDate(g.fecha_factura) : '—');
    const montoFmt = fmtMonto(String(g.monto), 'MXN');

    cuerpo += `${idx + 1}. Proveedor: ${g.proveedor || '—'}\n`;
    cuerpo += `   • Folio: ${g.folio || '—'}\n`;
    cuerpo += `   • Fecha de Solicitud: ${fechaSol}\n`;
    cuerpo += `   • Monto: ${montoFmt}\n`;
    cuerpo += `   • Concepto: ${g.concepto || '—'}\n\n`;
  });

  cuerpo += `──────────────────────────────────────────────────\n`;
  cuerpo += `Total de pagos pendientes: ${pendientes.length}\n`;
  cuerpo += `Monto total acumulado: ${fmtMonto(String(totalMonto), 'MXN')}\n\n`;
  cuerpo += `Quedo atento. Muchas gracias.`;

  const ta = document.getElementById('memo-cuerpo');
  if (ta) ta.value = cuerpo;

  // Asunto
  let asunto = `Solicitud de Comprobantes de Pago Faltantes`;
  if (mesNombre && mesNombre !== 'Todos los meses') asunto += ` - ${mesNombre} ${anioVal}`;
  if (sucVal && sucVal !== 'Todas') asunto += ` (${sucVal})`;
  const asEl = document.getElementById('memo-asunto');
  if (asEl) asEl.value = asunto;

  const overlay = document.getElementById('memo-pendientes-overlay');
  if (overlay) overlay.classList.add('open');
}

function cerrarMemoPendientes() {
  const overlay = document.getElementById('memo-pendientes-overlay');
  if (overlay) overlay.classList.remove('open');
}

function enviarMemoMailto() {
  const dest = document.getElementById('memo-destinatario')?.value.trim() || '';
  const asunto = document.getElementById('memo-asunto')?.value.trim() || 'Solicitud de Comprobantes de Pago Faltantes';
  const cuerpo = document.getElementById('memo-cuerpo')?.value || '';

  const mailtoUrl = `mailto:${encodeURIComponent(dest)}?subject=${encodeURIComponent(asunto)}&body=${encodeURIComponent(cuerpo)}`;
  window.open(mailtoUrl, '_blank');
}

async function copiarMemoAlPortapapeles() {
  const cuerpo = document.getElementById('memo-cuerpo')?.value || '';
  const lbl = document.getElementById('lbl-copiar-memo');
  try {
    await navigator.clipboard.writeText(cuerpo);
    if (lbl) {
      const orig = lbl.textContent;
      lbl.textContent = '¡Copiado!';
      setTimeout(() => { lbl.textContent = orig; }, 2000);
    }
  } catch (err) {
    const ta = document.getElementById('memo-cuerpo');
    if (ta) {
      ta.select();
      document.execCommand('copy');
      if (lbl) {
        const orig = lbl.textContent;
        lbl.textContent = '¡Copiado!';
        setTimeout(() => { lbl.textContent = orig; }, 2000);
      }
    }
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
    document.getElementById('gf-factura-url').value = gasto.factura_url || '';
    
    const defSuc = gasto.sucursal || (gasto.categoria === 'TOYOTA PONIENTE' ? 'Toyota Farrera Poniente' : 'Toyota Chiapas');
    document.getElementById('gf-sucursal').value = defSuc;

    applyRoleRestrictions();

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
  document.getElementById('gf-factura-url').value = '';
  document.getElementById('gf-sucursal').value = 'Toyota Chiapas';
  
  applyRoleRestrictions();

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
    sheet_url: document.getElementById('gf-sheet-url').value.trim(),
    factura_url: document.getElementById('gf-factura-url').value.trim(),
    sucursal: document.getElementById('gf-sucursal').value
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
  } catch (err) {
    showErr('err-gasto-form', 'Error: ' + err.message);
  } finally {
    setLoading('btn-save-gasto','spin-gasto',false);
  }
}

async function loadStats() {
  const rango = document.getElementById('filter-rango')?.value || '30';
  const mes = document.getElementById('filter-mes')?.value || '';
  const anio = document.getElementById('filter-anio')?.value || '';
  const prov = document.getElementById('filter-proveedor')?.value || '';
  const desde = document.getElementById('filter-desde')?.value || '';
  const hasta = document.getElementById('filter-hasta')?.value || '';
  
  // Multi-select categories
  const selectedCats = [];
  const cbs = document.querySelectorAll('#cat-checklist input[type="checkbox"]:checked');
  cbs.forEach(cb => selectedCats.push(cb.value));
  const cat = selectedCats.join('|');

  const suc = document.getElementById('filter-sucursal')?.value || '';
  try {
    const r = await fetch(`/api/gastos/stats?rango=${rango}&mes=${mes}&anio=${anio}&desde=${desde}&hasta=${hasta}&categoria=${cat}&proveedor=${encodeURIComponent(prov.trim())}&sucursal=${encodeURIComponent(suc)}`);
    const data = await r.json();
    if (data.ok) renderCharts(data.stats, rango);
  } catch(e) { 
    console.error('Stats error:', e); 
  }
}

let debounceTimer = null;
function debounceLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    loadGastos();
    loadStats();
  }, 400);
}

async function loadProveedores() {
  try {
    const r = await fetch('/api/gastos/proveedores');
    const data = await r.json();
    if (!data.ok) return;
    
    const dl = document.getElementById('list-proveedores');
    if (!dl) return;
    dl.innerHTML = '';
    data.proveedores.forEach(p => {
      const o = document.createElement('option');
      o.value = p;
      dl.appendChild(o);
    });
  } catch (err) {
    console.error('Error cargando proveedores:', err);
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

// ── Authentication & Role Restrictions ────────────────────────────────────────
let userRole = 'admin';

async function checkUserRole() {
  try {
    const r = await fetch('/api/auth/me', { cache: 'no-store' });
    if (r.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    const data = await r.json();
    if (data.ok) {
      const prevRole = userRole;
      userRole = data.role;
      const fullName = data.user?.fullName || '';
      const roleLabel = userRole === 'admin' ? 'Admin (Ambas Sucursales)' : (userRole === 'poniente' ? 'Poniente' : 'Oriente');
      const icon = userRole === 'admin' ? '👤' : '📍';
      
      const tag = document.getElementById('user-display-tag');
      if (tag) {
        tag.style.display = 'inline-block';
        tag.textContent = fullName ? `${icon} ${fullName} · ${roleLabel}` : `${icon} ${roleLabel}`;
      }
      
      applyRoleRestrictions();
      if (prevRole !== userRole) {
        renderBandeja();
        loadGastos();
      }
    }
  } catch (err) {
    console.error('Error checking user role:', err);
  }
}

// Revalidar permisos en tiempo real al volver a la pestaña y cada 25s
window.addEventListener('focus', () => checkUserRole());
setInterval(() => checkUserRole(), 25000);

function applyRoleRestrictions() {
  const filterSuc = document.getElementById('filter-sucursal');
  const gfSuc = document.getElementById('gf-sucursal');
  const inpSuc = document.getElementById('inp-sucursal');
  const bandejaSuc = document.getElementById('bandeja-sucursal');
  
  const fieldFilter = document.getElementById('field-filter-sucursal');
  const fieldGf = document.getElementById('field-gf-sucursal');
  const fieldInp = document.getElementById('field-inp-sucursal');
  const fieldBandejaSuc = document.getElementById('field-bandeja-sucursal');

  if (userRole === 'poniente') {
    if (filterSuc) filterSuc.value = 'Toyota Farrera Poniente';
    if (fieldFilter) fieldFilter.style.display = 'none';
    if (bandejaSuc) bandejaSuc.value = 'Toyota Farrera Poniente';
    if (fieldBandejaSuc) fieldBandejaSuc.style.display = 'none';

    if (gfSuc) {
      gfSuc.value = 'Toyota Farrera Poniente';
      gfSuc.disabled = true;
    }
    if (fieldGf) fieldGf.style.display = 'none';

    if (inpSuc) {
      inpSuc.value = '1HNbEOOw5sm37AfFZ1JSgKtKcAL-qqpjN';
      inpSuc.disabled = true;
    }
    if (fieldInp) fieldInp.style.display = 'none';

  } else if (userRole === 'oriente') {
    if (filterSuc) filterSuc.value = 'Toyota Chiapas';
    if (fieldFilter) fieldFilter.style.display = 'none';
    if (bandejaSuc) bandejaSuc.value = 'Toyota Chiapas';
    if (fieldBandejaSuc) fieldBandejaSuc.style.display = 'none';

    if (gfSuc) {
      gfSuc.value = 'Toyota Chiapas';
      gfSuc.disabled = true;
    }
    if (fieldGf) fieldGf.style.display = 'none';

    if (inpSuc) {
      inpSuc.value = '1t-dylPS1zV54AJE2eGozKJDR4RqUtNO7';
      inpSuc.disabled = true;
    }
    if (fieldInp) fieldInp.style.display = 'none';
  } else {
    if (fieldFilter) fieldFilter.style.display = '';
    if (fieldBandejaSuc) fieldBandejaSuc.style.display = '';
    if (gfSuc) gfSuc.disabled = false;
    if (fieldGf) fieldGf.style.display = '';
    if (inpSuc) inpSuc.disabled = false;
    if (fieldInp) fieldInp.style.display = '';
  }
}

// ── BANDEJA DE ENTRADA (GMAIL PRE-PASO A PAGO) ────────────────────────────────
window.bandejaEmails = [];
let bandejaLoading = false;

function getAttachmentIcon(filename = '') {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.pdf')) return '📑';
  if (lower.endsWith('.xml')) return '📄';
  if (/\.(png|jpg|jpeg|gif|webp)$/.test(lower)) return '🖼️';
  if (/\.(xls|xlsx|csv)$/.test(lower)) return '📊';
  if (/\.(doc|docx)$/.test(lower)) return '📝';
  if (/\.(zip|rar)$/.test(lower)) return '🗜️';
  return '📎';
}

function fmtEmailDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  return d.toLocaleDateString('es-MX', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function loadBandeja(force = false) {
  if (bandejaLoading && !force) return;
  bandejaLoading = true;

  const btn = document.getElementById('btn-refresh-bandeja');
  const spin = document.getElementById('spin-bandeja');
  if (btn) btn.disabled = true;
  if (spin) spin.style.display = 'inline-block';

  const listEl = document.getElementById('bandeja-list');
  if (listEl && (window.bandejaEmails.length === 0 || force)) {
    listEl.innerHTML = `
      <div class="card" style="text-align:center; padding:45px 20px; color:#475569;">
        <div style="font-size:32px; margin-bottom:10px;">📬</div>
        <div style="font-weight:600; font-size:15px;">Sincronizando tu Bandeja de Gmail...</div>
        <div style="font-size:13px; color:#64748b; margin-top:4px;">Buscando correos con facturas (.xml + .pdf) y agrupando su documentación adjunta.</div>
      </div>
    `;
  }

  try {
    const anio = document.getElementById('bandeja-anio')?.value || 'todos';
    const mes = document.getElementById('bandeja-mes')?.value || 'todos';
    const res = await fetch(`/api/mail/inbox?anio=${encodeURIComponent(anio)}&mes=${encodeURIComponent(mes)}`);
    const data = await res.json();

    const banner = document.getElementById('bandeja-auth-banner');

    if (!res.ok || !data.ok) {
      if (data.needsAuth || data.needsGmailScope || res.status === 401 || res.status === 403) {
        if (banner) banner.style.display = 'block';
        if (listEl) {
          listEl.innerHTML = `
            <div class="card empty-state" style="padding:45px 24px;">
              <div class="empty-icon">🔐</div>
              <div class="empty-title">Conecta tu correo de Gmail para ver tus facturas recibidas</div>
              <div class="empty-sub" style="max-width:520px; margin:8px auto 20px;">
                Haz clic en el botón de abajo para autorizar por única vez la lectura de correos con facturas (<code>.xml</code> y <code>.pdf</code>) y sus anexos.
              </div>
              <button class="btn btn-primary" onclick="authGoogle()" style="padding:10px 22px; font-size:14px;">
                🔗 Conectar y Autorizar Gmail
              </button>
            </div>
          `;
        }
        return;
      }
      throw new Error(data.error || 'Error al consultar la bandeja de entrada');
    }

    if (banner) banner.style.display = 'none';
    window.bandejaEmails = data.correos || [];
    renderBandeja();
  } catch (err) {
    console.error('Error en loadBandeja:', err);
    if (listEl) {
      listEl.innerHTML = `
        <div class="card empty-state">
          <div class="empty-icon">⚠️</div>
          <div class="empty-title">No se pudo cargar la Bandeja de Entrada</div>
          <div class="empty-sub">${esc(err.message)}</div>
          <button class="btn btn-outline" onclick="loadBandeja(true)" style="margin-top:16px;">🔄 Reintentar</button>
        </div>
      `;
    }
  } finally {
    bandejaLoading = false;
    if (btn) btn.disabled = false;
    if (spin) spin.style.display = 'none';
  }
}

function renderBandeja() {
  const listEl = document.getElementById('bandeja-list');
  if (!listEl) return;

  const search = (document.getElementById('bandeja-search')?.value || '').trim().toLowerCase();
  const estatusFilter = document.getElementById('bandeja-estatus')?.value || 'todos';
  const sucursalFilter = document.getElementById('bandeja-sucursal')?.value || 'todas';

  let totalFacturas = 0;
  let totalPendientes = 0;
  let totalProcesadas = 0;
  let montoPendiente = 0;

  // Primero contabilizar KPIs globales (respetando sucursal)
  for (const correo of window.bandejaEmails) {
    for (const f of (correo.facturas || [])) {
      if (sucursalFilter !== 'todas' && f.sucursal !== sucursalFilter) continue;
      if (f.estatus === 'descartado' && estatusFilter !== 'descartado') {
        // No inflar pendientes con descartados
        continue;
      }
      totalFacturas++;
      if (f.estatus === 'procesado') {
        totalProcesadas++;
      } else if (f.estatus === 'pendiente') {
        totalPendientes++;
        montoPendiente += Number(f.total) || 0;
      }
    }
  }

  const elTotal = document.getElementById('bandeja-stat-total');
  const elPend = document.getElementById('bandeja-stat-pendientes');
  const elProc = document.getElementById('bandeja-stat-procesadas');
  const elMonto = document.getElementById('bandeja-stat-monto');
  const badgeTab = document.getElementById('bandeja-badge-pendientes');

  if (elTotal) elTotal.textContent = String(totalFacturas);
  if (elPend) elPend.textContent = String(totalPendientes);
  if (elProc) elProc.textContent = String(totalProcesadas);
  if (elMonto) elMonto.textContent = fmtMonto(String(montoPendiente), 'MXN');
  if (badgeTab) {
    badgeTab.textContent = String(totalPendientes);
    badgeTab.style.display = totalPendientes > 0 ? 'inline-flex' : 'none';
  }

  // Filtrar correos y sus facturas para renderizar las tarjetas (Opción A)
  const cardsHtml = [];

  for (const correo of window.bandejaEmails) {
    const facturasFiltradas = [];
    (correo.facturas || []).forEach((f, idxOriginal) => {
      if (sucursalFilter !== 'todas' && f.sucursal !== sucursalFilter) return;

      if (estatusFilter === 'todos') {
        if (f.estatus === 'descartado') return; // Ocultar descartados en vista 'Todos' a menos que se elija 'Descartados'
      } else if (f.estatus !== estatusFilter) {
        return;
      }

      if (search) {
        const hay = `${correo.fromName} ${correo.fromEmail} ${correo.subject} ${f.nombreEmisor} ${f.rfcEmisor} ${f.folio} ${f.uuid} ${f.concepto}`.toLowerCase();
        if (!hay.includes(search)) return;
      }

      facturasFiltradas.push({ f, idxOriginal });
    });

    if (facturasFiltradas.length === 0) continue;

    const hasPending = facturasFiltradas.some(x => x.f.estatus === 'pendiente');
    const allProcessed = facturasFiltradas.every(x => x.f.estatus === 'procesado');
    const cardStateClass = hasPending ? 'has-pending' : (allProcessed ? 'all-processed' : '');

    const invoicesHtml = facturasFiltradas.map(({ f, idxOriginal }) => {
      const xmlUrl = `/api/mail/attachment/${encodeURIComponent(correo.messageId)}/${encodeURIComponent(f.xml.attachmentId)}?filename=${encodeURIComponent(f.xml.filename)}&mimeType=application/xml`;
      const pdfChip = f.pdf
        ? `<a href="/api/mail/attachment/${encodeURIComponent(correo.messageId)}/${encodeURIComponent(f.pdf.attachmentId)}?filename=${encodeURIComponent(f.pdf.filename)}&mimeType=application/pdf" target="_blank" class="bandeja-file-chip pdf" title="Abrir PDF de la factura en nueva pestaña">📕 ${esc(f.pdf.filename)} <span style="opacity:.75;">(👁️ Ver)</span></a>`
        : `<span class="bandeja-file-chip" style="border-color:#fde68a; background:#fffbeb; color:#b45309; cursor:default;">⚠️ Sin PDF de factura adjunto</span>`;

      let statusPill = '';
      if (f.estatus === 'procesado') {
        const subLbl = f.origenEstatus === 'gastos_db' ? 'En Control de Gastos' : 'Marcado Manual';
        statusPill = `<span class="bandeja-status-pill procesado">✅ PROCESADO · ${subLbl}</span>`;
      } else if (f.estatus === 'descartado') {
        statusPill = `<span class="bandeja-status-pill descartado">🚫 DESCARTADO</span>`;
      } else {
        statusPill = `<span class="bandeja-status-pill pendiente">⏳ PENDIENTE</span>`;
      }

      const selectId = `bandeja-suc-${correo.messageId}-${idxOriginal}`;
      const disableSuc = userRole !== 'admin' ? 'disabled' : '';
      const sucursalSelector = `
        <select id="${selectId}" style="padding:5px 8px; font-size:12px; border-radius:6px; border:1px solid #cbd5e1; background:#fff; color:#1e293b; font-weight:600;" ${disableSuc} title="Sucursal destino para procesar el pago">
          <option value="Toyota Chiapas" ${f.sucursal === 'Toyota Chiapas' ? 'selected' : ''}>🏢 Oriente (Chiapas)</option>
          <option value="Toyota Farrera Poniente" ${f.sucursal === 'Toyota Farrera Poniente' ? 'selected' : ''}>🏢 Poniente</option>
        </select>
      `;

      let actionBtns = '';
      if (f.estatus === 'pendiente') {
        actionBtns = `
          <button class="btn btn-outline" style="padding:5px 10px; font-size:11px; color:#15803d; border-color:#86efac;" onclick="cambiarEstatusBandeja('${esc(correo.messageId)}', '${esc(f.idClave)}', '${esc(f.uuid)}', 'procesado')" title="Marcar manualmente como ya procesado">
            ✓ Marcar Procesado
          </button>
          <button class="btn btn-outline" style="padding:5px 10px; font-size:11px; color:#64748b;" onclick="cambiarEstatusBandeja('${esc(correo.messageId)}', '${esc(f.idClave)}', '${esc(f.uuid)}', 'descartado')" title="Descartar de la bandeja">
            ✕
          </button>
          <button class="btn btn-primary" id="btn-proc-${correo.messageId}-${idxOriginal}" style="padding:6px 14px; font-size:12px; font-weight:700;" onclick="procesarFacturaDesdeBandeja('${esc(correo.messageId)}', ${idxOriginal})">
            ⚡ Procesar a Pago →
          </button>
        `;
      } else {
        const revertBtn = f.origenEstatus !== 'gastos_db'
          ? `<button class="btn btn-outline" style="padding:5px 10px; font-size:11px;" onclick="cambiarEstatusBandeja('${esc(correo.messageId)}', '${esc(f.idClave)}', '${esc(f.uuid)}', 'pendiente')">↩ Volver a Pendiente</button>`
          : '';
        actionBtns = `
          ${revertBtn}
          <button class="btn btn-outline" id="btn-proc-${correo.messageId}-${idxOriginal}" style="padding:5px 12px; font-size:12px;" onclick="procesarFacturaDesdeBandeja('${esc(correo.messageId)}', ${idxOriginal})" title="Cargar de nuevo en el Flujo de Facturas">
            ⚡ Cargar en Flujo →
          </button>
        `;
      }

      return `
        <div class="bandeja-invoice-box ${f.estatus}">
          <div class="bandeja-invoice-top">
            <div class="bandeja-invoice-meta">
              <span style="font-weight:700; color:#0f172a; font-size:14px;">🏢 ${esc(f.nombreEmisor)}</span>
              <span style="font-size:12px; color:#64748b;">RFC: ${esc(f.rfcEmisor)}</span>
              <span style="background:#e2e8f0; padding:2px 8px; border-radius:4px; font-weight:700; font-size:12px;">Folio: ${esc(f.folio)}</span>
              <span style="font-weight:800; color:#2563eb; font-size:14px;">${fmtMonto(String(f.total), f.moneda)}</span>
              ${f.fechaFactura ? `<span style="font-size:12px; color:#475569;">📅 Factura: ${fmtFecha(f.fechaFactura)}</span>` : ''}
            </div>
            <div>${statusPill}</div>
          </div>

          ${f.concepto ? `<div class="bandeja-invoice-concepto"><strong>Concepto:</strong> ${esc(f.concepto)} <span style="color:#94a3b8; font-size:11px; margin-left:6px;">(UUID: ${esc(f.uuid)})</span></div>` : `<div class="bandeja-invoice-concepto" style="color:#94a3b8;">UUID: ${esc(f.uuid)}</div>`}

          <div class="bandeja-invoice-bottom">
            <div class="bandeja-files-row">
              <a href="${xmlUrl}" target="_blank" class="bandeja-file-chip xml" title="Ver o descargar archivo XML">📄 ${esc(f.xml.filename)}</a>
              ${pdfChip}
            </div>
            <div class="bandeja-actions-row">
              ${sucursalSelector}
              ${actionBtns}
            </div>
          </div>
        </div>
      `;
    }).join('');

    // Sección de Documentación adicional adjunta en el mismo correo
    let extraDocsHtml = '';
    if (Array.isArray(correo.adjuntosExtra) && correo.adjuntosExtra.length > 0) {
      const chips = correo.adjuntosExtra.map(att => {
        const icon = getAttachmentIcon(att.filename);
        const url = `/api/mail/attachment/${encodeURIComponent(correo.messageId)}/${encodeURIComponent(att.attachmentId)}?filename=${encodeURIComponent(att.filename)}&mimeType=${encodeURIComponent(att.mimeType || 'application/octet-stream')}`;
        return `<a href="${url}" target="_blank" class="bandeja-file-chip extra" title="Abrir documento adjunto en nueva pestaña">${icon} ${esc(att.filename)} <span style="opacity:.7;">(👁️ Ver)</span></a>`;
      }).join('');

      extraDocsHtml = `
        <div class="bandeja-extra-docs">
          <div class="bandeja-extra-title">📎 Documentación adicional adjunta en este correo (${correo.adjuntosExtra.length}):</div>
          <div class="bandeja-files-row">${chips}</div>
        </div>
      `;
    }

    cardsHtml.push(`
      <div class="bandeja-email-card ${cardStateClass}">
        <div class="bandeja-email-header">
          <div>
            <div class="bandeja-sender-title">
              <span>✉️ ${esc(correo.fromName)}</span>
              <span class="bandeja-sender-email">&lt;${esc(correo.fromEmail)}&gt;</span>
            </div>
            <div class="bandeja-subject">Asunto: <strong>${esc(correo.subject)}</strong></div>
          </div>
          <div class="bandeja-date-badge">📅 ${fmtEmailDate(correo.fechaMs)}</div>
        </div>

        <div style="font-size:12px; font-weight:700; color:#475569; margin-bottom:8px;">
          🧾 Facturas detectadas en este correo (${facturasFiltradas.length}):
        </div>
        ${invoicesHtml}
        ${extraDocsHtml}
      </div>
    `);
  }

  if (cardsHtml.length === 0) {
    const mesSel = document.getElementById('bandeja-mes');
    const isFilteredMonth = mesSel && mesSel.value !== 'todos';
    listEl.innerHTML = `
      <div class="card empty-state">
        <div class="empty-icon">📭</div>
        <div class="empty-title">No se encontraron correos con facturas para estos filtros</div>
        <div class="empty-sub">Prueba cambiando el mes, el estatus o limpiando el cuadro de búsqueda.</div>
        ${isFilteredMonth ? `<button class="btn btn-outline" style="margin-top:14px;" onclick="document.getElementById('bandeja-mes').value='todos'; loadBandeja();">📅 Ver todos los meses del año</button>` : ''}
      </div>
    `;
  } else {
    listEl.innerHTML = cardsHtml.join('');
  }
}

async function cambiarEstatusBandeja(messageId, idClave, uuid, nuevoEstatus) {
  try {
    const res = await fetch('/api/mail/estatus', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId, idClave, uuid, estatus: nuevoEstatus })
    });
    const data = await res.json();
    if (!data.ok) return alert('Error al actualizar estatus: ' + (data.error || 'Desconocido'));

    // Actualizar en memoria y re-renderizar instantáneamente
    for (const correo of window.bandejaEmails) {
      for (const f of (correo.facturas || [])) {
        if ((uuid && f.uuid === uuid) || (idClave && f.idClave === idClave)) {
          f.estatus = nuevoEstatus;
          f.origenEstatus = 'manual';
        }
      }
    }
    renderBandeja();
  } catch (err) {
    alert('Error de red al cambiar estatus: ' + err.message);
  }
}

async function procesarFacturaDesdeBandeja(messageId, idxFactura) {
  const correo = window.bandejaEmails.find(c => c.messageId === messageId);
  if (!correo || !correo.facturas || !correo.facturas[idxFactura]) {
    return alert('No se encontró la factura seleccionada.');
  }

  const factura = correo.facturas[idxFactura];
  const btn = document.getElementById(`btn-proc-${messageId}-${idxFactura}`);
  const selectEl = document.getElementById(`bandeja-suc-${messageId}-${idxFactura}`);
  const chosenSucursalName = selectEl ? selectEl.value : (factura.sucursal || 'Toyota Chiapas');

  // Mapear nombre de sucursal al Folder ID de Drive usado en #inp-sucursal
  const folderId = chosenSucursalName.includes('Poniente')
    ? '1HNbEOOw5sm37AfFZ1JSgKtKcAL-qqpjN'
    : '1t-dylPS1zV54AJE2eGozKJDR4RqUtNO7';

  const origText = btn ? btn.innerHTML : '';
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '⏳ Cargando archivos...';
  }

  try {
    // 1. Descargar XML desde Gmail
    const xmlUrl = `/api/mail/attachment/${encodeURIComponent(messageId)}/${encodeURIComponent(factura.xml.attachmentId)}?filename=${encodeURIComponent(factura.xml.filename)}&mimeType=application/xml`;
    const xmlRes = await fetch(xmlUrl);
    if (!xmlRes.ok) throw new Error('No se pudo descargar el archivo XML del correo.');
    const xmlBlob = await xmlRes.blob();
    const xmlFile = new File([xmlBlob], factura.xml.filename, { type: 'text/xml' });

    // 2. Descargar PDF desde Gmail (si viene adjunto en el correo)
    let pdfFile = null;
    if (factura.pdf && factura.pdf.attachmentId) {
      const pdfUrl = `/api/mail/attachment/${encodeURIComponent(messageId)}/${encodeURIComponent(factura.pdf.attachmentId)}?filename=${encodeURIComponent(factura.pdf.filename)}&mimeType=application/pdf`;
      const pdfRes = await fetch(pdfUrl);
      if (pdfRes.ok) {
        const pdfBlob = await pdfRes.blob();
        pdfFile = new File([pdfBlob], factura.pdf.filename, { type: 'application/pdf' });
      }
    }

    // 3. Limpiar flujo anterior y cargar archivos en memoria
    resetFlow();

    state.xmlFile = xmlFile;
    document.getElementById('name-xml').textContent = xmlFile.name;
    document.getElementById('tag-xml').classList.add('show');

    if (pdfFile) {
      state.pdfFile = pdfFile;
      document.getElementById('name-pdf').textContent = pdfFile.name;
      document.getElementById('tag-pdf').classList.add('show');
    }

    // 4. Ajustar sucursal destino
    const inpSuc = document.getElementById('inp-sucursal');
    if (inpSuc) {
      inpSuc.value = folderId;
      state.sucursalFolderId = folderId;
    }

    // 5. Cambiar a la pestaña de Flujo de Facturas
    switchMainView('facturas');

    // 6. Si tenemos ambos archivos (XML + PDF), avanzar directo al Paso 2 (Validación SAT)
    if (state.xmlFile && state.pdfFile) {
      goStep1();
    } else {
      showErr('err-step0', 'Se cargó el XML desde el correo, pero este correo no traía el PDF de la factura. Selecciona el PDF manualmente para continuar.');
    }
  } catch (err) {
    alert('Error al cargar factura desde el correo: ' + err.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = origText;
    }
  }
}

async function logout() {
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login.html';
  } catch(err) {
    console.error('Logout error:', err);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await checkUserRole();

  // Inicializar filtros al mes y año corriente
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = String(now.getMonth() + 1).padStart(2, '0');
  
  const selAnio = document.getElementById('filter-anio');
  const selMes = document.getElementById('filter-mes');
  if (selAnio) selAnio.value = String(currentYear);
  if (selMes) selMes.value = currentMonth;

  const bandAnio = document.getElementById('bandeja-anio');
  if (bandAnio) bandAnio.value = String(currentYear);

  applyRoleRestrictions();

  checkGoogleAuth();
  populateCategorias();
  loadBandeja();
  loadGastos();
  loadProveedores();
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
