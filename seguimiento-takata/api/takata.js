'use strict';

const TAKATA_SESSION_TOKEN  = 'takata_2026_toyota_secure_session';
const TAKATA_READONLY_TOKEN = 'takata_readonly_session_token';

function getTakataToken(req) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('takata_session='));
  return found ? decodeURIComponent(found.split('=')[1]) : null;
}

async function sbSelect(table) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  const r = await fetch(`${url}/rest/v1/${table}?select=*`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function sbUpsert(table, conflictCol, payload) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  const r = await fetch(`${url}/rest/v1/${table}?on_conflict=${conflictCol}`, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates'
    },
    body: JSON.stringify(payload)
  });
  if (!r.ok) throw new Error(await r.text());
}

async function sbDelete(table, col, val) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_KEY;
  const r = await fetch(`${url}/rest/v1/${table}?${col}=eq.${encodeURIComponent(val)}`, {
    method: 'DELETE',
    headers: { apikey: key, Authorization: `Bearer ${key}` }
  });
  if (!r.ok) throw new Error(await r.text());
}

module.exports = async (req, res) => {
  try {
    const rawPath = req.query?.path
      ? (Array.isArray(req.query.path) ? req.query.path.join('/') : String(req.query.path))
      : req.url.replace(/^\/api\/takata\/?/, '').replace(/^\/takata\/?/, '').split('?')[0];

    // 1. Login
    if (rawPath === 'login' && req.method === 'POST') {
      const { usuario, clave } = req.body || {};
      if (usuario === 'takata' && clave === 'toyota2026') {
        res.setHeader('Set-Cookie', [
          `takata_session=${TAKATA_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          `takata_role=admin; Path=/; SameSite=Lax; Max-Age=604800`
        ]);
        return res.status(200).json({ ok: true, role: 'admin' });
      }
      if (usuario === 'visor' && clave === 'toyota2026') {
        res.setHeader('Set-Cookie', [
          `takata_session=${TAKATA_READONLY_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          `takata_role=readonly; Path=/; SameSite=Lax; Max-Age=604800`
        ]);
        return res.status(200).json({ ok: true, role: 'readonly' });
      }
      return res.status(401).json({ error: 'Credenciales inválidas' });
    }

    // 2. Autenticación
    const token = getTakataToken(req);
    if (!token || (token !== TAKATA_SESSION_TOKEN && token !== TAKATA_READONLY_TOKEN)) {
      return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
    }
    if (token === TAKATA_READONLY_TOKEN && req.method !== 'GET') {
      return res.status(403).json({ error: 'Usuario de solo lectura. No tienes permisos para modificar.' });
    }

    // 3. GET /state
    if (rawPath === 'state' && req.method === 'GET') {
      const [edits, proceso, custom, camp] = await Promise.all([
        sbSelect('takata_edits'),
        sbSelect('takata_proceso_edits'),
        sbSelect('takata_custom_vins'),
        sbSelect('takata_camp_edits'),
      ]);
      const editsMap   = Object.fromEntries((edits   || []).map(r => [r.vin, r]));
      const procesoMap = Object.fromEntries((proceso || []).map(r => [r.vin, r]));
      const campMap    = Object.fromEntries((camp    || []).map(r => [r.id, r.valor]));

      return res.status(200).json({
        edits:      editsMap,
        proceso:    procesoMap,
        customVins: custom || [],
        camp:       campMap,
      });
    }

    // 4. POST /edit
    if (rawPath === 'edit' && req.method === 'POST') {
      const { vin, contactado, cita, observacion } = req.body || {};
      if (!vin) return res.status(400).json({ error: 'vin requerido' });
      await sbUpsert('takata_edits', 'vin', {
        vin,
        contactado:  contactado  ?? 'NO CONTACTADO',
        cita:        cita        ?? '',
        observacion: observacion ?? '',
        updated_at:  new Date().toISOString(),
      });
      return res.status(200).json({ ok: true });
    }

    // 5. POST /proceso
    if (rawPath === 'proceso' && req.method === 'POST') {
      const { vin, ...fields } = req.body || {};
      if (!vin) return res.status(400).json({ error: 'vin requerido' });
      delete fields.dealer;
      delete fields.distribuidor;
      delete fields.contactado;
      delete fields.proc_color;
      await sbUpsert('takata_proceso_edits', 'vin', {
        vin,
        ...fields,
        updated_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true });
    }

    // 6. DELETE /proceso/:vin
    if (rawPath.startsWith('proceso/') && req.method === 'DELETE') {
      const vin = decodeURIComponent(rawPath.slice('proceso/'.length));
      if (!vin) return res.status(400).json({ error: 'vin requerido' });
      await sbDelete('takata_proceso_edits', 'vin', vin);
      return res.status(200).json({ ok: true });
    }

    // 7. POST /custom-vin
    if (rawPath === 'custom-vin' && req.method === 'POST') {
      const { vin, ...fields } = req.body || {};
      if (!vin) return res.status(400).json({ error: 'vin requerido' });
      await sbUpsert('takata_custom_vins', 'vin', {
        vin,
        ...fields,
        updated_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true });
    }

    // 8. POST /camp
    if (rawPath === 'camp' && req.method === 'POST') {
      const { mes, dealer, camp, valor } = req.body || {};
      if (!mes || !dealer || !camp) return res.status(400).json({ error: 'mes, dealer y camp son requeridos' });
      const id = `${mes}|${dealer}|${camp}`;
      await sbUpsert('takata_camp_edits', 'id', {
        id, mes, dealer, camp,
        valor: parseInt(valor) || 0,
        updated_at: new Date().toISOString(),
      });
      return res.status(200).json({ ok: true });
    }

    return res.status(404).json({ error: 'Ruta no encontrada' });
  } catch (err) {
    console.error('[Takata Serverless Error]:', err);
    return res.status(500).json({ error: err.message });
  }
};
