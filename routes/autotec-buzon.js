const express = require('express');
const axios = require('axios');
const https = require('https');
const FormData = require('form-data');
const { launchBrowser } = require('../utils/browser');
const { getAuthorizedClient, getGoogle } = require('./drive');
const fs = require('fs');
const os = require('os');
const path = require('path');
const router = express.Router();

const getUpload = () => {
  const multer = require('multer');
  return multer({ storage: multer.memoryStorage() });
};

// Datos oficiales del usuario según Memoria de Flujo Toyota Chiapas
const DEFAULT_BUZON_NOMBRE   = 'YONI JAVIER RUIZ DOMINGUEZ';
const DEFAULT_BUZON_TELEFONO = '8718645133';
const DEFAULT_BUZON_CORREO   = 'chiapastoyota@gmail.com';
const URL_BUZON = 'https://autotec.farrera.net:60002/buzonfecg.aspx';
const farreraHttpsAgent = new https.Agent({ rejectUnauthorized: false });

// Trabajos asíncronos para evitar el timeout de 30s del proxy de Vercel
const buzonJobs = new Map();

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

async function runBuzonJob(jobId, params) {
  const { xmlPath, pdfPath, xmlOriginalName, pdfOriginalName, nombre, telefono, correo, ordenCompra, soloValidar } = params;
  const setStep = (step) => {
    const j = buzonJobs.get(jobId);
    if (j) j.step = step;
  };

  let browser = null;
  try {
    // 1. Abrir sesión HTTP con buzonfecg.aspx
    setStep('⏳ 1/4 Conectando con portal buzonfecg.aspx de Grupo Farrera...');
    const initResp = await axios.get(URL_BUZON, {
      httpsAgent: farreraHttpsAgent,
      timeout: 30000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      }
    });

    let cookies = mergeCookies('', initResp.headers['set-cookie']);
    const initHtml = initResp.data || '';

    // 2. Enviar PostBack de "Validar" con el archivo XML
    setStep('⏳ 2/4 Subiendo y validando XML en servidor Farrera...');
    const fdValida = new FormData();
    fdValida.append('ctl00_ToolkitScriptManager1_HiddenField', '');
    fdValida.append('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$btnValidaXML');
    fdValida.append('__EVENTARGUMENT', '');
    fdValida.append('__VIEWSTATE', extractHiddenValue(initHtml, '__VIEWSTATE'));
    fdValida.append('__VIEWSTATEGENERATOR', extractHiddenValue(initHtml, '__VIEWSTATEGENERATOR'));
    fdValida.append('__EVENTVALIDATION', extractHiddenValue(initHtml, '__EVENTVALIDATION'));
    fdValida.append('ctl00$ContentPlaceHolder1$txtNombre', nombre);
    fdValida.append('ctl00$ContentPlaceHolder1$txtTelefono', telefono);
    fdValida.append('ctl00$ContentPlaceHolder1$txtMail', correo);
    fdValida.append('ctl00$ContentPlaceHolder1$txtOrdenCompra', ordenCompra || '');
    fdValida.append('ctl00$ContentPlaceHolder1$FileUploadXML', fs.createReadStream(xmlPath), {
      filename: xmlOriginalName || path.basename(xmlPath),
      contentType: 'text/xml'
    });
    fdValida.append('ctl00$ContentPlaceHolder1$FileUploadPDF', Buffer.alloc(0), {
      filename: '',
      contentType: 'application/octet-stream'
    });

    const valResp = await axios.post(URL_BUZON, fdValida, {
      httpsAgent: farreraHttpsAgent,
      timeout: 45000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      headers: {
        ...fdValida.getHeaders(),
        Cookie: cookies,
        Origin: 'https://autotec.farrera.net:60002',
        Referer: URL_BUZON,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
      }
    });

    cookies = mergeCookies(cookies, valResp.headers['set-cookie']);
    let currentHtml = valResp.data || '';
    const msgTrasValidar = extractSpanText(currentHtml, 'ctl00_ContentPlaceHolder1_lblMensaje');
    const avisoTrasValidar = extractSpanText(currentHtml, 'ctl00_ContentPlaceHolder1_lblAviso') || extractAlertFromScript(currentHtml);

    // 3. Si el XML fue validado y apareció btnEnviar, adjuntar el PDF y enviar
    let pdfSubido = false;
    let enviadoFinal = false;
    const tieneBtnEnviar = /id="ctl00_ContentPlaceHolder1_btnEnviar"/i.test(currentHtml);

    if (!soloValidar && pdfPath && tieneBtnEnviar) {
      setStep('⏳ 3/4 Adjuntando PDF y registrando factura en Buzón Farrera...');
      const fdEnviar = new FormData();
      fdEnviar.append('ctl00_ToolkitScriptManager1_HiddenField', '');
      fdEnviar.append('__EVENTTARGET', 'ctl00$ContentPlaceHolder1$btnEnviar');
      fdEnviar.append('__EVENTARGUMENT', '');
      fdEnviar.append('__VIEWSTATE', extractHiddenValue(currentHtml, '__VIEWSTATE'));
      fdEnviar.append('__VIEWSTATEGENERATOR', extractHiddenValue(currentHtml, '__VIEWSTATEGENERATOR'));
      fdEnviar.append('__EVENTVALIDATION', extractHiddenValue(currentHtml, '__EVENTVALIDATION'));
      fdEnviar.append('ctl00$ContentPlaceHolder1$txtNombre', nombre);
      fdEnviar.append('ctl00$ContentPlaceHolder1$txtTelefono', telefono);
      fdEnviar.append('ctl00$ContentPlaceHolder1$txtMail', correo);
      fdEnviar.append('ctl00$ContentPlaceHolder1$txtOrdenCompra', ordenCompra || '');
      fdEnviar.append('ctl00$ContentPlaceHolder1$FileUploadPDF', fs.createReadStream(pdfPath), {
        filename: pdfOriginalName || path.basename(pdfPath),
        contentType: 'application/pdf'
      });

      const envResp = await axios.post(URL_BUZON, fdEnviar, {
        httpsAgent: farreraHttpsAgent,
        timeout: 60000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        headers: {
          ...fdEnviar.getHeaders(),
          Cookie: cookies,
          Origin: 'https://autotec.farrera.net:60002',
          Referer: URL_BUZON,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36'
        }
      });

      currentHtml = envResp.data || currentHtml;
      pdfSubido = true;
      enviadoFinal = true;
    }

    const avisoFinal = extractSpanText(currentHtml, 'ctl00_ContentPlaceHolder1_lblAviso') || extractAlertFromScript(currentHtml) || avisoTrasValidar;
    const msgFinal = extractSpanText(currentHtml, 'ctl00_ContentPlaceHolder1_lblMensaje') || msgTrasValidar;
    const registradaExito = /registrad[ao]|correctamente|éxito|exito|recibid[ao]|enviad[ao]/i.test(`${avisoFinal} ${msgFinal}`);

    // 4. Renderizar el HTML oficial devuelto por buzonfecg.aspx para generar la captura real y el PDF
    setStep('⏳ 4/4 Generando captura real y PDF del Buzón Autotec...');
    let renderHtml = currentHtml
      .replace(/<head>/i, '<head><base href="https://autotec.farrera.net:60002/">')
      .replace(/http:\/\/ajax\.googleapis\.com/gi, 'https://ajax.googleapis.com')
      .replace(/<script[\s\S]*?<\/script>/gi, '');

    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 920 });
    await page.setContent(renderHtml, { waitUntil: 'load', timeout: 15000 }).catch(() => {});

    // Asegurar que los datos capturados y el aviso del servidor sean visibles en la captura
    await page.evaluate((datos) => {
      const setIfEmpty = (id, val) => {
        const el = document.getElementById(id);
        if (el && !el.value && val) el.value = val;
      };
      setIfEmpty('ctl00_ContentPlaceHolder1_txtNombre', datos.nombre);
      setIfEmpty('ctl00_ContentPlaceHolder1_txtTelefono', datos.telefono);
      setIfEmpty('ctl00_ContentPlaceHolder1_txtMail', datos.correo);
      if (datos.ordenCompra) setIfEmpty('ctl00_ContentPlaceHolder1_txtOrdenCompra', datos.ordenCompra);

      const msgEl = document.getElementById('ctl00_ContentPlaceHolder1_lblMensaje');
      if (msgEl && !msgEl.innerText.trim() && (datos.avisoFinal || datos.msgFinal)) {
        msgEl.innerHTML = `<font color="Blue"><b>${datos.avisoFinal || datos.msgFinal}</b></font>`;
      }
    }, { nombre, telefono, correo, ordenCompra, avisoFinal, msgFinal });

    await new Promise((r) => setTimeout(r, 400));

    const screenshotB64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
    const pdfBuf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    });

    try { fs.unlinkSync(xmlPath); } catch (e) {}
    if (pdfPath) { try { fs.unlinkSync(pdfPath); } catch (e) {} }
    await browser.close().catch(() => {});

    const result = {
      ok: true,
      pdfSubido,
      enviadoFinal,
      aviso: avisoFinal,
      mensajePortal: msgFinal,
      registradaExito,
      datosUsados: { nombre, telefono, correo, ordenCompra },
      screenshot: `data:image/png;base64,${screenshotB64}`,
      pdfBase64: Buffer.from(pdfBuf).toString('base64'),
      mensaje: enviadoFinal
        ? 'Factura validada y enviada en el Buzón de Autotec (Nube 1).'
        : 'Respuesta del Buzón de Autotec (Nube 1).'
    };

    buzonJobs.set(jobId, { status: 'done', step: '✅ Completado', result });
    setTimeout(() => buzonJobs.delete(jobId), 45000);
    return result;
  } catch (err) {
    try { fs.unlinkSync(xmlPath); } catch (e) {}
    if (pdfPath) { try { fs.unlinkSync(pdfPath); } catch (e) {} }
    if (browser) await browser.close().catch(() => {});
    console.error('🔥 [Buzón Nube 1] Error:', err.message);
    buzonJobs.set(jobId, { status: 'error', error: err.message });
    setTimeout(() => buzonJobs.delete(jobId), 45000);
    throw err;
  }
}

