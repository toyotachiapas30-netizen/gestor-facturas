const express = require('express');
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

// Trabajos asíncronos para evitar el timeout de 30s del proxy de Vercel cuando Farrera tarda >1 min
const buzonJobs = new Map();

async function runBuzonJob(jobId, params) {
  const { xmlPath, pdfPath, nombre, telefono, correo, ordenCompra, soloValidar } = params;
  const setStep = (step) => {
    const j = buzonJobs.get(jobId);
    if (j) j.step = step;
  };

  let browser = null;
  try {
    setStep('⏳ 1/4 Abriendo portal buzonfecg.aspx de Grupo Farrera...');
    browser = await launchBrowser(['--ignore-certificate-errors', '--disable-web-security']);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 960 });

    await page.goto(URL_BUZON, { waitUntil: 'domcontentloaded', timeout: 50000 });
    await page.waitForSelector('#ctl00_ContentPlaceHolder1_txtNombre, input[type="text"]', { timeout: 25000 });

    // 1. Llenar Nombre, Teléfono (8718645133), Correo y Orden de Compra
    await page.evaluate((datos) => {
      const setVal = (id, fallbackIdx, val) => {
        let el = document.getElementById(id);
        if (!el) {
          const all = document.querySelectorAll('input[type="text"]');
          el = all[fallbackIdx];
        }
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      };
      setVal('ctl00_ContentPlaceHolder1_txtNombre', 0, datos.nombre);
      setVal('ctl00_ContentPlaceHolder1_txtTelefono', 1, datos.telefono);
      setVal('ctl00_ContentPlaceHolder1_txtMail', 2, datos.correo);
      if (datos.ordenCompra) {
        setVal('ctl00_ContentPlaceHolder1_txtOrdenCompra', 3, datos.ordenCompra);
      }
    }, { nombre, telefono, correo, ordenCompra });

    // 2. Subir archivo XML
    setStep('⏳ 2/4 Subiendo y validando XML en servidor Farrera...');
    const xmlInput = (await page.$('#ctl00_ContentPlaceHolder1_FileUploadXML')) || (await page.$('input[type="file"]'));
    if (!xmlInput) throw new Error('No se encontró el campo para subir el XML en el Buzón.');
    await xmlInput.uploadFile(xmlPath);

    await new Promise((r) => setTimeout(r, 800));

    // 3. Hacer clic en "Validar"
    const validarBtn = await page.$('#ctl00_ContentPlaceHolder1_btnValidaXML, a[id*="btnValidaXML" i], input[value*="Validar" i]');
    if (validarBtn) {
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 75000 }).catch(() => {}),
        page.evaluate((el) => el.click(), validarBtn).catch(() => {})
      ]);
    }
    await new Promise((r) => setTimeout(r, 2500));

    // 4. Adjuntar PDF si se habilitó el campo
    let pdfSubido = false;
    if (pdfPath) {
      setStep('⏳ 3/4 Adjuntando archivo PDF de la factura...');
      for (let intento = 0; intento < 4 && !pdfSubido; intento++) {
        try {
          const pdfInput = await page.$('#ctl00_ContentPlaceHolder1_FileUploadPDF, input[id*="FileUploadPDF" i]');
          if (pdfInput) {
            await page.evaluate((el) => {
              el.style.visibility = 'visible';
              el.style.display = 'inline-block';
            }, pdfInput);
            await pdfInput.uploadFile(pdfPath);
            pdfSubido = true;
          } else {
            const allFiles = await page.$$('input[type="file"]');
            if (allFiles.length > 1) {
              await allFiles[1].uploadFile(pdfPath);
              pdfSubido = true;
            } else {
              await new Promise((r) => setTimeout(r, 2000));
            }
          }
        } catch (e) {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    }

    // 5. Hacer clic en el botón final de "Enviar / Guardar" (sin reenviar para evitar duplicados)
    let enviadoFinal = false;
    if (!soloValidar) {
      setStep('⏳ 4/4 Enviando registro final al Buzón Farrera (puede tardar ~1 min)...');
      const sendClicked = await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll('a.sexybutton, input[type="submit"], button, a[id*="ContentPlaceHolder1"]'));
        const target = candidates.find((el) => {
          const id = (el.id || '').toLowerCase();
          const txt = (el.innerText || el.value || '').trim().toLowerCase();
          if (id.includes('btnvalidaxml')) return false;
          return (
            id.includes('enviar') ||
            id.includes('guardar') ||
            id.includes('aceptar') ||
            id.includes('subir') ||
            txt === 'enviar' ||
            txt.includes('enviar factura') ||
            txt.includes('guardar') ||
            txt.includes('registrar')
          );
        });
        if (target) {
          target.click();
          return target.id || target.innerText || 'clicked';
        }
        return null;
      });

      if (sendClicked) {
        await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 95000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 3500));
        enviadoFinal = true;
      }
    }

    const estadoBuzon = await page.evaluate(() => {
      const aviso = document.getElementById('ctl00_ContentPlaceHolder1_lblAviso')?.innerText?.trim() || '';
      const msg = document.getElementById('ctl00_ContentPlaceHolder1_lblMensaje')?.innerText?.trim() || '';
      const bodyText = document.body?.innerText || '';
      return {
        aviso,
        mensaje: msg,
        registradaExito: /registrad[ao]|correctamente|éxito|exito|recibid[ao]/i.test(`${aviso} ${msg} ${bodyText}`)
      };
    });

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
      aviso: estadoBuzon.aviso,
      mensajePortal: estadoBuzon.mensaje,
      registradaExito: estadoBuzon.registradaExito,
      datosUsados: { nombre, telefono, correo, ordenCompra },
      screenshot: `data:image/png;base64,${screenshotB64}`,
      pdfBase64: Buffer.from(pdfBuf).toString('base64'),
      mensaje: enviadoFinal
        ? 'Factura validada y enviada en el Buzón de Autotec (Nube 1).'
        : 'Factura validada en el Buzón de Autotec (Nube 1).'
    };

    buzonJobs.set(jobId, { status: 'done', step: '✅ Completado', result });
    setTimeout(() => buzonJobs.delete(jobId), 300000);
    return result;
  } catch (err) {
    try { fs.unlinkSync(xmlPath); } catch (e) {}
    if (pdfPath) { try { fs.unlinkSync(pdfPath); } catch (e) {} }
    if (browser) await browser.close().catch(() => {});
    console.error('🔥 [Buzón Nube 1] Error:', err.message);
    buzonJobs.set(jobId, { status: 'error', error: err.message });
    setTimeout(() => buzonJobs.delete(jobId), 300000);
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

    if (asyncMode) {
      runBuzonJob(jobId, { xmlPath, pdfPath, nombre, telefono, correo, ordenCompra, soloValidar }).catch(() => {});
      return res.json({ ok: true, asyncJob: true, jobId });
    }

    try {
      const result = await runBuzonJob(jobId, { xmlPath, pdfPath, nombre, telefono, correo, ordenCompra, soloValidar });
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
  return res.json({ ok: true, ...job });
});

// ── POST /api/autotec/correo-confirmacion ─────────────────────────────
router.post('/correo-confirmacion', async (req, res) => {
  const { folio, uuid, rfcEmisor } = req.body || {};
  const client = getAuthorizedClient();
  if (!client) {
    return res.status(401).json({ ok: false, error: 'Gmail no está conectado.' });
  }

  let browser = null;
  try {
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
      return res.json({
        ok: false,
        notFound: true,
        error: `Aún no aparece el correo de confirmación de notifica@gfarrera.com.mx para el folio ${folio || uuid || ''} en la bandeja conectada (toyotachiapas30@gmail.com). Si ya enviaste en el Buzón con toyotachiapas30@gmail.com, espera ~30 segundos y vuelve a dar clic.`
      });
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

    return res.json({
      ok: true,
      subject,
      from,
      date: dateStr,
      screenshot: `data:image/png;base64,${screenshotB64}`,
      pdfBase64: Buffer.from(pdfBuf).toString('base64')
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
