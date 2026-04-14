const express = require('express');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const launchBrowser = (extraArgs = []) => require('puppeteer').launch({
  headless: false,
  executablePath: CHROME_PATH,
  defaultViewport: null,
  args: ['--ignore-certificate-errors', '--disable-web-security', ...extraArgs]
});

const fs = require('fs');
const os = require('os');
const path = require('path');
const router = express.Router();

const getUpload = () => {
  const multer = require('multer');
  return multer({ storage: multer.memoryStorage() });
};

// Fixed data for the buzón form
const BUZON_NOMBRE   = 'YONI JAVIER RUIZ DOMINGUEZ';
const BUZON_TELEFONO = '9921220329';

// ── POST /api/autotec/buzon ─────────────────────────────
// Sube XML y PDF al buzón de Autotec (buzonfecg.aspx)
// Body: multipart con campos 'xml' y 'pdf'
router.post('/buzon', (req, res, next) => getUpload().fields([{ name: 'xml' }, { name: 'pdf' }])(req, res, next), async (req, res) => {
  const xmlFile = req.files?.['xml']?.[0];
  const pdfFile = req.files?.['pdf']?.[0];
  
  if (!xmlFile) return res.status(400).json({ ok: false, error: 'Se requiere el archivo XML' });

  const tmpDir = os.tmpdir();
  const xmlPath = path.join(tmpDir, xmlFile.originalname);
  fs.writeFileSync(xmlPath, xmlFile.buffer);
  
  let pdfPath = null;
  if (pdfFile) {
    pdfPath = path.join(tmpDir, pdfFile.originalname);
    fs.writeFileSync(pdfPath, pdfFile.buffer);
  }

  const URL_BUZON = 'https://autotec.farrera.net:60002/buzonfecg.aspx';
  const correo = process.env.BUZON_CORREO || 'kaizen@toyotachiapas.com';
  const ordenCompra = req.body?.ordenCompra || '';

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto(URL_BUZON, { waitUntil: 'networkidle2', timeout: 45000 });

    await page.waitForSelector('input[type="text"]', { timeout: 15000 });
    const textInputs = await page.$$('input[type="text"]');

    if (textInputs[0]) { await textInputs[0].click({ clickCount: 3 }); await textInputs[0].type(BUZON_NOMBRE, { delay: 30 }); }
    if (textInputs[1]) { await textInputs[1].click({ clickCount: 3 }); await textInputs[1].type(BUZON_TELEFONO, { delay: 30 }); }
    if (textInputs[2]) { await textInputs[2].click({ clickCount: 3 }); await textInputs[2].type(correo, { delay: 30 }); }
    if (textInputs[3] && ordenCompra) { await textInputs[3].click({ clickCount: 3 }); await textInputs[3].type(ordenCompra, { delay: 30 }); }

    // Upload XML
    const fileInputs = await page.$$('input[type="file"]');
    if (fileInputs[0]) {
      await fileInputs[0].uploadFile(xmlPath);
      console.log('✅ XML subido');
    }

    await new Promise(r => setTimeout(r, 1500));

    // Click "Validar"
    console.log('📡 Haciendo clic en Validar...');
    const validarBtn = await page.$('input[type="submit"], input[value*="Validar" i], #btnValidarXML');
    if (validarBtn) {
      // Execute the click natively via JavaScript to avoid Puppeteer's simulated mouse events intercepting DOM destruction
      await page.evaluate(btn => btn.click(), validarBtn).catch(e => console.log('Clic evaluado con posible navegación.'));
      
      // Wait for any ASP.NET full PostBack to finish (ignore timeouts if it was just an AJAX UpdatePanel)
      await page.waitForNavigation({ waitUntil: 'networkidle0', timeout: 8000 }).catch(() => {});
      
      // Give it extra time for rendering the new inputs just in case
      await new Promise(r => setTimeout(r, 3000));
    }

    // Now check if the PDF input appeared (wrap in a retry loop to survive ASP.NET delayed navigations)
    if (pdfPath) {
      console.log('📡 Buscando campo para PDF de forma segura...');
      let intentos = 0;
      let exito = false;
      while (intentos < 3 && !exito) {
        try {
          // Re-query the elements on each loop in case the DOM was refreshed
          const allFileInputs = await page.$$('input[type="file"]');
          if (allFileInputs.length > 1) {
            await allFileInputs[1].uploadFile(pdfPath);
            console.log('✅ PDF subido en el intento ' + (intentos + 1));
            exito = true;
          } else {
            const pdfInput = await page.$('input[id*="pdf" i], input[name*="pdf" i]');
            if (pdfInput) {
              await pdfInput.uploadFile(pdfPath);
              console.log('✅ PDF subido directo en el intento ' + (intentos + 1));
              exito = true;
            } else {
              // Wait for it to appear
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        } catch (e) {
          if (e.message.includes('Execution context was destroyed') || e.message.includes('detached')) {
            console.log(`⚠️ Contexto destruido (recarga de ASP.NET). Reintentando (${intentos + 1}/3)...`);
            await new Promise(r => setTimeout(r, 3000));
          } else {
            console.log('Error inesperado subiendo PDF:', e.message);
            break;
          }
        }
        intentos++;
      }
    }

    await new Promise(r => setTimeout(r, 3000));
    const screenshot = await page.screenshot({ fullPage: true, encoding: 'base64' });

    // Keep the browser open so the user can review the portal submission manually
    // await browser.close();
    return res.json({
      ok: true,
      mensaje: 'XML y PDF procesados en el buzón de Autotec correctamente.',
      screenshot: `data:image/png;base64,${screenshot}`
    });

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    return res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (fs.existsSync(xmlPath)) fs.unlinkSync(xmlPath);
    if (pdfPath && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
  }
});


module.exports = router;
