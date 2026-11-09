/**
 * ============================================================================
 * PUENTE 24/7 AUTOTEC BUZÓN (NUBE 1) — TOYOTA CHIAPAS Y FARRERA PONIENTE
 * ============================================================================
 * Cero dependencias externas (usa únicamente módulos nativos de Node.js).
 * Permite que https://control.pagos.toyoter.com envíe facturas XML + PDF al
 * Buzón de Grupo Farrera (https://autotec.farrera.net:60002/buzonfecg.aspx)
 * a través de la conexión a internet local en México en ~2 segundos,
 * disparando automáticamente el correo de confirmación de notifica@gfarrera.com.mx
 * hacia toyotachiapas30@gmail.com.
 */

const https = require('https');
const os = require('os');
const crypto = require('crypto');

const SERVER_BASE = process.env.SERVER_BASE || 'https://gestor-facturas-hrwq.onrender.com';
const BRIDGE_KEY = process.env.BRIDGE_SECRET || 'toyoter_bridge_2026';
const URL_BUZON = 'https://autotec.farrera.net:60002/buzonfecg.aspx';
const HOSTNAME = os.hostname() || 'PC-Toyota-Mexico';

const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });
const cloudAgent = new https.Agent({ keepAlive: true });

function extractHiddenValue(html, fieldName) {
  const escaped = fieldName.replace(/\$/g, '\\$');
  const m1 = html.match(new RegExp(`name="${escaped}"[^>]*value="([^"]*)"`, 'i'));
  if (m1) return m1[1];
  const m2 = html.match(new RegExp(`id="${escaped}"[^>]*value="([^"]*)"`, 'i'));
  return m2 ? m2[1] : '';
}

function stripHtmlTags(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractSpanText(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*>([\\s\\S]*?)<\\/span>`, 'i'));
  return m ? stripHtmlTags(m[1]) : '';
}

function extractAlertFromScript(html) {
  const m = html.match(/muestraaviso\(\s*['"]([^'"]+)['"]\s*\)/i) || html.match(/alert\(\s*['"]([^'"]+)['"]\s*\)/i);
  return m ? m[1].trim() : '';
}

function mergeCookies(oldCookieStr, setCookieHeader) {
  const map = new Map();
  if (oldCookieStr) {
    oldCookieStr.split(';').forEach(part => {
      const [k, ...v] = part.trim().split('=');
      if (k) map.set(k.trim(), v.join('='));
    });
  }
  if (Array.isArray(setCookieHeader)) {
    setCookieHeader.forEach(raw => {
      const first = raw.split(';')[0];
      const [k, ...v] = first.trim().split('=');
      if (k) map.set(k.trim(), v.join('='));
    });
  }
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function buildMultipartBody(fields, files) {
  const boundary = '----ToyotaAutotecBoundary' + crypto.randomBytes(12).toString('hex');
  const chunks = [];

  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value ?? ''}\r\n`,
      'utf8'
    ));
  }

  for (const file of files) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
      'utf8'
    ));
    chunks.push(file.buffer);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    buffer: Buffer.concat(chunks)
  };
}