// ── POST /api/autotec/buzon ─────────────────────────────
router.post(
  '/buzon',
  (req, res, next) => getUpload().fields([{ name: 'xml' }, { name: 'pdf' }])(req, res, next),
  async (req, res) => {
    const xmlFile = req.files?.['xml']?.[0];
    const pdfFile = req.files?.['pdf']?.[0];

    if (!xmlFile) {
      return res.status(400).json({ ok: false, error: 'Se requiere el archivo XML de la factura.' });
    }

    const tmpDir = os.tmpdir();
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const xmlPath = path.join(tmpDir, `${stamp}_${xmlFile.originalname}`);
    fs.writeFileSync(xmlPath, xmlFile.buffer);

    let pdfPath = null;
    if (pdfFile) {
      pdfPath = path.join(tmpDir, `${stamp}_${pdfFile.originalname}`);
      fs.writeFileSync(pdfPath, pdfFile.buffer);
    }

    const nombre      = (req.body?.nombre || DEFAULT_BUZON_NOMBRE).trim();
    const telefono    = (req.body?.telefono || DEFAULT_BUZON_TELEFONO).trim();
    const correo      = (req.body?.correo || process.env.BUZON_CORREO || DEFAULT_BUZON_CORREO).trim();
    const ordenCompra = (req.body?.ordenCompra || '').trim();
    const soloValidar = req.body?.soloValidar === 'true' || req.body?.soloValidar === true;
    const asyncMode   = req.body?.asyncJob === 'true' || req.body?.asyncJob === true;

    const jobId = `buzon_${stamp}`;
    buzonJobs.set(jobId, { status: 'running', step: '⏳ Iniciando conexión con Buzón Autotec...' });

    const jobParams = {
      xmlPath,
      pdfPath,
      xmlOriginalName: xmlFile.originalname,
      pdfOriginalName: pdfFile ? pdfFile.originalname : null,
      nombre,
      telefono,
      correo,
      ordenCompra,
      soloValidar
    };

    if (asyncMode) {
      runBuzonJob(jobId, jobParams).catch(() => {});
      return res.json({ ok: true, asyncJob: true, jobId });
    }

    try {
      const result = await runBuzonJob(jobId, jobParams);
      return res.json(result);
    } catch (err) {
      return res.status(500).json({ ok: false, error: err.message });
    }
  }
);

