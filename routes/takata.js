'use strict';
const express = require('express');
const router  = express.Router();
const { createClient } = require('@supabase/supabase-js');

// ── Conexión a Supabase (reutiliza las mismas credenciales del proyecto) ──
let _sb = null;
function sb() {
  if (!_sb) {
    _sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
  }
  return _sb;
}

const TAKATA_SESSION_TOKEN  = 'takata_2026_toyota_secure_session';
const TAKATA_READONLY_TOKEN = 'takata_readonly_session_token';

// Base de datos central de DO / admin.toyoter.com (Lista de Asociados y Permisos KPIs)
const DO_SUPABASE_URL = 'https://ihwucfdwjnguwjxncwdw.supabase.co';
const DO_SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlod3VjZmR3am5ndXdqeG5jd2R3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzk0NzY4MzQsImV4cCI6MjA5NTA1MjgzNH0.A2ND8DKBDGQ6ymhUDs_x6qZtcStoUDyk_0akG2hVD7Q';

function normalizeEmp(val) {
  return String(val || '').replace(/^EMP-/i, '').trim().toUpperCase();
}

function isGenericName(name) {
  if (!name) return true;
  const clean = String(name).trim();
  if (!clean) return true;
  return /^(asociado(\s+toyota)?|colaborador|empleado|usuario|sin\s+nombre)\b/i.test(clean);
}

async function resolveAssociateFromAdminToyoter(empInput) {
  const target = normalizeEmp(empInput);
  if (!target) return null;

  const url = `${DO_SUPABASE_URL}/rest/v1/taller_citas?folio=in.(__KPI_USERS_seguimiento-takata__,__DO_SYSTEM_USERS__,__DO_ASSOCIATES_DIRECTORY__)&fecha_cita=eq.2099-12-31&select=folio,datos_recepcion`;
  const r = await fetch(url, {
    headers: {
      apikey: DO_SUPABASE_KEY,
      Authorization: `Bearer ${DO_SUPABASE_KEY}`,
      'Cache-Control': 'no-cache'
    }
  });
  if (!r.ok) return null;
  const rows = await r.json();
  if (!Array.isArray(rows)) return null;

  const assocMap = new Map();
  const dirRow = rows.find(x => x.folio === '__DO_ASSOCIATES_DIRECTORY__');
  if (Array.isArray(dirRow?.datos_recepcion?.associates)) {
    for (const a of dirRow.datos_recepcion.associates) {
      const emp = normalizeEmp(a.numEmpleado || a.employeeNumber);
      const nombre = String(a.nombreCompleto || a.fullName || a.nombre || '').trim();
      if (emp && nombre && !isGenericName(nombre)) {
        assocMap.set(emp, { fullName: nombre, puesto: a.puesto || '', sucursal: a.sucursal || '' });
      }
    }
  }

  const authorizedMap = new Map();

  const sysRow = rows.find(x => x.folio === '__DO_SYSTEM_USERS__');
  if (Array.isArray(sysRow?.datos_recepcion?.users)) {
    for (const su of sysRow.datos_recepcion.users) {
      const emp = normalizeEmp(su.numEmpleado || su.username);
      if (!emp) continue;
      const perms = Array.isArray(su.permissions) ? su.permissions : [];
      const isAdmin = su.role === 'admin' || perms.includes('*');
      if (isAdmin || perms.includes('permisos-kpis')) {
        const dirInfo = assocMap.get(emp);
        authorizedMap.set(emp, {
          employeeNumber: emp,
          fullName: (dirInfo && dirInfo.fullName) || su.nombre || `Asociado #${emp}`,
          role: isAdmin ? 'admin' : 'staff',
          canUploadExcel: isAdmin,
          canEditTracking: true
        });
      }
    }
  }

  const kpiRow = rows.find(x => x.folio === '__KPI_USERS_seguimiento-takata__');
  if (Array.isArray(kpiRow?.datos_recepcion?.users)) {
    for (const u of kpiRow.datos_recepcion.users) {
      const emp = normalizeEmp(u.employeeNumber);
      if (!emp) continue;
      const dirInfo = assocMap.get(emp);
      const bestName = (dirInfo && dirInfo.fullName) || (!isGenericName(u.fullName) ? u.fullName : `Asociado #${emp}`);
      authorizedMap.set(emp, {
        employeeNumber: emp,
        fullName: bestName,
        role: u.role || 'staff',
        canUploadExcel: !!u.canUploadExcel,
        canEditTracking: u.canEditTracking !== undefined ? !!u.canEditTracking : true
      });
    }
  }

  return authorizedMap.get(target) || null;
}

