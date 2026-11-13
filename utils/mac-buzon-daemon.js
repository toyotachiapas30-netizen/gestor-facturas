#!/usr/bin/env node
/**
 * Agente Local Automático 24/7 (Puerto 443 HTTPS Relay)
 * Conecta https://control.pagos.toyoter.com con https://autotec.farrera.net:60002/buzonfecg.aspx
 * Sin keep-alive (evita sockets colgados con read ETIMEDOUT en macOS) y con soporte de envío atómico en 1 solo viaje.
 */

const https = require('https');

const DO_SUPABASE_URL = 'https://ihwucfdwjnguwjxncwdw.supabase.co';
const DO_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlod3VjZmR3am5ndXdqeG5jd2R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NzY4MzQsImV4cCI6MjA5NTA1MjgzNH0.A2ND8DKBDGQ6ymhUDs_x6qZtcStoUDyk_0akG2hVD7Q';
const RELAY_DATE = '2099-12-30';

// Desactivar keepAlive para evitar sockets muertos ("read ETIMEDOUT") tras cambios de estado de red
const supaAgent = new https.Agent({ keepAlive: false });
const autotecAgent = new https.Agent({ keepAlive: false, rejectUnauthorized: false });

const inFlight = new Set();
const lastXmlValidationBySession = new Map();
let lastXmlValidationGlobal = null;

function getSessionKey(headers = {}) {
  const cookie = headers['cookie'] || headers['Cookie'] || '';
  const m = cookie.match(/ASP\.NET_SessionId=([^;\s]+)/i);
  return m ? m[1] : '__default__';
}

function extractTokens(html) {
  const vs = html.match(/id="__VIEWSTATE"\s+value="([^"]*)"/)?.[1] || '';
  const vsg = html.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/)?.[1] || '';
  const ev = html.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/)?.[1] || '';
  return { vs, vsg, ev };
}

function extractAlerts(html) {
  const m1 = [...html.matchAll(/muestraaviso\(['"]([^'"]+)['"]\)/gi)].map(m => m[1]);
  const m2 = [...html.matchAll(/alert\(['"]([^'"]+)['"]\)/gi)].map(m => m[1]);
  return [...new Set([...m1, ...m2])];
}

