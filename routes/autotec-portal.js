const express = require('express');
const { launchBrowser } = require('../utils/browser');
const { getDB, backupDatabaseToDrive } = require('./gastos');
const router = express.Router();

const URL_PORTAL = 'https://autotec.farrera.net/EnvioFacturasGastos/Account/Login?ReturnUrl=%2FEnvioFacturasGastos%2Fhome%2Findex';
const DEFAULT_EMPRESA_ID = '29'; // VALOR FARRERA AUTOMOTRIZ S. DE R.L. DE C.V.

const portalJobs = new Map();

function getPortalCredentials() {
  const db = getDB();
  const getVal = (k) => {
    try {
      const r = db.prepare('SELECT valor FROM bandeja_config WHERE clave = ?').get(k);
      return r?.valor || '';
    } catch (e) {
      return '';
    }
  };

  const userFromDb = getVal('autotec_user');
  const passFromDb = getVal('autotec_pass');
  const empFromDb  = getVal('autotec_empresa');

  const envUser = process.env.AUTOTEC_USER && process.env.AUTOTEC_USER !== 'tu_usuario_autotec' ? process.env.AUTOTEC_USER : '';
  const envPass = process.env.AUTOTEC_PASS && process.env.AUTOTEC_PASS !== 'tu_contraseña_autotec' ? process.env.AUTOTEC_PASS : '';

  return {
    user: (userFromDb || envUser || '').trim(),
    pass: (passFromDb || envPass || '').trim(),
    empresa: (empFromDb || DEFAULT_EMPRESA_ID).trim()
  };
}

function savePortalCredentials(user, pass, empresa = DEFAULT_EMPRESA_ID) {
  const db = getDB();
  const stmt = db.prepare(`
    INSERT INTO bandeja_config (clave, valor, updated_at)
    VALUES (?, ?, datetime('now','localtime'))
    ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor, updated_at = datetime('now','localtime')
  `);
  stmt.run('autotec_user', (user || '').trim());
  stmt.run('autotec_pass', (pass || '').trim());
  stmt.run('autotec_empresa', (empresa || DEFAULT_EMPRESA_ID).trim());
  backupDatabaseToDrive().catch(() => {});
}

// ── GET /api/portal/config ──────────────────────────────
router.get('/config', (req, res) => {
  const creds = getPortalCredentials();
  res.json({
    ok: true,
    configured: Boolean(creds.user && creds.pass),
    user: creds.user || '',
    empresa: creds.empresa || DEFAULT_EMPRESA_ID
  });
});

