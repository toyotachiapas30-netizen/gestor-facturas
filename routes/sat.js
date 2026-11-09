const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs');
const os = require('os');
const path = require('path');
const multer = require('multer');
const { launchBrowser } = require('../utils/browser');
const { getDB, backupDatabaseToDrive } = require('./gastos');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

const SAT_SOAP_URL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';
const SOAP_ACTION = 'http://tempuri.org/IConsultaCFDIService/Consulta';
const SAT_PORTAL_URL = 'https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx';

// Sesiones interactivas temporales (cuando se usa el modo asistido sin llave o de respaldo)
const activeSatSessions = new Map();
const satJobs = new Map();

function cleanupOldSatJobs() {
  const now = Date.now();
  for (const [id, job] of satJobs.entries()) {
    if (now - job.updatedAt > 15 * 60 * 1000) satJobs.delete(id);
  }
}

function setSatJob(jobId, data) {
  cleanupOldSatJobs();
  const prev = satJobs.get(jobId) || {};
  satJobs.set(jobId, { ...prev, ...data, updatedAt: Date.now() });
}

function cleanupSatSession(sessionId) {
  const s = activeSatSessions.get(sessionId);
  if (!s) return;
  activeSatSessions.delete(sessionId);
  if (s.timer) clearTimeout(s.timer);
  if (s.xmlPath && fs.existsSync(s.xmlPath)) {
    try { fs.unlinkSync(s.xmlPath); } catch (e) {}
  }
  if (s.browser) {
    s.browser.close().catch(() => {});
  }
}

function getGeminiApiKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  try {
    const db = getDB();
    const row = db.prepare("SELECT valor FROM bandeja_config WHERE clave = 'gemini_api_key'").get();
    if (row && row.valor) return row.valor.trim();
  } catch (e) {}
  return '';
}

function saveGeminiApiKey(apiKey) {
  const clean = (apiKey || '').trim();
  const db = getDB();
  db.prepare(`
    INSERT INTO bandeja_config (clave, valor, updated_at)
    VALUES ('gemini_api_key', ?, datetime('now','localtime'))
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now','localtime')
  `).run(clean);
  backupDatabaseToDrive().catch(() => {});
}

// ── Resolver Captcha del SAT con Gemini Vision ─────────────────────────────
async function solveCaptchaWithGemini(captchaBase64, apiKey) {
  const models = [
    { name: 'gemini-3-flash-preview', thinkingLevel: 'LOW' },
    { name: 'gemini-3.8-flash', thinkingLevel: 'LOW' },
    { name: 'gemini-3.1-pro-preview', thinkingLevel: 'LOW' }
  ];
  let lastErr = null;

  for (const m of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m.name}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const body = {
        contents: [
          {
            parts: [
              {
                text: 'Lee exactamente los 5 dígitos numéricos (0-9) de este captcha del SAT mexicano. Nota importante sobre la tipografía del SAT: los dígitos están inclinados hacia la izquierda; el número 7 tiene una barra superior horizontal larga (no lo confundas con 1), el 3 tiene dos curvas, el 2 tiene base plana. Ignora la malla de fondo y las líneas diagonales. Responde ÚNICAMENTE con los 5 dígitos juntos, sin espacios ni texto adicional.'
              },
              {
                inline_data: {
                  mime_type: 'image/png',
                  data: captchaBase64
                }
              }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.0
        }
      };
      if (m.thinkingLevel) {
        body.generationConfig.thinkingConfig = { thinkingLevel: m.thinkingLevel };
      }

      const resp = await axios.post(url, body, { timeout: 18000 });

      const parts = resp.data?.candidates?.[0]?.content?.parts || [];
      const rawText = parts.map((p) => p.text || '').join(' ');
      const digitsMatch = rawText.match(/\d{5}/);
      if (digitsMatch) return digitsMatch[0];
      const digitsOnly = rawText.replace(/[^0-9]/g, '').trim();
      if (digitsOnly.length >= 4) {
        return digitsOnly.slice(0, 5);
      }
    } catch (err) {
      lastErr = err.response?.data?.error?.message || err.message;
    }
  }

  throw new Error(lastErr || 'No se pudo leer el captcha con Gemini');
}