function rawHttpsRequest(urlStr, options = {}, bodyBuffer = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const reqOpts = {
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {},
      agent: options.agent || cloudAgent,
      timeout: options.timeout || 25000
    };

    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: raw
        });
      });
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Timeout (${reqOpts.timeout}ms) conectando a ${u.host}`));
    });
    req.on('error', reject);

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

async function enviarFacturaBuzonLocal(job) {
  const {
    nombre = 'YONI JAVIER RUIZ DOMINGUEZ',
    telefono = '8718645133',
    correo = 'toyotachiapas30@gmail.com',
    ordenCompra = '',
    soloValidar = false,
    xmlBufferB64,
    xmlOriginalName = 'factura.xml',
    pdfBufferB64,
    pdfOriginalName = 'factura.pdf'
  } = job;

  const xmlBuffer = Buffer.from(xmlBufferB64, 'base64');
  const pdfBuffer = pdfBufferB64 ? Buffer.from(pdfBufferB64, 'base64') : null;

  console.log(`\n🚀 [PUENTE 24/7] Procesando factura: ${xmlOriginalName} -> Correo: ${correo}`);

  // 1. GET inicial a buzonfecg.aspx
  const getResp = await rawHttpsRequest(URL_BUZON, {
    method: 'GET',
    agent: insecureAgent,
    timeout: 20000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  let cookies = mergeCookies('', getResp.headers['set-cookie']);
  let html = String(getResp.data || '');
  let viewState = extractHiddenValue(html, '__VIEWSTATE');
  let viewStateGen = extractHiddenValue(html, '__VIEWSTATEGENERATOR');
  let eventValidation = extractHiddenValue(html, '__EVENTVALIDATION');

  if (!viewState) {
    throw new Error('No se pudo obtener __VIEWSTATE del Buzón de Grupo Farrera.');
  }

  // 2. POST de Validación XML (btnValidaXML)
  const fieldsStep2 = {
    '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$btnValidaXML',
    '__EVENTARGUMENT': '',
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': viewStateGen,
    '__EVENTVALIDATION': eventValidation,
    'ctl00$ContentPlaceHolder1$txtNombre': nombre,
    'ctl00$ContentPlaceHolder1$txtTelefono': telefono,
    'ctl00$ContentPlaceHolder1$txtCorreo': correo,
    'ctl00$ContentPlaceHolder1$txtOrdenCompra': ordenCompra
  };
  const filesStep2 = [
    {
      fieldName: 'ctl00$ContentPlaceHolder1$FileUploadXML',
      filename: xmlOriginalName,
      contentType: 'text/xml',
      buffer: xmlBuffer
    },
    {
      fieldName: 'ctl00$ContentPlaceHolder1$FileUploadPDF',
      filename: '',
      contentType: 'application/octet-stream',
      buffer: Buffer.alloc(0)
    }
  ];

  const mp2 = buildMultipartBody(fieldsStep2, filesStep2);
  const valResp = await rawHttpsRequest(URL_BUZON, {
    method: 'POST',
    agent: insecureAgent,
    timeout: 25000,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${mp2.boundary}`,
      'Content-Length': mp2.buffer.length,
      'Cookie': cookies,
      'Referer': URL_BUZON,
      'Origin': 'https://autotec.farrera.net:60002',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
    }
  }, mp2.buffer);

  cookies = mergeCookies(cookies, valResp.headers['set-cookie']);
  html = String(valResp.data || '');
  viewState = extractHiddenValue(html, '__VIEWSTATE') || viewState;
  viewStateGen = extractHiddenValue(html, '__VIEWSTATEGENERATOR') || viewStateGen;
  eventValidation = extractHiddenValue(html, '__EVENTVALIDATION') || eventValidation;

  let lblMensaje = extractSpanText(html, 'ctl00_ContentPlaceHolder1_lblMensaje');
  let lblRFC = extractSpanText(html, 'ctl00_ContentPlaceHolder1_lblRFC');
  let alertMsg = extractAlertFromScript(html);

  const btnEnviarEnabled =
    html.includes('id="ctl00_ContentPlaceHolder1_btnEnviar"') &&
    !html.match(/id="ctl00_ContentPlaceHolder1_btnEnviar"[^>]*disabled="disabled"/i);
  const xmlValidadoOk = btnEnviarEnabled || /validado correctamente|proceda a cargar el PDF/i.test(lblMensaje);

  console.log(`   ✔ Validación XML: "${lblMensaje || alertMsg}" (Habilitado Enviar: ${btnEnviarEnabled})`);

  let pdfSubido = false;
  let enviadoFinal = false;

  // 3. POST de Envío de PDF y Registro Final (btnEnviar)
  if (!soloValidar && pdfBuffer && xmlValidadoOk) {
    const fieldsStep3 = {
      '__EVENTTARGET': 'ctl00$ContentPlaceHolder1$btnEnviar',
      '__EVENTARGUMENT': '',
      '__VIEWSTATE': viewState,
      '__VIEWSTATEGENERATOR': viewStateGen,
      '__EVENTVALIDATION': eventValidation,
      'ctl00$ContentPlaceHolder1$txtNombre': nombre,
      'ctl00$ContentPlaceHolder1$txtTelefono': telefono,
      'ctl00$ContentPlaceHolder1$txtCorreo': correo,
      'ctl00$ContentPlaceHolder1$txtOrdenCompra': ordenCompra
    };
    const filesStep3 = [
      {
        fieldName: 'ctl00$ContentPlaceHolder1$FileUploadXML',
        filename: '',
        contentType: 'application/octet-stream',
        buffer: Buffer.alloc(0)
      },
      {
        fieldName: 'ctl00$ContentPlaceHolder1$FileUploadPDF',
        filename: pdfOriginalName,
        contentType: 'application/pdf',
        buffer: pdfBuffer
      }
    ];

    const mp3 = buildMultipartBody(fieldsStep3, filesStep3);
    const sendResp = await rawHttpsRequest(URL_BUZON, {
      method: 'POST',
      agent: insecureAgent,
      timeout: 25000,
      headers: {
        'Content-Type': `multipart/form-data; boundary=${mp3.boundary}`,
        'Content-Length': mp3.buffer.length,
        'Cookie': cookies,
        'Referer': URL_BUZON,
        'Origin': 'https://autotec.farrera.net:60002',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36'
      }
    }, mp3.buffer);

    html = String(sendResp.data || '');
    const msgAfterSend = extractSpanText(html, 'ctl00_ContentPlaceHolder1_lblMensaje');
    const alertAfterSend = extractAlertFromScript(html);
    if (msgAfterSend) lblMensaje = msgAfterSend;
    if (alertAfterSend) alertMsg = alertAfterSend;
    pdfSubido = true;
    enviadoFinal = true;
    console.log(`   🎉 Envío Final PDF completado: "${lblMensaje || alertMsg || 'Factura registrada'}"`);
  }

  const textoCompleto = `${alertMsg} ${lblMensaje}`;
  const yaRegistrada = /previamente|ya existe|duplicad/i.test(textoCompleto);
  const registradaExito = /correctamente|exito|éxito|registrad|enviad|recibid/i.test(textoCompleto) || enviadoFinal;

  return {
    ok: true,
    pdfSubido,
    enviadoFinal,
    aviso: alertMsg,
    mensajePortal: [lblRFC, lblMensaje].filter(Boolean).join(' — '),
    registradaExito,
    datosUsados: { nombre, telefono, correo, ordenCompra },
    mensaje: enviadoFinal
      ? `✅ XML y PDF enviados al Buzón Autotec. El correo de confirmación llegará en unos segundos a ${correo}.`
      : yaRegistrada
      ? `ℹ️ Esta factura ya había sido registrada previamente en el Buzón Autotec (${alertMsg || lblMensaje}). Puedes seleccionar su correo en la Bandeja de abajo.`
      : `⚠️ Respuesta del Buzón: ${alertMsg || lblMensaje || 'Revisar datos.'}`
  };
}