// ── POST /api/portal/config ─────────────────────────────
router.post('/config', (req, res) => {
  try {
    const { user, pass, empresa } = req.body || {};
    if (!user || !pass) {
      return res.status(400).json({ ok: false, error: 'Escribe el usuario y la contraseña de Autotec.' });
    }
    savePortalCredentials(user, pass, empresa || DEFAULT_EMPRESA_ID);
    return res.json({
      ok: true,
      configured: true,
      user: user.trim(),
      empresa: (empresa || DEFAULT_EMPRESA_ID).trim()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

async function runPortalJob(jobId, params, creds) {
  const { uuid, rfcEmisor, noFactura, soloPrevisualizar } = params;
  const setStep = (step) => {
    const j = portalJobs.get(jobId);
    if (j) j.step = step;
  };

  let browser = null;
  try {
    setStep('⏳ 1/3 Iniciando sesión en EnvioFacturasGastos (Valor Farrera)...');
    browser = await launchBrowser(['--ignore-certificate-errors', '--disable-web-security']);
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 960 });

    await page.goto(URL_PORTAL, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('#inputEmail, input[name="Username"]', { timeout: 20000 });

    await page.evaluate((c) => {
      const u = document.getElementById('inputEmail') || document.querySelector('input[name="Username"]');
      const p = document.getElementById('inputPassword') || document.querySelector('input[name="Password"]');
      const emp = document.getElementById('empresa') || document.querySelector('select[name="empresa"]');
      if (u) {
        u.value = c.user;
        u.dispatchEvent(new Event('input', { bubbles: true }));
        u.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (p) {
        p.value = c.pass;
        p.dispatchEvent(new Event('input', { bubbles: true }));
        p.dispatchEvent(new Event('change', { bubbles: true }));
      }
      if (emp) {
        emp.value = c.empresa || '29';
        emp.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, creds);

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 35000 }).catch(() => {}),
      page.click('input[type="submit"], button[type="submit"], .btn-signin').catch(() => {})
    ]);
    await new Promise((r) => setTimeout(r, 2500));

    const currentUrl = page.url();
    if (/\/Account\/Login/i.test(currentUrl)) {
      const errText = await page.evaluate(() => {
        const errEl = document.querySelector('.validation-summary-errors, .field-validation-error, .alert-danger');
        return errEl ? errEl.innerText.trim() : 'Usuario, contraseña o empresa incorrectos en EnvioFacturasGastos.';
      });
      throw new Error(errText);
    }

    setStep('⏳ 2/3 Buscando y marcando únicamente la factura en la tabla...');
    const folioClean = (noFactura && noFactura !== '—') ? String(noFactura).trim() : '';
    const uuidShort = (uuid && uuid !== '—') ? String(uuid).split('-')[0].trim() : '';
    const searchTerm = folioClean || uuidShort || rfcEmisor || '';

    const searchInput = await page.$('input[type="search"], input[id*="busq" i], input[placeholder*="busca" i], input[name*="search" i]').catch(() => null);
    if (searchInput && searchTerm) {
      await searchInput.click({ clickCount: 3 });
      await searchInput.type(searchTerm, { delay: 35 });
      await page.keyboard.press('Enter');
      await new Promise((r) => setTimeout(r, 2000));
    }

    const matchInfo = await page.evaluate((criteria) => {
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      checkboxes.forEach((cb) => {
        if (cb.checked) cb.click();
      });

      const rows = Array.from(document.querySelectorAll('table tbody tr, tr'));
      let matchedRowText = null;
      let checkedCount = 0;

      for (const tr of rows) {
        const cb = tr.querySelector('input[type="checkbox"]');
        if (!cb) continue;
        const text = (tr.innerText || '').toUpperCase();

        const hasUuid = criteria.uuid && criteria.uuid !== '—' && text.includes(criteria.uuid.toUpperCase());
        const hasUuidShort = criteria.uuidShort && text.includes(criteria.uuidShort.toUpperCase());
        const hasFolio = criteria.folioClean && new RegExp(`\\b${criteria.folioClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
        const hasRfcAndFolio = criteria.rfcEmisor && text.includes(criteria.rfcEmisor.toUpperCase()) && hasFolio;

        if (hasUuid || hasRfcAndFolio || hasFolio || hasUuidShort) {
          cb.click();
          if (!cb.checked) cb.checked = true;
          cb.dispatchEvent(new Event('change', { bubbles: true }));
          matchedRowText = (tr.innerText || '').replace(/\s+/g, ' ').trim();
          checkedCount++;
          break;
        }
      }

      return {
        totalRowsWithCheckbox: rows.filter((r) => r.querySelector('input[type="checkbox"]')).length,
        checkedCount,
        matchedRowText
      };
    }, { uuid, uuidShort, folioClean, rfcEmisor });

    await new Promise((r) => setTimeout(r, 1200));

    let enviado = false;
    let modalVerificado = false;

    if (matchInfo.checkedCount === 1 && !soloPrevisualizar) {
      setStep('⏳ 3/3 Confirmando envío en modal "Facturas Seleccionadas" y capturando...');
      const clickedEnviar = await page.evaluate(() => {
        const els = Array.from(document.querySelectorAll('button, input[type="button"], input[type="submit"], a.btn'));
        const btn = els.find((el) => /enviar/i.test((el.innerText || el.value || '').trim()));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });

      if (clickedEnviar) {
        await new Promise((r) => setTimeout(r, 2000));
        const modalAction = await page.evaluate(() => {
          const modals = Array.from(document.querySelectorAll('.modal.in, .modal.show, [role="dialog"], .sweet-alert, .bootbox'));
          const visibleModal = modals.find((m) => m.offsetParent !== null);
          if (!visibleModal) return { hadModal: false, confirmed: true };

          const modalBtns = Array.from(visibleModal.querySelectorAll('button, input[type="submit"], a.btn'));
          const confirmBtn = modalBtns.find((b) => /enviar|aceptar|confirmar|si|sí|guardar/i.test((b.innerText || b.value || '').trim()));
          if (confirmBtn) {
            confirmBtn.click();
            return { hadModal: true, confirmed: true };
          }
          return { hadModal: true, confirmed: false };
        });

        modalVerificado = modalAction.hadModal;
        await new Promise((r) => setTimeout(r, 3000));
        enviado = true;
      }
    }

    const screenshotB64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
    const pdfBuf = await page.pdf({
      format: 'Letter',
      landscape: true,
      printBackground: true,
      margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' }
    });

    await browser.close().catch(() => {});

    const result = {
      ok: true,
      encontrada: matchInfo.checkedCount === 1,
      checkedCount: matchInfo.checkedCount,
      matchedRowText: matchInfo.matchedRowText,
      totalPendientesEnTabla: matchInfo.totalRowsWithCheckbox,
      enviado,
      modalVerificado,
      mensaje:
        matchInfo.checkedCount === 1
          ? enviado
            ? `✅ Factura localizada, marcada individualmente y enviada en EnvioFacturasGastos.`
            : `👁️ Factura localizada y marcada individualmente en EnvioFacturasGastos (Previsualización).`
          : `⚠️ Se entró a EnvioFacturasGastos pero no apareció el folio ${folioClean || uuidShort} en la tabla (${matchInfo.totalRowsWithCheckbox} pendientes visibles). Revisa la captura.`,
      screenshot: `data:image/png;base64,${screenshotB64}`,
      pdfBase64: Buffer.from(pdfBuf).toString('base64')
    };

    portalJobs.set(jobId, { status: 'done', step: '✅ Completado', result });
    setTimeout(() => portalJobs.delete(jobId), 300000);
    return result;
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('🔥 [Portal Nube 2] Error:', err.message);
    portalJobs.set(jobId, { status: 'error', error: err.message });
    setTimeout(() => portalJobs.delete(jobId), 300000);
    throw err;
  }
}

// ── POST /api/portal/enviar ─────────────────────────────
router.post('/enviar', async (req, res) => {
  const { uuid, rfcEmisor, noFactura, total, soloPrevisualizar, asyncJob } = req.body || {};
  const creds = getPortalCredentials();

  if (!creds.user || !creds.pass) {
    return res.status(400).json({
      ok: false,
      needsCredentials: true,
      error: 'Configura primero tu usuario y contraseña de Autotec (Nube 2) en el botón "🔑 Configurar Acceso Autotec".'
    });
  }

  const jobId = `portal_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  portalJobs.set(jobId, { status: 'running', step: '⏳ Iniciando sesión en EnvioFacturasGastos...' });

  if (asyncJob) {
    runPortalJob(jobId, { uuid, rfcEmisor, noFactura, total, soloPrevisualizar }, creds).catch(() => {});
    return res.json({ ok: true, asyncJob: true, jobId });
  }

  try {
    const result = await runPortalJob(jobId, { uuid, rfcEmisor, noFactura, total, soloPrevisualizar }, creds);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/portal/status/:jobId ───────────────────────
router.get('/status/:jobId', (req, res) => {
  const job = portalJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ ok: false, error: 'La tarea expiró o el servidor se reinició. Intenta de nuevo.' });
  }
  if (job.status === 'done' || job.status === 'error') {
    setTimeout(() => portalJobs.delete(req.params.jobId), 5000);
  }
  return res.json({ ok: true, ...job });
});

module.exports = router;