function buildSoapEnvelope(re, rr, tt, id) {
  const totalFormatted = parseFloat(tt).toFixed(6);
  const expresion = `?re=${encodeURIComponent(re)}&rr=${encodeURIComponent(rr)}&tt=${totalFormatted}&id=${id}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
  <soapenv:Header/>
  <soapenv:Body>
    <tem:Consulta>
      <tem:expresionImpresa><![CDATA[${expresion}]]></tem:expresionImpresa>
    </tem:Consulta>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function parseSoapResponse(xmlResponse) {
  const result = await xml2js.parseStringPromise(xmlResponse, { explicitArray: false });
  const body = result['s:Envelope']['s:Body'];
  const cr = body['ConsultaResponse']['ConsultaResult'];
  return {
    codigoEstatus: cr['a:CodigoEstatus'] || '',
    estado: cr['a:Estado'] || '',
    esCancelable: cr['a:EsCancelable'] || '',
    estatusCancelacion: cr['a:EstatusCancelacion'] || '',
    efos: cr['a:ValidezEFOS'] || ''
  };
}

// ── GET /api/sat/gemini-config ─────────────────────────────────────────────
router.get('/gemini-config', (req, res) => {
  const key = getGeminiApiKey();
  res.json({
    ok: true,
    configured: Boolean(key),
    maskedKey: key ? `${key.slice(0, 6)}••••••••${key.slice(-4)}` : null
  });
});

// ── POST /api/sat/gemini-config ────────────────────────────────────────────
router.post('/gemini-config', async (req, res) => {
  try {
    const { apiKey } = req.body || {};
    if (!apiKey || !apiKey.trim()) {
      saveGeminiApiKey('');
      return res.json({ ok: true, configured: false });
    }
    const clean = apiKey.trim();
    saveGeminiApiKey(clean);
    return res.json({
      ok: true,
      configured: true,
      maskedKey: `${clean.slice(0, 6)}••••••••${clean.slice(-4)}`
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/sat/verificar (SOAP instantáneo) ─────────────────────────────
router.post('/verificar', async (req, res) => {
  const { uuid, rfcEmisor, rfcReceptor, total } = req.body;

  if (!uuid || !rfcEmisor || !rfcReceptor || !total) {
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }

  try {
    const soap = buildSoapEnvelope(rfcEmisor, rfcReceptor, total, uuid);
    const response = await axios.post(SAT_SOAP_URL, soap, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
      timeout: 15000
    });

    const satResult = await parseSoapResponse(response.data);
    return res.json({ ok: true, ...satResult });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Helper: Enviar código de Captcha en página abierta del SAT y capturar ──
async function submitSatXmlCaptchaAndCapture(page, xmlPath, code) {
  // Asegurar que el archivo XML siga seleccionado en el input file
  const hasFile = await page.evaluate(() => {
    const fi = document.getElementById('ctl00_MainContent_fileUploadXML');
    return fi && fi.files && fi.files.length > 0;
  });
  if (!hasFile && xmlPath && fs.existsSync(xmlPath)) {
    const fileInput = await page.$('#ctl00_MainContent_fileUploadXML');
    if (fileInput) {
      await fileInput.uploadFile(xmlPath);
      await page.evaluate(() => {
        const fi = document.getElementById('ctl00_MainContent_fileUploadXML');
        if (fi) fi.dispatchEvent(new Event('change', { bubbles: true }));
      });
    }
  }

  // Escribir los dígitos del captcha y presionar "Verificar CFDI"
  await page.evaluate((val) => {
    const inp = document.getElementById('ctl00_MainContent_TxtCaptchaNumbersXml');
    if (inp) {
      inp.value = val;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (typeof habilitarBoton === 'function') habilitarBoton();
    const btn = document.getElementById('ctl00_MainContent_BtnBusquedaXml');
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('aspNetDisabled');
      btn.click();
    }
  }, code);

  // Esperar a que aparezca el panel de resultados o el mensaje de error de captcha
  await page.waitForFunction(
    () => {
      const resXml = document.getElementById('ctl00_MainContent_PnlResultadosXml');
      const resFolio = document.getElementById('ctl00_MainContent_PnlResultados');
      const errCap = document.getElementById('ctl00_MainContent_pnlErrorCaptchaXml');
      const noRes = document.getElementById('ctl00_MainContent_alertNoResultadosXml');
      const isVisible = (el) =>
        el && el.offsetParent !== null && window.getComputedStyle(el).display !== 'none';
      return isVisible(resXml) || isVisible(resFolio) || isVisible(errCap) || isVisible(noRes);
    },
    { timeout: 25000 }
  );

  await new Promise((r) => setTimeout(r, 1200));

  const domState = await page.evaluate(() => {
    const resXml = document.getElementById('ctl00_MainContent_PnlResultadosXml');
    const resFolio = document.getElementById('ctl00_MainContent_PnlResultados');
    const errCap = document.getElementById('ctl00_MainContent_pnlErrorCaptchaXml');
    const noRes = document.getElementById('ctl00_MainContent_alertNoResultadosXml');
    const isVisible = (el) =>
      Boolean(el && el.offsetParent !== null && window.getComputedStyle(el).display !== 'none');
    return {
      success: isVisible(resXml) || isVisible(resFolio),
      captchaError: isVisible(errCap),
      noResult: isVisible(noRes),
      summaryText: (resXml || resFolio || errCap || noRes)?.innerText?.trim() || ''
    };
  });

  if (!domState.success) {
    return { ok: false, captchaError: domState.captchaError, summaryText: domState.summaryText };
  }

  // Tomar captura real de página completa y PDF oficial de 1 página
  const screenshotB64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
  const pdfBuf = await page.pdf({
    format: 'Letter',
    printBackground: true,
    scale: 0.78,
    margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' }
  });

  return {
    ok: true,
    screenshot: `data:image/png;base64,${screenshotB64}`,
    pdfBase64: Buffer.from(pdfBuf).toString('base64'),
    summaryText: domState.summaryText
  };
}

// ── Helper en segundo plano para captura del SAT ───────────────────────────
async function runSatXmlJob(jobId, tmpXmlPath, geminiKey) {
  let browser = null;
  try {
    setSatJob(jobId, { status: 'running', step: '⏳ 1/3 Abriendo portal oficial del SAT (Consulta por XML)...' });
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 1000 });

    console.log('🌐 [SAT Robot] Abriendo portal oficial del SAT (Consulta por XML)...');
    await page.goto(SAT_PORTAL_URL, { waitUntil: 'domcontentloaded', timeout: 40000 });
    await page.waitForSelector('#chkXml', { timeout: 15000 });

    // Cambiar a la pestaña "Consulta por archivo XML"
    await page.evaluate(() => {
      const chk = document.getElementById('chkXml');
      if (chk) {
        chk.checked = true;
        chk.click();
      }
      if (typeof guardarTab === 'function') guardarTab('verificaXml');
      if (typeof cambiarTab === 'function') cambiarTab('verificaXml');
    });
    await new Promise((r) => setTimeout(r, 800));

    // Subir el archivo XML
    const fileInput = await page.$('#ctl00_MainContent_fileUploadXML');
    if (!fileInput) throw new Error('No se encontró el campo de archivo XML en la página del SAT.');
    await fileInput.uploadFile(tmpXmlPath);
    await page.evaluate(() => {
      const fi = document.getElementById('ctl00_MainContent_fileUploadXML');
      if (fi) fi.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Esperar a que la imagen del Captcha esté cargada
    await page.waitForSelector('#ctl00_MainContent_ImgCaptchaXml', { visible: true, timeout: 10000 });
    await new Promise((r) => setTimeout(r, 500));

    // 3. Si tenemos Gemini API Key configurada, intentar resolver automáticamente (hasta 4 intentos)
    let geminiErrorMsg = null;
    if (geminiKey) {
      for (let intento = 1; intento <= 4; intento++) {
        try {
          setSatJob(jobId, { status: 'running', step: `⏳ 2/3 Leyendo Captcha con Gemini IA (intento ${intento}/4)...` });
          const captchaEl = await page.$('#ctl00_MainContent_ImgCaptchaXml');
          const capB64 = await captchaEl.screenshot({ encoding: 'base64' });
          console.log(`🤖 [SAT Robot] Leyendo Captcha con Gemini (intento ${intento}/4)...`);
          const codigoLeido = await solveCaptchaWithGemini(capB64, geminiKey);
          console.log(`🔢 [SAT Robot] Gemini leyó: "${codigoLeido}"`);

          setSatJob(jobId, { status: 'running', step: `⏳ 3/3 Verificando en el SAT (${codigoLeido}) y generando PDF...` });
          const attemptResult = await submitSatXmlCaptchaAndCapture(page, tmpXmlPath, codigoLeido);
          if (attemptResult.ok) {
            try { fs.unlinkSync(tmpXmlPath); } catch (e) {}
            await browser.close().catch(() => {});
            console.log('✅ [SAT Robot] Captura real y PDF oficial del SAT generados con éxito.');
            const finalResult = {
              ok: true,
              modo: 'gemini',
              intentos: intento,
              codigoCaptcha: codigoLeido,
              screenshot: attemptResult.screenshot,
              pdfBase64: attemptResult.pdfBase64,
              summaryText: attemptResult.summaryText
            };
            setSatJob(jobId, { status: 'done', step: '✅ Comprobante oficial generado', result: finalResult });
            return finalResult;
          }
          console.warn(`⚠️ [SAT Robot] Captcha rechazado en intento ${intento}, reintentando con nuevo captcha...`);
          await new Promise((r) => setTimeout(r, 700));
        } catch (gemErr) {
          geminiErrorMsg = gemErr.message;
          console.warn(`⚠️ [SAT Robot] Aviso Gemini en intento ${intento}:`, gemErr.message);
          break;
        }
      }
    }

    // 4. Si no hay llave de Gemini configurada (o si tras 4 intentos el captcha siguió difícil),
    // dejamos la sesión del navegador abierta 2 minutos y mandamos la miniatura del Captcha al usuario:
    const captchaEl = await page.$('#ctl00_MainContent_ImgCaptchaXml');
    const captchaB64 = await captchaEl.screenshot({ encoding: 'base64' });
    const newSessionId = `sat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    const timer = setTimeout(() => cleanupSatSession(newSessionId), 120000);
    activeSatSessions.set(newSessionId, {
      browser,
      page,
      xmlPath: tmpXmlPath,
      timer
    });

    const manualRes = {
      ok: true,
      needsManualCaptcha: true,
      sessionId: newSessionId,
      captchaImage: `data:image/png;base64,${captchaB64}`,
      geminiConfigured: Boolean(geminiKey),
      geminiError: geminiErrorMsg
    };
    setSatJob(jobId, { status: 'done', step: '🔢 Requiere Captcha manual', result: manualRes });
    return manualRes;
  } catch (err) {
    try { fs.unlinkSync(tmpXmlPath); } catch (e) {}
    if (browser) await browser.close().catch(() => {});
    console.error('🔥 [SAT Robot] Error:', err.message);
    setSatJob(jobId, { status: 'error', error: err.message });
    throw err;
  }
}