// ── GET /api/autotec/buzon-status/:jobId ────────────────
router.get('/buzon-status/:jobId', (req, res) => {
  const job = buzonJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'La tarea expiró o el servidor se reinició. Intenta de nuevo.' });
  }
  if (job.status === 'done' || job.status === 'error') {
    setTimeout(() => buzonJobs.delete(req.params.jobId), 5000);
  }
  return res.json({ ok: true, ...job });
});

// ── POST /api/autotec/correo-confirmacion ─────────────────────────────
async function runCorreoConfirmacionJob(jobId, { folio, uuid, rfcEmisor, client }) {
  let browser = null;
  try {
    buzonJobs.set(jobId, { status: 'running', step: '⏳ 1/2 Buscando correo de notifica@gfarrera.com.mx en Gmail...' });
    const gmail = getGoogle().gmail({ version: 'v1', auth: client });

    const queries = [];
    if (folio && folio !== '—') queries.push(`(from:notifica@gfarrera.com.mx OR "Factura electrónica registrada") "${folio}"`);
    if (uuid && uuid !== '—') queries.push(`(from:notifica@gfarrera.com.mx OR "Factura electrónica registrada") "${uuid.slice(0, 8)}"`);
    queries.push(`from:notifica@gfarrera.com.mx "Factura electrónica registrada"`);

    let matchedMsg = null;
    for (const q of queries) {
      const listRes = await gmail.users.messages.list({ userId: 'me', q, maxResults: 8 });
      const msgs = listRes.data.messages || [];
      for (const m of msgs) {
        const full = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
        const snippet = full.data.snippet || '';
        let bodyHtml = '';
        const extractParts = (payload) => {
          if (!payload) return;
          if (payload.mimeType === 'text/html' && payload.body?.data) {
            bodyHtml += Buffer.from(payload.body.data, 'base64').toString('utf8');
          } else if (payload.mimeType === 'text/plain' && payload.body?.data && !bodyHtml) {
            bodyHtml += `<pre style="font-family:sans-serif;white-space:pre-wrap;">${Buffer.from(payload.body.data, 'base64').toString('utf8')}</pre>`;
          }
          if (Array.isArray(payload.parts)) payload.parts.forEach(extractParts);
        };
        extractParts(full.data.payload);

        const combined = `${snippet} ${bodyHtml}`.toLowerCase();
        const matchesFolio = folio && folio !== '—' && combined.includes(String(folio).toLowerCase());
        const matchesUuid = uuid && uuid !== '—' && combined.includes(String(uuid).slice(0, 8).toLowerCase());
        const matchesRfc = rfcEmisor && rfcEmisor !== '—' && combined.includes(String(rfcEmisor).toLowerCase());

        if (matchesFolio || matchesUuid || matchesRfc || (!folio && !uuid)) {
          matchedMsg = { full: full.data, bodyHtml: bodyHtml || `<p>${snippet}</p>` };
          break;
        }
      }
      if (matchedMsg) break;
    }

    if (!matchedMsg) {
      const notFoundRes = {
        ok: false,
        notFound: true,
        error: `Aún no aparece el correo de confirmación de notifica@gfarrera.com.mx para el folio ${folio || uuid || ''} en la bandeja conectada (toyotachiapas30@gmail.com). Si ya enviaste en el Buzón con toyotachiapas30@gmail.com, espera ~30 segundos y vuelve a dar clic.`
      };
      buzonJobs.set(jobId, { status: 'done', result: notFoundRes });
      return notFoundRes;
    }

    const headers = matchedMsg.full.payload?.headers || [];
    const getH = (n) => headers.find((h) => h.name.toLowerCase() === n.toLowerCase())?.value || '';
    const subject = getH('Subject') || 'Factura electrónica registrada';
    const from = getH('From') || 'notifica@gfarrera.com.mx';
    const to = getH('To') || 'toyotachiapas30@gmail.com';
    const dateStr = getH('Date') || new Date().toLocaleString('es-MX');

    const gmailPrintHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, Helvetica, sans-serif; color: #202124; margin: 24px 32px; font-size: 13px; }
    .top-bar { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #dadce0; padding-bottom: 10px; margin-bottom: 16px; }
    .gmail-logo { font-size: 20px; font-weight: bold; color: #5f6368; display: flex; align-items: center; gap: 8px; }
    .subject { font-size: 19px; font-weight: bold; margin: 12px 0; border-bottom: 1px solid #e8eaed; padding-bottom: 10px; }
    .meta { margin-bottom: 18px; line-height: 1.6; color: #3c4043; font-size: 12.5px; }
    .content { padding-top: 8px; line-height: 1.5; }
  </style>
</head>
<body>
  <div class="top-bar">
    <div class="gmail-logo">✉️ Gmail — ${to}</div>
    <div style="font-size:11px;color:#5f6368;">Confirmación Nube 1 (Autotec Farrera)</div>
  </div>
  <div class="subject">${subject}</div>
  <div class="meta">
    <div><strong>De:</strong> ${from}</div>
    <div><strong>Para:</strong> ${to}</div>
    <div><strong>Fecha:</strong> ${dateStr}</div>
  </div>
  <div class="content">${matchedMsg.bodyHtml}</div>
</body>
</html>`;

    buzonJobs.set(jobId, { status: 'running', step: '⏳ 2/2 Generando captura real y PDF del correo...' });
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1024, height: 900 });
    await page.setContent(gmailPrintHtml, { waitUntil: 'networkidle0', timeout: 15000 });

    const screenshotB64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
    const pdfBuf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
    });

    await browser.close().catch(() => {});

    const finalRes = {
      ok: true,
      subject,
      from,
      date: dateStr,
      screenshot: `data:image/png;base64,${screenshotB64}`,
      pdfBase64: Buffer.from(pdfBuf).toString('base64')
    };
    buzonJobs.set(jobId, { status: 'done', result: finalRes });
    return finalRes;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    buzonJobs.set(jobId, { status: 'error', error: err.message });
    throw err;
  }
}

router.post('/correo-confirmacion', async (req, res) => {
  const { folio, uuid, rfcEmisor, asyncJob } = req.body || {};
  const client = getAuthorizedClient();
  if (!client) {
    return res.status(401).json({ ok: false, error: 'Gmail no está conectado.' });
  }

  const jobId = `mail_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  buzonJobs.set(jobId, { status: 'running', step: '⏳ Buscando correo en Gmail...' });

  if (asyncJob === 'true' || asyncJob === true) {
    runCorreoConfirmacionJob(jobId, { folio, uuid, rfcEmisor, client }).catch(() => {});
    return res.json({ ok: true, asyncJob: true, jobId });
  }

  try {
    const result = await runCorreoConfirmacionJob(jobId, { folio, uuid, rfcEmisor, client });
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
