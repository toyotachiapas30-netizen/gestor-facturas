#!/usr/bin/env node
/**
 * Agente Local Automático 24/7 (Puerto 443 HTTPS Relay)
 * Conecta https://control.pagos.toyoter.com/buzonfecg.aspx con https://autotec.farrera.net:60002/buzonfecg.aspx
 * sin necesidad de abrir puertos ni instalar túneles bloqueados por Fortinet.
 */

const https = require('https');

const DO_SUPABASE_URL = 'https://ihwucfdwjnguwjxncwdw.supabase.co';
const DO_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlod3VjZmR3am5ndXdqeG5jd2R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NzY4MzQsImV4cCI6MjA5NTA1MjgzNH0.A2ND8DKBDGQ6ymhUDs_x6qZtcStoUDyk_0akG2hVD7Q';
const RELAY_DATE = '2099-12-30';

const supaAgent = new https.Agent({ keepAlive: true, maxSockets: 10 });
const autotecAgent = new https.Agent({ keepAlive: true, rejectUnauthorized: false, maxSockets: 10 });

const inFlight = new Set();
const lastXmlValidationBySession = new Map();
let lastXmlValidationGlobal = null;

function getSessionKey(headers = {}) {
  const cookie = headers['cookie'] || headers['Cookie'] || '';
  const m = cookie.match(/ASP\.NET_SessionId=([^;\s]+)/i);
  return m ? m[1] : '__default__';
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

function supaRequest(method, path, bodyObj = null, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const headers = {
      apikey: DO_SUPABASE_KEY,
      Authorization: `Bearer ${DO_SUPABASE_KEY}`,
      'Content-Type': 'application/json',
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
        timeout: 8000
      },
      res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode >= 400) {
            return reject(new Error(`HTTP ${res.statusCode}: ${raw}`));
          }
          try {
            resolve(raw ? JSON.parse(raw) : null);
          } catch (e) {
            resolve(raw);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Supabase timeout')));
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function forwardToAutotec(reqData, overrideBodyBuf = null) {
  return new Promise((resolve, reject) => {
    const bodyBuf = overrideBodyBuf || (reqData.bodyB64 ? Buffer.from(reqData.bodyB64, 'base64') : Buffer.alloc(0));
    const outHeaders = { ...(reqData.headers || {}) };
    outHeaders['Host'] = 'autotec.farrera.net:60002';
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
        timeout: 18000
      },
      res => {
        const chunks = [];
        res.on('data', d => chunks.push(d));
        res.on('end', () => {
          const resBuf = Buffer.concat(chunks);
          resolve({
            statusCode: res.statusCode || 200,
            contentType: res.headers['content-type'] || 'text/html; charset=utf-8',
            setCookie: res.headers['set-cookie'] || [],
            bodyB64: resBuf.toString('base64')
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Timeout conectando a autotec.farrera.net:60002')));
    if (bodyBuf.length > 0) {
      req.write(bodyBuf);
    }
    req.end();
  });
}

async function processRow(row) {
  if (!row || !row.id || inFlight.has(row.id)) return;
  inFlight.add(row.id);
  try {
    // Reclamo atómico para evitar doble envío si hay más de un agente activo
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

    const resObj = await forwardToAutotec(reqData, overrideBodyBuf);
    await supaRequest('PATCH', `/rest/v1/taller_citas?id=eq.${row.id}`, {
      estado: 'DONE',
      datos_recepcion: {
        ...reqData,
        res: resObj
      }
    });
    console.log(`[${new Date().toISOString()}] <- HTTP ${resObj.statusCode} (${Buffer.from(resObj.bodyB64, 'base64').length} bytes)`);
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
        `/rest/v1/taller_citas?fecha_cita=eq.${RELAY_DATE}&estado=eq.PENDING&select=id,folio,datos_recepcion&order=id.asc&limit=10`
      );
      if (Array.isArray(rows) && rows.length > 0) {
        await Promise.all(rows.map(r => processRow(r)));
      }
    } catch (err) {
      // Ignorar errores transitorios de red
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

pollLoop();