// ── POST /api/sat/captura-xml ──────────────────────────────────────────────
// Sube el archivo XML en "Consulta por archivo XML" del portal oficial del SAT,
// resuelve el Captcha con Gemini IA (o con código manual si se envía manualCaptcha)
// y devuelve la captura real + PDF oficial de 1 hoja del SAT.
router.post('/captura-xml', upload.single('xml'), async (req, res) => {
  const { sessionId, manualCaptcha } = req.body || {};
  const asyncMode = req.body?.asyncJob === 'true' || req.body?.asyncJob === true;

  // 1. Si viene de una sesión interactiva abierta con manualCaptcha:
  if (sessionId && manualCaptcha && activeSatSessions.has(sessionId)) {
    const sess = activeSatSessions.get(sessionId);
    try {
      const result = await submitSatXmlCaptchaAndCapture(
        sess.page,
        sess.xmlPath,
        manualCaptcha.trim()
      );
      if (result.ok) {
        cleanupSatSession(sessionId);
        return res.json({
          ok: true,
          modo: 'manual',
          screenshot: result.screenshot,
          pdfBase64: result.pdfBase64,
          summaryText: result.summaryText
        });
      }
      // Si el código manual fue incorrecto, tomar captura del nuevo captcha en la misma sesión
      const captchaEl = await sess.page.$('#ctl00_MainContent_ImgCaptchaXml');
      const newCapB64 = captchaEl ? await captchaEl.screenshot({ encoding: 'base64' }) : null;
      return res.json({
        ok: false,
        needsManualCaptcha: true,
        sessionId,
        captchaImage: newCapB64 ? `data:image/png;base64,${newCapB64}` : null,
        error: 'El código del captcha fue incorrecto. Intenta con la nueva imagen.'
      });
    } catch (err) {
      cleanupSatSession(sessionId);
      return res.status(500).json({ ok: false, error: 'Error en portal SAT: ' + err.message });
    }
  }

  // 2. Nueva solicitud: requiere el archivo XML
  const xmlFile = req.file;
  if (!xmlFile) {
    return res.status(400).json({ ok: false, error: 'Se requiere adjuntar el archivo XML de la factura.' });
  }

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const tmpXmlPath = path.join(os.tmpdir(), `sat_cfdi_${stamp}.xml`);
  fs.writeFileSync(tmpXmlPath, xmlFile.buffer);

  const geminiKey = getGeminiApiKey();
  const jobId = `satjob_${stamp}`;
  setSatJob(jobId, { status: 'running', step: '⏳ 1/3 Abriendo portal oficial del SAT...' });

  if (asyncMode) {
    runSatXmlJob(jobId, tmpXmlPath, geminiKey).catch(() => {});
    return res.json({ ok: true, asyncJob: true, jobId });
  }

  try {
    const result = await runSatXmlJob(jobId, tmpXmlPath, geminiKey);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/sat/captura-xml-status/:jobId ─────────────────────────────────
router.get('/captura-xml-status/:jobId', (req, res) => {
  const job = satJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'La tarea del SAT expiró o el servidor se reinició. Intenta de nuevo.' });
  }
  return res.json({ ok: true, ...job });
});

module.exports = router;
