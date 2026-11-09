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

function supaRequest(method, path, bodyObj = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = bodyObj ? JSON.stringify(bodyObj) : '';
    const headers = {
      apikey: DO_SUPABASE_KEY,
      Authorization: `Bearer ${DO_SUPABASE_KEY}`,
      'Content-Type': 'application/json'
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

function forwardToAutotec(reqData) {
  return new Promise((resolve, reject) => {
    const bodyBuf = reqData.bodyB64 ? Buffer.from(reqData.bodyB64, 'base64') : Buffer.alloc(0);
    const outHeaders = { ...(reqData.headers || {}) };
    outHeaders['Host'] = 'autotec.farrera.net:60002';
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
    const reqData = row.datos_recepcion || {};
    console.log(`[${new Date().toISOString()}] -> ${reqData.method || 'GET'} ${reqData.path || '/buzonfecg.aspx'}`);
    const resObj = await forwardToAutotec(reqData);
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