async function pollLoop() {
  console.log('====================================================================');
  console.log('🟢 PUENTE 24/7 AUTOTEC (NUBE 1) ACTIVO Y CONECTADO');
  console.log(`🖥️  Equipo Local : ${HOSTNAME}`);
  console.log(`🌐 Servidor Web : ${SERVER_BASE}`);
  console.log(`📬 Destino      : ${URL_BUZON}`);
  console.log('====================================================================');

  while (true) {
    try {
      const pollUrl = `${SERVER_BASE}/api/autotec/bridge/next?host=${encodeURIComponent(HOSTNAME)}`;
      const resp = await rawHttpsRequest(pollUrl, {
        method: 'GET',
        timeout: 15000,
        headers: {
          'x-bridge-key': BRIDGE_KEY,
          'Accept': 'application/json'
        }
      });

      if (resp.status === 200 && resp.data) {
        let parsed = null;
        try { parsed = JSON.parse(resp.data); } catch (e) {}
        if (parsed && parsed.ok && parsed.hasJob && parsed.job) {
          const job = parsed.job;
          let resultPayload;
          try {
            resultPayload = await enviarFacturaBuzonLocal(job);
          } catch (jobErr) {
            console.error('❌ Error procesando factura en Buzón:', jobErr.message);
            resultPayload = {
              ok: false,
              error: 'Error desde Puente Local: ' + jobErr.message
            };
          }

          const bodyBuf = Buffer.from(JSON.stringify(resultPayload), 'utf8');
          await rawHttpsRequest(`${SERVER_BASE}/api/autotec/bridge/complete/${job.jobId}`, {
            method: 'POST',
            timeout: 15000,
            headers: {
              'x-bridge-key': BRIDGE_KEY,
              'Content-Type': 'application/json',
              'Content-Length': bodyBuf.length
            }
          }, bodyBuf);
        }
      }
    } catch (err) {
      // Silenciar desconexiones temporales de red y reintentar
    }

    await new Promise(r => setTimeout(r, 2500));
  }
}

pollLoop();
