const crypto = require('crypto');
const axios = require('axios');

const DO_SUPABASE_URL = 'https://ihwucfdwjnguwjxncwdw.supabase.co';
const DO_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlod3VjZmR3am5ndXdqeG5jd2R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NzY4MzQsImV4cCI6MjA5NTA1MjgzNH0.A2ND8DKBDGQ6ymhUDs_x6qZtcStoUDyk_0akG2hVD7Q';
const RELAY_DATE = '2099-12-30';

const supaHeaders = {
  apikey: DO_SUPABASE_KEY,
  Authorization: `Bearer ${DO_SUPABASE_KEY}`,
  'Content-Type': 'application/json'
};

// Caché en memoria para recursos estáticos de ASP.NET (JS, CSS, imágenes)
const staticCache = new Map();

function isStaticAsset(req) {
  if (req.method !== 'GET') return false;
  const u = req.originalUrl || req.url || '';
  return (
    u.startsWith('/ScriptResource.axd') ||
    u.startsWith('/WebResource.axd') ||
    u.startsWith('/jsUpdateProgress.js') ||
    u.startsWith('/App_Themes/') ||
    u.startsWith('/Scripts/') ||
    u.includes('_TSM_CombinedScripts_')
  );
}

async function getBridgeConfig() {
  return { mode: 'supabase-https-relay', active: true };
}

async function saveBridgeConfig(config) {
  return config;
}

async function relayViaSupabase(req, bodyBuffer, timeoutMs = 25000) {
  const urlPath = req.originalUrl || req.url || '/buzonfecg.aspx';

  if (isStaticAsset(req) && staticCache.has(urlPath)) {
    return staticCache.get(urlPath);
  }

  const reqId = crypto.randomBytes(8).toString('hex');
  const folio = `__BUZON_REQ_${reqId}__`;

  const cleanHeaders = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    const lower = k.toLowerCase();
    if (
      [
        'host',
        'connection',
        'content-length',
        'accept-encoding',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'x-vercel-id',
        'x-vercel-deployment-url',
        'x-vercel-forwarded-for'
      ].includes(lower)
    ) {
      continue;
    }
    cleanHeaders[k] = v;
  }

  // 1. Insertar petición en cola HTTPS (puerto 443)
  const insertRes = await axios.post(
    `${DO_SUPABASE_URL}/rest/v1/taller_citas`,
    {
      folio,
      fecha_cita: RELAY_DATE,
      estado: 'PENDING',
      datos_recepcion: {
        reqId,
        method: req.method,
        path: urlPath,
        headers: cleanHeaders,
        bodyB64: bodyBuffer && bodyBuffer.length > 0 ? bodyBuffer.toString('base64') : ''
      }
    },
    { headers: { ...supaHeaders, Prefer: 'return=representation' }, timeout: 8000 }
  );

  const rowId = Array.isArray(insertRes.data) && insertRes.data[0] ? insertRes.data[0].id : null;
  const start = Date.now();

  try {
    // 2. Esperar respuesta del agente local (Mac / Windows)
    while (Date.now() - start < timeoutMs) {
      await new Promise(r => setTimeout(r, 250));
      const pollRes = await axios.get(
        `${DO_SUPABASE_URL}/rest/v1/taller_citas?folio=eq.${encodeURIComponent(folio)}&select=estado,datos_recepcion`,
        { headers: supaHeaders, timeout: 6000 }
      );
      const row = Array.isArray(pollRes.data) ? pollRes.data[0] : null;
      if (row && row.estado === 'DONE' && row.datos_recepcion && row.datos_recepcion.res) {
        const resObj = row.datos_recepcion.res;
        if (isStaticAsset(req) && resObj.statusCode === 200) {
          staticCache.set(urlPath, resObj);
        }
        return resObj;
      }
      if (row && row.estado === 'ERROR') {
        throw new Error(row.datos_recepcion?.error || 'Error en agente local hacia autotec.farrera.net');
      }
    }
    throw new Error('Tiempo de espera agotado esperando respuesta del puente local.');
  } finally {
    // 3. Limpiar fila temporal
    if (rowId) {
      axios.delete(`${DO_SUPABASE_URL}/rest/v1/taller_citas?id=eq.${rowId}`, { headers: supaHeaders }).catch(() => {});
    } else {
      axios.delete(`${DO_SUPABASE_URL}/rest/v1/taller_citas?folio=eq.${encodeURIComponent(folio)}`, { headers: supaHeaders }).catch(() => {});
    }
  }
}

async function handleBuzonProxy(req, res) {
  try {
    let bodyBuffer = Buffer.alloc(0);
    if (Buffer.isBuffer(req.body)) {
      bodyBuffer = req.body;
    } else if (typeof req.body === 'string') {
      bodyBuffer = Buffer.from(req.body);
    } else {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      bodyBuffer = Buffer.concat(chunks);
    }

    const result = await relayViaSupabase(req, bodyBuffer, 25000);

    if (result.setCookie && Array.isArray(result.setCookie) && result.setCookie.length > 0) {
      const cleanedCookies = result.setCookie.map(c =>
        c.replace(/;\s*domain=[^;]+/gi, '').replace(/;\s*secure/gi, '')
      );
      res.setHeader('Set-Cookie', cleanedCookies);
    }

    const contentType = result.contentType || 'text/html; charset=utf-8';
    res.setHeader('Content-Type', contentType);
    if (isStaticAsset(req)) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    }

    const resBuffer = Buffer.from(result.bodyB64 || '', 'base64');

    if (contentType.includes('text/html')) {
      let html = resBuffer.toString('utf8');
      html = html.replace(/http:\/\/ajax\.googleapis\.com/g, 'https://ajax.googleapis.com');
      return res.status(result.statusCode || 200).send(html);
    }

    return res.status(result.statusCode || 200).send(resBuffer);
  } catch (err) {
    return res.status(502).send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>Puente Buzón Farrera</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:24px;">
  <h2>⚠️ Reintentando conexión con Buzón Grupo Farrera...</h2>
  <p>Detalle: ${err.message}</p>
  <button onclick="location.reload()" style="padding:10px 18px;background:#dc2626;color:#fff;border:none;border-radius:8px;cursor:pointer;">🔄 Recargar Página</button>
</body></html>`);
  }
}

module.exports = {
  getBridgeConfig,
  saveBridgeConfig,
  handleBuzonProxy
};