// ══════════════════════════════════════════════════════════════
// POST /api/takata/login
// ══════════════════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  try {
    const { numEmpleado, usuario, clave } = req.body || {};
    const empCandidate = (numEmpleado || usuario || '').trim();

    if (empCandidate.toLowerCase() === 'takata' && clave === 'toyota2026') {
      const userObj = { employeeNumber: 'ADMIN', fullName: 'Administrador Takata', role: 'admin', canUploadExcel: true, canEditTracking: true };
      res.setHeader('Set-Cookie', [
        `takata_session=${TAKATA_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        `takata_role=admin; Path=/; SameSite=Lax; Max-Age=604800`
      ]);
      return res.json({ ok: true, role: 'admin', user: userObj });
    }
    if (empCandidate.toLowerCase() === 'visor' && clave === 'toyota2026') {
      const userObj = { employeeNumber: 'VISOR', fullName: 'Visor (Solo Lectura)', role: 'supervisor', canUploadExcel: false, canEditTracking: false };
      res.setHeader('Set-Cookie', [
        `takata_session=${TAKATA_READONLY_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        `takata_role=readonly; Path=/; SameSite=Lax; Max-Age=604800`
      ]);
      return res.json({ ok: true, role: 'readonly', user: userObj });
    }

    if (empCandidate) {
      const assocUser = await resolveAssociateFromAdminToyoter(empCandidate);
      if (assocUser) {
        const isReadOnlyUser = !assocUser.canEditTracking;
        const tokenToSet = isReadOnlyUser ? TAKATA_READONLY_TOKEN : TAKATA_SESSION_TOKEN;
        const roleToSet  = isReadOnlyUser ? 'readonly' : 'admin';
        res.setHeader('Set-Cookie', [
          `takata_session=${tokenToSet}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          `takata_role=${roleToSet}; Path=/; SameSite=Lax; Max-Age=604800`
        ]);
        return res.json({ ok: true, role: roleToSet, user: assocUser });
      }
    }

    return res.status(401).json({ error: 'Número de empleado sin acceso autorizado en admin.toyoter.com (KPIs | Seguimientos).' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/takata/logout
// ══════════════════════════════════════════════════════════════
router.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'takata_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'takata_role=; Path=/; SameSite=Lax; Max-Age=0'
  ]);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════
// GET /api/takata/state
// Devuelve todo el estado persistido en la nube de una sola vez
// ══════════════════════════════════════════════════════════════
router.get('/state', async (req, res) => {
  try {
    const empParam = req.query?.emp ? String(req.query.emp).trim() : '';
    const [
      { data: edits,   error: e1 },
      { data: proceso, error: e2 },
      { data: custom,  error: e3 },
      { data: camp,    error: e4 },
      liveUser
    ] = await Promise.all([
      sb().from('takata_edits').select('*'),
      sb().from('takata_proceso_edits').select('*'),
      sb().from('takata_custom_vins').select('*'),
      sb().from('takata_camp_edits').select('*'),
      (empParam && empParam !== 'ADMIN' && empParam !== 'VISOR')
        ? resolveAssociateFromAdminToyoter(empParam).catch(() => undefined)
        : Promise.resolve(undefined)
    ]);

    if (e1 || e2 || e3 || e4) throw e1 || e2 || e3 || e4;

    if (empParam && empParam !== 'ADMIN' && empParam !== 'VISOR' && liveUser === null) {
      res.setHeader('Set-Cookie', [
        'takata_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
        'takata_role=; Path=/; SameSite=Lax; Max-Age=0'
      ]);
      return res.status(401).json({ error: 'Acceso revocado desde admin.toyoter.com', revoked: true });
    }

    const editsMap   = Object.fromEntries((edits   || []).map(r => [r.vin, r]));
    const procesoMap = Object.fromEntries((proceso || []).map(r => [r.vin, r]));
    const campMap    = Object.fromEntries((camp    || []).map(r => [r.id, r.valor]));

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      edits:       editsMap,
      proceso:     procesoMap,
      customVins:  custom || [],
      camp:        campMap,
      currentUser: liveUser || undefined,
      serverTime:  new Date().toISOString()
    });
  } catch (err) {
    console.error('[Takata] Error GET /state:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/takata/edit
// Actualiza un VIN en la base matriz (contacto, cita, observacion)
// ══════════════════════════════════════════════════════════════
router.post('/edit', async (req, res) => {
  try {
    const { vin, contactado, cita, observacion } = req.body;
    if (!vin) return res.status(400).json({ error: 'vin requerido' });

    const { error } = await sb().from('takata_edits').upsert({
      vin,
      contactado: contactado ?? 'NO CONTACTADO',
      cita:       cita       ?? '',
      observacion: observacion ?? '',
      updated_at: new Date().toISOString(),
    }, { onConflict: 'vin' });

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[Takata] Error POST /edit:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/takata/proceso
// Actualiza (o inserta) un VIN en la tabla de proceso
// ══════════════════════════════════════════════════════════════
router.post('/proceso', async (req, res) => {
  try {
    const { vin, ...fields } = req.body;
    if (!vin) return res.status(400).json({ error: 'vin requerido' });

    delete fields.dealer;
    delete fields.distribuidor;
    delete fields.contactado;
    delete fields.proc_color;

    const { error } = await sb().from('takata_proceso_edits').upsert({
      vin,
      ...fields,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'vin' });

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[Takata] Error POST /proceso:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// DELETE /api/takata/proceso/:vin
// Elimina un VIN de la tabla de proceso
// ══════════════════════════════════════════════════════════════
router.delete('/proceso/:vin', async (req, res) => {
  try {
    const { vin } = req.params;
    if (!vin) return res.status(400).json({ error: 'vin requerido' });

    const { error } = await sb().from('takata_proceso_edits').delete().eq('vin', vin);

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[Takata] Error DELETE /proceso:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/takata/custom-vin
// Agrega o actualiza un VIN nuevo creado manualmente
// ══════════════════════════════════════════════════════════════
router.post('/custom-vin', async (req, res) => {
  try {
    const { vin, ...fields } = req.body;
    if (!vin) return res.status(400).json({ error: 'vin requerido' });

    const { error } = await sb().from('takata_custom_vins').upsert({
      vin,
      ...fields,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'vin' });

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[Takata] Error POST /custom-vin:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════════════════════
// POST /api/takata/camp
// Actualiza un valor de la tabla de reclamos por campaña
// ══════════════════════════════════════════════════════════════
router.post('/camp', async (req, res) => {
  try {
    const { mes, dealer, camp, valor } = req.body;
    if (!mes || !dealer || !camp) return res.status(400).json({ error: 'mes, dealer y camp son requeridos' });

    const id = `${mes}|${dealer}|${camp}`;
    const { error } = await sb().from('takata_camp_edits').upsert({
      id, mes, dealer, camp,
      valor: parseInt(valor) || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    console.error('[Takata] Error POST /camp:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
