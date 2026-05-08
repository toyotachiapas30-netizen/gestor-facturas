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

// ══════════════════════════════════════════════════════════════
// GET /api/takata/state
// Devuelve todo el estado persistido en la nube de una sola vez
// ══════════════════════════════════════════════════════════════
router.get('/state', async (req, res) => {
  try {
    const [
      { data: edits,   error: e1 },
      { data: proceso, error: e2 },
      { data: custom,  error: e3 },
      { data: camp,    error: e4 },
    ] = await Promise.all([
      sb().from('takata_edits').select('*'),
      sb().from('takata_proceso_edits').select('*'),
      sb().from('takata_custom_vins').select('*'),
      sb().from('takata_camp_edits').select('*'),
    ]);

    if (e1 || e2 || e3 || e4) throw e1 || e2 || e3 || e4;

    // Convertir arreglos a objetos indexados por VIN/id para el frontend
    const editsMap   = Object.fromEntries((edits   || []).map(r => [r.vin, r]));
    const procesoMap = Object.fromEntries((proceso || []).map(r => [r.vin, r]));
    const campMap    = Object.fromEntries((camp    || []).map(r => [r.id, r.valor]));

    res.json({
      edits:      editsMap,
      proceso:    procesoMap,
      customVins: custom || [],
      camp:       campMap,
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
