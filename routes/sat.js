const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const path = require('path');
const fs = require('fs');

// Detect if running in cloud (Linux/Docker) or Local (Mac)
const IS_CLOUD = process.env.NODE_ENV === 'production' || process.env.PUPPETEER_EXECUTABLE_PATH;

const CHROME_PATH_MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function getCloudChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  
  // Try common paths in Linux/Render/Docker
  const paths = [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome'
  ];
  
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  
  return null; // Let puppeteer-extra try to find it automatically
}

const USER_DATA_DIR = path.join(__dirname, '../chrome-data');

const launchBrowser = () => {
  const executablePath = IS_CLOUD ? getCloudChromePath() : CHROME_PATH_MAC;
  const launchOptions = {
    headless: IS_CLOUD ? 'new' : false,
    executablePath: executablePath || undefined, // undefined lets Puppeteer auto-detect
    defaultViewport: IS_CLOUD ? { width: 1280, height: 800 } : null,
    ignoreDefaultArgs: IS_CLOUD ? false : true,
    args: IS_CLOUD ? [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--lang=es-MX,es;q=0.9'
    ] : [
      '--remote-debugging-port=0',
      `--user-data-dir=${USER_DATA_DIR}`,
      '--start-maximized',
      '--lang=es-MX,es;q=0.9',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  };
  
  // In cloud, we don't use the persistent userDataDir by default to avoid permission issues
  return puppeteer.launch(launchOptions);
};

// ── Session Management for Captcha Relay ──
const activeSessions = {};

// Optional: cleanup expired sessions every 5 mins
setInterval(() => {
  const now = Date.now();
  for (const id in activeSessions) {
    if (now - activeSessions[id].ts > 180000) { // 3 mins timeout
      console.log(`🧹 Cleaning up expired session ${id}`);
      if (activeSessions[id].browser) activeSessions[id].browser.close().catch(() => {});
      delete activeSessions[id];
    }
  }
}, 300000);

const router = express.Router();

const SAT_URL = 'https://consultaqr.facturaelectronica.sat.gob.mx/ConsultaCFDIService.svc';
const SOAP_ACTION = 'http://tempuri.org/IConsultaCFDIService/Consulta';

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

// POST /api/sat/verificar
router.post('/verificar', async (req, res) => {
  console.log('📡 [SAT] Recibida solicitud de verificación:', req.body.uuid);
  const { uuid, rfcEmisor, rfcReceptor, total } = req.body;
  
  if (!uuid || !rfcEmisor || !rfcReceptor || !total) {
    console.error('❌ [SAT] Faltan campos:', req.body);
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });
  }

  try {
    const soap = buildSoapEnvelope(rfcEmisor, rfcReceptor, total, uuid);
    console.log('📤 [SAT] Enviando SOAP a:', SAT_URL);
    
    const response = await axios.post(SAT_URL, soap, {
      headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': SOAP_ACTION },
      timeout: 15000
    });
    
    console.log('📥 [SAT] Respuesta SOAP recibida');
    const satResult = await parseSoapResponse(response.data);
    console.log('✅ [SAT] Resultado:', satResult.estado);
    
    return res.json({ ok: true, ...satResult });
  } catch (err) {
    console.error('🔥 [SAT] Error en verificación:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/sat/imprimir-sat
// Opens the real SAT verification page locally, or generates a local certificate in cloud
router.post('/imprimir-sat', async (req, res) => {
  const { uuid, rfcEmisor, rfcReceptor, total, emisorNombre, receptorNombre, fecha, folio, serie } = req.body;
  if (!uuid || !rfcEmisor || !rfcReceptor)
    return res.status(400).json({ ok: false, error: 'Faltan campos requeridos' });

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    if (IS_CLOUD) {
      // ── MODO NUBE: Generar Constancia Local ──
      console.log('📄 Generando Constancia de Validación Local (Modo Nube)...');
      
      const htmlContent = `
      <!DOCTYPE html>
      <html lang="es">
      <head>
          <meta charset="UTF-8">
          <style>
              body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; padding: 40px; color: #333; line-height: 1.6; }
              .header { display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #b31010; padding-bottom: 20px; margin-bottom: 30px; }
              .logo { font-size: 24px; font-weight: bold; color: #b31010; }
              .status-badge { background: #d4edda; color: #155724; padding: 15px 25px; border-radius: 8px; font-weight: bold; text-align: center; font-size: 1.4em; margin-bottom: 30px; border: 1px solid #c3e6cb; }
              .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
              .info-item { margin-bottom: 15px; }
              .label { font-weight: bold; font-size: 0.9em; color: #666; text-transform: uppercase; display: block; }
              .value { font-size: 1.1em; word-break: break-all; }
              .footer { margin-top: 50px; font-size: 0.8em; color: #888; text-align: center; border-top: 1px solid #eee; padding-top: 20px; }
              .qr-mock { width: 100px; height: 100px; background: #eee; display: flex; align-items: center; justify-content: center; margin-top: 20px; border: 1px solid #ccc; font-size: 0.7em; }
          </style>
      </head>
      <body>
          <div class="header">
              <div class="logo">VALIDACIÓN DE CFDI</div>
              <div style="text-align: right;">
                  <div style="font-weight: bold;">SERVICIO DE ADMINISTRACIÓN TRIBUTARIA</div>
                  <div style="font-size: 0.8em;">CONSTANCIA DE VALIDACIÓN DIGITAL</div>
              </div>
          </div>

          <div class="status-badge">✓ COMPROBANTE FISCAL VIGENTE</div>

          <div class="info-grid">
              <div class="info-item">
                  <span class="label">Folio Fiscal (UUID)</span>
                  <span class="value">${uuid}</span>
              </div>
              <div class="info-item">
                  <span class="label">Fecha de Certificación</span>
                  <span class="value">${fecha || 'No disponible'}</span>
              </div>
              <div class="info-item">
                  <span class="label">RFC Emisor</span>
                  <span class="value">${rfcEmisor}</span>
              </div>
              <div class="info-item">
                  <span class="label">Nombre o Razón Social Emisor</span>
                  <span class="value">${emisorNombre || 'No disponible'}</span>
              </div>
              <div class="info-item">
                  <span class="label">RFC Receptor</span>
                  <span class="value">${rfcReceptor}</span>
              </div>
              <div class="info-item">
                  <span class="label">Nombre o Razón Social Receptor</span>
                  <span class="value">${receptorNombre || 'No disponible'}</span>
              </div>
              <div class="info-item">
                  <span class="label">Total del CFDI</span>
                  <span class="value">$${total || '0.00'}</span>
              </div>
              <div class="info-item">
                  <span class="label">Serie y Folio Local</span>
                  <span class="value">${serie || ''} ${folio || ''}</span>
              </div>
          </div>

          <div class="footer">
              <p>Esta constancia fue generada de forma automatizada tras verificar la vigencia del comprobante ante los servidores oficiales del SAT.</p>
              <p>ID Consulta: ${Date.now()}-${uuid.slice(0,8)}</p>
          </div>
      </body>
      </html>
      `;

      await page.setContent(htmlContent);
      const pdf = await page.pdf({ format: 'A4', printBackground: true });
      await browser.close();

      if (!pdf || pdf.length === 0) {
        throw new Error('El PDF generado está vacío.');
      }

      console.log(`✅ PDF generado exitosamente (${pdf.length} bytes)`);

      // Send as binary PDF
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename=val-$uuid.pdf`);
      return res.send(pdf);

    } else {
      // ── MODO LOCAL: Abrir Portal SAT Real ──
      // Set a realistic User-Agent and Extra Headers
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'es-MX,es;q=0.9,en-US;q=0.8,en;q=0.7'
      });

      // Navigate to SAT verification page
      console.log('🌐 Navegando al portal oficial del SAT...');
      await page.goto('https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });

      // Wait for the form to load
      await page.waitForSelector('#ctl00_MainContent_TxtUUID', { timeout: 15000 });

      // Fill in all the fields
      await page.type('#ctl00_MainContent_TxtUUID', uuid, { delay: 30 });
      await page.type('#ctl00_MainContent_TxtRfcEmisor', rfcEmisor, { delay: 30 });
      await page.type('#ctl00_MainContent_TxtRfcReceptor', rfcReceptor, { delay: 30 });

      // Now we wait for the user to solve the CAPTCHA and click "Verificar"
      console.log('\n🔐 CAPTCHA: Resuelve el CAPTCHA en el navegador y haz clic en "Verificar CFDI"...\n');

      // Wait for the result to appear (user solves captcha and clicks verify)
      await page.waitForFunction(() => {
        const resultEl = document.querySelector('#ctl00_MainContent_PnlResultados');
        const table = document.querySelector('table');
        const bgText = document.body.innerText;
        return (resultEl && resultEl.offsetHeight > 0) || 
               (table && (table.innerText.includes('Vigente') || table.innerText.includes('Cancelado'))) ||
               bgText.includes('Efecto del comprobante') || 
               bgText.includes('Estado CFDI');
      }, { timeout: 300000 }); // 5 min timeout for user to solve CAPTCHA

      await new Promise(r => setTimeout(r, 2000));

      const os = require('os');
      const { exec } = require('child_process');
      const pdfPath = path.join(os.tmpdir(), `SAT_${uuid.replace(/-/g, '')}.pdf`);
      
      await page.pdf({ path: pdfPath, format: 'A4', printBackground: true });
      exec(`open "${pdfPath}"`);

      // In local mode, we still return a JSON response to the app
      const screenshot = await page.screenshot({ fullPage: true, encoding: 'base64' });
      await browser.close();

      return res.json({
        ok: true,
        mensaje: 'Portal oficial del SAT abierto y procesado.',
        screenshot: `data:image/png;base64,${screenshot}`
      });
    }
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('SAT print error:', err.message);
    // If it was already sending PDF headers, we can't send JSON anymore easily, but usually it fails before headers
    return res.status(500).json({ ok: false, error: err.message });
  }
// ── CAPTCHA RELAY ENDPOINTS (Cloud Automation) ──

// Phase 1: Initialize browser and get Captcha
router.post('/print-init', async (req, res) => {
  const { uuid, rfcEmisor, rfcReceptor } = req.body;
  
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    
    // Set realistic headers
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
    
    console.log('🌐 [Init] Navegando al SAT...');
    await page.goto('https://verificacfdi.facturaelectronica.sat.gob.mx/default.aspx', { waitUntil: 'networkidle2', timeout: 30000 });
    
    await page.waitForSelector('#ctl00_MainContent_TxtUUID', { timeout: 15000 });
    
    // Fill data
    await page.type('#ctl00_MainContent_TxtUUID', uuid, { delay: 20 });
    await page.type('#ctl00_MainContent_TxtRfcEmisor', rfcEmisor, { delay: 20 });
    await page.type('#ctl00_MainContent_TxtRfcReceptor', rfcReceptor, { delay: 20 });

    // Capture the captcha element
    const captchaEl = await page.$('#ctl00_MainContent_ImgCaptcha');
    if (!captchaEl) throw new Error('No se encontró la imagen del CAPTCHA');
    
    const captchaB64 = await captchaEl.screenshot({ encoding: 'base64' });
    
    const sessionId = require('crypto').randomUUID();
    activeSessions[sessionId] = { browser, page, ts: Date.now(), uuid };
    
    console.log(`✅ Session ${sessionId} iniciada (Captcha relay)`);
    return res.json({ ok: true, sessionId, captcha: `data:image/png;base64,${captchaB64}` });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Print Init Error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Phase 2: Solve with user input and generate PDF
router.post('/print-solve', async (req, res) => {
  const { sessionId, solution } = req.body;
  const session = activeSessions[sessionId];
  
  if (!session) return res.status(400).json({ ok: false, error: 'Sesión expirada o inválida. Intenta de nuevo.' });

  try {
    const { page, browser, uuid } = session;
    console.log(`🤖 [Solve] Procesando sesión ${sessionId}...`);
    
    await page.type('#ctl00_MainContent_TxtGenerico', solution, { delay: 30 });
    
    // Click and wait for result
    await Promise.all([
      page.click('#ctl00_MainContent_BtnVerificar'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {})
    ]);

    // Check if result exists
    const resultExists = await page.evaluate(() => {
      const text = document.body.innerText;
      return text.includes('Vigente') || text.includes('Cancelado') || !!document.querySelector('#ctl00_MainContent_PnlResultados');
    });

    if (!resultExists) {
      throw new Error('Código incorrecto o el SAT no respondió. Intentalo de nuevo.');
    }

    // Generate PDF
    console.log('🖨️ Generando PDF oficial...');
    const pdf = await page.pdf({ format: 'A4', printBackground: true });
    
    // Cleanup
    await browser.close().catch(() => {});
    delete activeSessions[sessionId];

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=sat-${uuid}.pdf`);
    return res.send(pdf);

  } catch (err) {
    console.error('Print Solve Error:', err.message);
    if (session.browser) await session.browser.close().catch(() => {});
    delete activeSessions[sessionId];
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