function buildMultipart(fields, files) {
  const boundary = '----WebKitFormBoundary' + Math.random().toString(16).slice(2, 14);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v ?? ''}\r\n`,
        'utf8'
      )
    );
  }
  for (const f of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field}"; filename="${f.filename}"\r\nContent-Type: ${f.contentType}\r\n\r\n`,
        'utf8'
      )
    );
    parts.push(f.data);
    parts.push(Buffer.from('\r\n', 'utf8'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return {
    boundary,
    body: Buffer.concat(parts)
  };
}

function replaceMultipartField(bodyBuf, fieldName, newValue) {
  if (!Buffer.isBuffer(bodyBuf) || !newValue) return bodyBuf;
  const marker = Buffer.from(`name="${fieldName}"\r\n\r\n`);
  const idx = bodyBuf.indexOf(marker);
  if (idx === -1) return bodyBuf;
  const valStart = idx + marker.length;
  const valEnd = bodyBuf.indexOf(Buffer.from('\r\n--'), valStart);
  if (valEnd === -1) return bodyBuf;
  return Buffer.concat([
    bodyBuf.subarray(0, valStart),
    Buffer.from(newValue, 'utf8'),
    bodyBuf.subarray(valEnd)
  ]);
}

function supaRequest(method, path, bodyObj = null, extraHeaders = {}, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };

    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const headers = {
      apikey: DO_SUPABASE_KEY,
      Authorization: `Bearer ${DO_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Connection: 'close',
      ...extraHeaders
    };
    if (bodyStr) {
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }

    const req = https.request(
      `${DO_SUPABASE_URL}${path}`,
      {
        method,
        headers,
        agent: supaAgent,
        timeout: timeoutMs
      },
      res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            return done(new Error(`HTTP ${res.statusCode}: ${raw}`));
          }
          try {
            done(null, raw ? JSON.parse(raw) : null);
          } catch (e) {
            done(null, raw);
          }
        });
        res.on('error', err => done(err));
      }
    );

    const timer = setTimeout(() => {
      try { req.destroy(); } catch (_) {}
      done(new Error('Supabase hard timeout'));
    }, timeoutMs);

    req.on('error', err => done(err));
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      done(new Error('Supabase socket timeout'));
    });

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function forwardToAutotecOnce(reqData, overrideBodyBuf = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(val);
    };

    const bodyBuf = overrideBodyBuf || (reqData.bodyB64 ? Buffer.from(reqData.bodyB64, 'base64') : Buffer.alloc(0));
    const outHeaders = { ...(reqData.headers || {}) };
    outHeaders['Host'] = 'autotec.farrera.net:60002';
    outHeaders['Connection'] = 'close';
    delete outHeaders['user-agent'];
    outHeaders['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    if (outHeaders['origin'] || outHeaders['Origin']) {
      delete outHeaders['origin'];
      outHeaders['Origin'] = 'https://autotec.farrera.net:60002';
    }
    if (outHeaders['referer'] || outHeaders['Referer']) {
      delete outHeaders['referer'];
      outHeaders['Referer'] = 'https://autotec.farrera.net:60002/buzonfecg.aspx';
    }
    if (bodyBuf.length > 0) {
      outHeaders['Content-Length'] = bodyBuf.length;
    }

    const req = https.request(
      {
        hostname: 'autotec.farrera.net',
        port: 60002,
        path: reqData.path || '/buzonfecg.aspx',
        method: reqData.method || 'GET',
        headers: outHeaders,
        agent: autotecAgent,
        rejectUnauthorized: false,
        timeout: timeoutMs
      },
      res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const resBuf = Buffer.concat(chunks);
          done(null, {
            statusCode: res.statusCode || 200,
            contentType: res.headers['content-type'] || 'text/html; charset=utf-8',
            setCookie: res.headers['set-cookie'] || [],
            bodyB64: resBuf.toString('base64')
          });
        });
        res.on('error', err => done(err));
      }
    );

    const timer = setTimeout(() => {
      try { req.destroy(); } catch (_) {}
      done(new Error('Timeout conectando a autotec.farrera.net:60002'));
    }, timeoutMs);

    req.on('error', err => done(err));
    req.on('timeout', () => {
      try { req.destroy(); } catch (_) {}
      done(new Error('Timeout conectando a autotec.farrera.net:60002'));
    });

    if (bodyBuf.length > 0) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

async function forwardToAutotec(reqData, overrideBodyBuf = null) {
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await forwardToAutotecOnce(reqData, overrideBodyBuf, 30000);
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 250));
      }
    }
  }
  throw lastErr;
}

// Ejecuta los 3 pasos (GET -> Validar XML -> Enviar PDF) en un solo trabajo atómico local
async function executeAtomicBuzonSubmit(reqData) {
  const xmlBuffer = Buffer.from(reqData.xmlB64 || '', 'base64');
  const pdfBuffer = Buffer.from(reqData.pdfB64 || '', 'base64');
  const xmlFilename = reqData.xmlFilename || 'factura.xml';
  const pdfFilename = reqData.pdfFilename || 'factura.pdf';
  const nombre = reqData.nombre || 'YONI JAVIER RUIZ DOMINGUEZ';
  const telefono = reqData.telefono || '9616179900';
  const correo = reqData.correo || 'toyotachiapas30@gmail.com';
  const ordenCompra = reqData.ordenCompra || '';

  // 1. GET /buzonfecg.aspx
  const getRes = await forwardToAutotec({ method: 'GET', path: '/buzonfecg.aspx', headers: {} });
  const sessionCookies = (getRes.setCookie || []).map(c => c.split(';')[0]).join('; ');
  const getHtml = Buffer.from(getRes.bodyB64 || '', 'base64').toString('utf8');
  const t1 = extractTokens(getHtml);
  if (!t1.vs) {
    throw new Error('El portal de Autotec no devolvió __VIEWSTATE.');
  }

  // 2. POST Validar XML
  const mpVal = buildMultipart(
    {
      ctl00_ToolkitScriptManager1_HiddenField: '',
      __EVENTTARGET: 'ctl00$ContentPlaceHolder1$btnValidaXML',
      __EVENTARGUMENT: '',
      __VIEWSTATE: t1.vs,
      __VIEWSTATEGENERATOR: t1.vsg,
      __EVENTVALIDATION: t1.ev,
      'ctl00$ContentPlaceHolder1$txtNombre': nombre,
      'ctl00$ContentPlaceHolder1$txtTelefono': telefono,
      'ctl00$ContentPlaceHolder1$txtMail': correo,
      'ctl00$ContentPlaceHolder1$txtOrdenCompra': ordenCompra
    },
    [
      { field: 'ctl00$ContentPlaceHolder1$FileUploadXML', filename: xmlFilename, contentType: 'text/xml', data: xmlBuffer },
      { field: 'ctl00$ContentPlaceHolder1$FileUploadPDF', filename: '', contentType: 'application/octet-stream', data: Buffer.alloc(0) }
    ]
  );

  const valRes = await forwardToAutotec(
    {
      method: 'POST',
      path: '/buzonfecg.aspx',
      headers: {
        Cookie: sessionCookies,
        'Content-Type': `multipart/form-data; boundary=${mpVal.boundary}`,
        Referer: 'https://autotec.farrera.net:60002/buzonfecg.aspx'
      }
    },
    mpVal.body
  );

  const valHtml = Buffer.from(valRes.bodyB64 || '', 'base64').toString('utf8');
  const alertsVal = extractAlerts(valHtml);
  const t2 = extractTokens(valHtml);
  const hasBtnEnviar = /ctl00_ContentPlaceHolder1_btnEnviar/i.test(valHtml);
  if (!hasBtnEnviar && alertsVal.length > 0) {
    return {
      statusCode: 400,
      contentType: 'application/json',
      bodyB64: Buffer.from(JSON.stringify({ ok: false, error: alertsVal.join(' | '), alertsVal }), 'utf8').toString('base64')
    };
  }

  // 3. POST Enviar PDF inmediatamente (<20ms)
  const mpEnv = buildMultipart(
    {
      ctl00_ToolkitScriptManager1_HiddenField: '',
      __EVENTTARGET: 'ctl00$ContentPlaceHolder1$btnEnviar',
      __EVENTARGUMENT: '',
      __VIEWSTATE: t2.vs || t1.vs,
      __VIEWSTATEGENERATOR: t2.vsg || t1.vsg,
      __EVENTVALIDATION: t2.ev || t1.ev,
      'ctl00$ContentPlaceHolder1$txtNombre': nombre,
      'ctl00$ContentPlaceHolder1$txtTelefono': telefono,
      'ctl00$ContentPlaceHolder1$txtMail': correo,
      'ctl00$ContentPlaceHolder1$txtOrdenCompra': ordenCompra
    },
    [
      { field: 'ctl00$ContentPlaceHolder1$FileUploadXML', filename: '', contentType: 'application/octet-stream', data: Buffer.alloc(0) },
      { field: 'ctl00$ContentPlaceHolder1$FileUploadPDF', filename: pdfFilename, contentType: 'application/pdf', data: pdfBuffer }
    ]
  );

  const envRes = await forwardToAutotec(
    {
      method: 'POST',
      path: '/buzonfecg.aspx',
      headers: {
        Cookie: sessionCookies,
        'Content-Type': `multipart/form-data; boundary=${mpEnv.boundary}`,
        Referer: 'https://autotec.farrera.net:60002/buzonfecg.aspx'
      }
    },
    mpEnv.body
  );

  const envHtml = Buffer.from(envRes.bodyB64 || '', 'base64').toString('utf8');
  const alertsEnv = extractAlerts(envHtml);

  return {
    statusCode: 200,
    contentType: 'application/json',
    bodyB64: Buffer.from(
      JSON.stringify({
        ok: true,
        alertsVal,
        alertsEnv,
        avisoPortal: alertsEnv[0] || alertsVal[0] || 'Factura registrada exitosamente en el Buzón de Grupo Farrera.'
      }),
      'utf8'
    ).toString('base64')
  };
}

async function processRow(row) {
  if (!row || !row.id || inFlight.has(row.id)) return;
  inFlight.add(row.id);
  try {
    const claimed = await supaRequest(
      'PATCH',
      `/rest/v1/taller_citas?id=eq.${row.id}&estado=eq.PENDING`,
      { estado: 'PROCESSING' },
      { Prefer: 'return=representation' }
    );
    if (!Array.isArray(claimed) || claimed.length === 0) {
      return;
    }

    const reqData = row.datos_recepcion || {};
    const method = reqData.method || 'GET';
    const path = reqData.path || '/buzonfecg.aspx';
    console.log(`[${new Date().toISOString()}] -> ${method} ${path}`);

    let resObj;
    if (method === 'ATOMIC_BUZON') {
      resObj = await executeAtomicBuzonSubmit(reqData);
    } else {
      let overrideBodyBuf = null;
      if (method === 'POST' && reqData.bodyB64) {
        const rawBuf = Buffer.from(reqData.bodyB64, 'base64');
        const sessKey = getSessionKey(reqData.headers);
        if (rawBuf.includes(Buffer.from('ctl00$ContentPlaceHolder1$btnValidaXML'))) {
          const saved = { reqData, timestamp: Date.now() };
          lastXmlValidationBySession.set(sessKey, saved);
          lastXmlValidationGlobal = saved;
        } else if (rawBuf.includes(Buffer.from('ctl00$ContentPlaceHolder1$btnEnviar'))) {
          const prev = lastXmlValidationBySession.get(sessKey) || lastXmlValidationGlobal;
          if (prev && Date.now() - prev.timestamp > 1500) {
            try {
              console.log(`[${new Date().toISOString()}] 🔄 Re-validando XML atómicamente antes de Enviar PDF (sesión ${sessKey})...`);
              const revalRes = await forwardToAutotec({
                ...prev.reqData,
                headers: {
                  ...(prev.reqData.headers || {}),
                  Cookie: reqData.headers?.cookie || reqData.headers?.Cookie || prev.reqData.headers?.cookie || prev.reqData.headers?.Cookie || ''
                }
              });
              const revalHtml = Buffer.from(revalRes.bodyB64 || '', 'base64').toString('utf8');
              const freshVs = revalHtml.match(/id="__VIEWSTATE"\s+value="([^"]*)"/)?.[1];
              const freshEv = revalHtml.match(/id="__EVENTVALIDATION"\s+value="([^"]*)"/)?.[1];
              if (freshVs && freshEv) {
                let updatedBuf = replaceMultipartField(rawBuf, '__VIEWSTATE', freshVs);
                updatedBuf = replaceMultipartField(updatedBuf, '__EVENTVALIDATION', freshEv);
                overrideBodyBuf = updatedBuf;
                console.log(`[${new Date().toISOString()}] ✅ XML re-validado (<100ms antes de Enviar PDF).`);
              }
            } catch (revalErr) {
              console.error(`[${new Date().toISOString()}] Warn re-validación previa:`, revalErr.message);
            }
          }
        }
      }
      resObj = await forwardToAutotec(reqData, overrideBodyBuf);
    }

    await supaRequest('PATCH', `/rest/v1/taller_citas?id=eq.${row.id}`, {
      estado: 'DONE',
      datos_recepcion: {
        ...reqData,
        res: resObj
      }
    });
    console.log(`[${new Date().toISOString()}] <- HTTP ${resObj.statusCode} (${Buffer.from(resObj.bodyB64 || '', 'base64').length} bytes)`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ERROR:`, err.message);
    await supaRequest('PATCH', `/rest/v1/taller_citas?id=eq.${row.id}`, {
      estado: 'ERROR',
      datos_recepcion: {
        ...(row.datos_recepcion || {}),
        error: err.message
      }
    }).catch(() => {});
  } finally {
    setTimeout(() => inFlight.delete(row.id), 10000);
  }
}

async function pollLoop() {
  console.log('====================================================');
  console.log(' PUENTE AUTOMATICO BUZON FARRERA ACTIVO (PUERTO 443)');
  console.log('====================================================');
  while (true) {
    try {
      const rows = await supaRequest(
        'GET',
        `/rest/v1/taller_citas?fecha_cita=eq.${RELAY_DATE}&estado=eq.PENDING&select=id,folio,datos_recepcion&order=id.asc&limit=10`,
        null,
        {},
        5000
      );
      if (Array.isArray(rows) && rows.length > 0) {
        // Disparar en paralelo sin bloquear el ciclo de polling
        for (const r of rows) {
          processRow(r).catch(() => {});
        }
      }
    } catch (err) {
      // Ignorar errores transitorios de red
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

pollLoop();
