const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const router = express.Router();

const { createClient } = require('@supabase/supabase-js');

let _db = null;
let _supabase = null;

function getDB() {
  // 1. Prefer Supabase if credentials exist (Cloud Mode)
  if (process.env.SUPABASE_URL && process.env.SUPABASE_KEY) {
    if (!_supabase) {
      _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
      console.log('🌐 [DB] Usando Supabase (Cloud)');
    }
    return { type: 'supabase', client: _supabase };
  }

  // 2. Fallback to SQLite (Local Mode)
  if (_db) return { type: 'sqlite', client: _db };
  
  const Database = require('better-sqlite3');
  const DATA_DIR = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  
  _db = new Database(path.join(DATA_DIR, 'gastos.db'));
  _db.pragma('journal_mode = WAL');

  // Create table if not exists
  _db.exec(`
    CREATE TABLE IF NOT EXISTS gastos (
      id TEXT PRIMARY KEY,
      uuid TEXT,
      proveedor TEXT NOT NULL,
      folio TEXT,
      fecha_factura TEXT,
      monto REAL,
      concepto TEXT,
      fecha_solicitud TEXT,
      estatus TEXT DEFAULT 'en_proceso',
      categoria TEXT,
      mes TEXT,
      sheet_url TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // Migration for existing databases
  try {
    _db.exec(`ALTER TABLE gastos ADD COLUMN sheet_url TEXT`);
    console.log('✅ [DB] Migración: Columna sheet_url añadida.');
  } catch (err) {
    // Column already exists or other error
  }
  
  return { type: 'sqlite', client: _db };
}


// ── Categories ────────────────────────────────────────────
const CATEGORIAS = [
  'NORMATIVAS',
  'MANTENIMIENTO DE PLANTA',
  'RECOLECCIÓN DE BASURA, DESASOLVE Y RP',
  'PROGRAMAS AVANZADOS TOYOTA',
  'ASESORÍAS (AMBIENTAL, ADACH, ETC)',
  'GESTORÍAS (CFE, PROGRAMA INTERNO, PAGO A GOBIERNO)',
  'PAGO ANUAL TOTEM',
  'ADECUACIONES A SOLICITADO POR VRI',
  'MANTENIMIENTOS Y REPARACIÓN EN GENERAL',
  'ACTIVO FIJO',
  'GPS UNIDAD MOVIL Y UTILITARIA',
  'FUMIGACIÓN',
  'FORO KAIZEN',
  'TOYOTA PONIENTE',
  'GASTO MENSUAL VIDEO WALL',
  'SISTEMA DE MONITOREO ANTIROBO',
  'VISITAS COMERCIALES',
  'OTROS'
];

// ── GET /api/gastos/categorias ────────────────────────────
router.get('/categorias', (req, res) => {
  res.json({ ok: true, categorias: CATEGORIAS });
});

// ── GET /api/gastos/check/:uuid ───────────────────────────
router.get('/check/:uuid', async (req, res) => {
  try {
    const uuidParam = req.params.uuid;
    const db = getDB();

    if (db.type === 'supabase') {
      const { data, error } = await db.client.from('gastos').select('id').eq('uuid', uuidParam).maybeSingle();
      if (error) throw error;
      return res.json({ ok: true, exists: !!data });
    } else {
      const row = db.client.prepare('SELECT id FROM gastos WHERE uuid = ?').get(uuidParam);
      return res.json({ ok: true, exists: !!row });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/gastos  →  List expenses ──
router.get('/', async (req, res) => {
  const { mes, categoria, estatus, desde, hasta } = req.query;
  const db = getDB();

  try {
    if (db.type === 'supabase') {
      let query = db.client.from('gastos').select('*');
      if (mes) query = query.eq('mes', mes);
      if (estatus) query = query.eq('estatus', estatus);
      if (desde) query = query.gte('fecha_factura', desde);
      if (hasta) query = query.lte('fecha_factura', hasta);
      
      if (categoria) {
        const catArray = categoria.split(',').filter(Boolean);
        if (catArray.length > 0) query = query.in('categoria', catArray);
      }
      
      const { data: rows, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;

      const total = rows.reduce((sum, r) => sum + (r.monto || 0), 0);
      const enProceso = rows.filter(r => r.estatus === 'en_proceso').length;
      const pagados = rows.filter(r => r.estatus === 'pagado').length;
      return res.json({ ok: true, gastos: rows, resumen: { total, enProceso, pagados, count: rows.length } });
    } else {
      let sql = 'SELECT * FROM gastos WHERE 1=1';
      const params = [];
      if (mes) { sql += ' AND mes = ?'; params.push(mes); }
      if (estatus) { sql += ' AND estatus = ?'; params.push(estatus); }
      if (desde) { sql += ' AND fecha_factura >= ?'; params.push(desde); }
      if (hasta) { sql += ' AND fecha_factura <= ?'; params.push(hasta); }
      
      if (categoria) {
        const catArray = categoria.split(',').filter(Boolean);
        if (catArray.length > 0) {
          sql += ` AND categoria IN (${catArray.map(() => '?').join(',')})`;
          params.push(...catArray);
        }
      }
      
      sql += ' ORDER BY created_at DESC';

      const rows = db.client.prepare(sql).all(...params);
      const total = rows.reduce((sum, r) => sum + (r.monto || 0), 0);
      const enProceso = rows.filter(r => r.estatus === 'en_proceso').length;
      const pagados = rows.filter(r => r.estatus === 'pagado').length;
      return res.json({ ok: true, gastos: rows, resumen: { total, enProceso, pagados, count: rows.length } });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/gastos/meses ────────────────────────────
router.get('/meses', async (req, res) => {
  try {
    const db = getDB();
    if (db.type === 'supabase') {
      const { data, error } = await db.client.from('gastos').select('mes').order('mes', { ascending: false });
      if (error) throw error;
      const meses = Array.from(new Set(data.map(r => r.mes).filter(Boolean)));
      return res.json({ ok: true, meses });
    } else {
      const rows = db.client.prepare('SELECT DISTINCT mes FROM gastos ORDER BY mes DESC').all();
      return res.json({ ok: true, meses: rows.map(r => r.mes) });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/gastos  →  Create expense ────────────────────
router.post('/', async (req, res) => {
  const { uuid, proveedor, folio, fechaFactura, monto, concepto, fechaSolicitud, estatus, categoria } = req.body;
  if (!proveedor || !folio) return res.status(400).json({ ok: false, error: 'Proveedor y folio son requeridos.' });

  const mes = fechaFactura ? fechaFactura.substring(0, 7) : new Date().toISOString().substring(0, 7);
  const db = getDB();

  try {
    if (db.type === 'supabase') {
      const { data, error } = await db.client.from('gastos').insert([{
        uuid, proveedor, folio, fecha_factura: fechaFactura, monto, concepto, fecha_solicitud: fechaSolicitud, estatus, categoria, mes, sheet_url: req.body.sheet_url
      }]).select().single();
      if (error) throw error;
      return res.json({ ok: true, gasto: data });
    } else {
      const id = uuidv4();
      db.client.prepare(`
        INSERT INTO gastos (id, uuid, proveedor, folio, fecha_factura, monto, concepto, fecha_solicitud, estatus, categoria, mes, sheet_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, uuid || '', proveedor, folio || '', fechaFactura || '', monto || 0, concepto || '', fechaSolicitud || '', estatus || 'en_proceso', categoria || 'OTROS', mes, req.body.sheet_url || '');
      const row = db.client.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
      return res.json({ ok: true, gasto: row });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /api/gastos/:id  →  Update expense ──────────────────
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { proveedor, folio, fechaFactura, monto, concepto, fechaSolicitud, estatus, categoria } = req.body;
  const db = getDB();

  try {
    const mes = fechaFactura ? fechaFactura.substring(0, 7) : undefined;

    if (db.type === 'supabase') {
      const updates = { proveedor, folio, fecha_factura: fechaFactura, monto, concepto, fecha_solicitud: fechaSolicitud, estatus, categoria };
      if (mes) updates.mes = mes;
      
      const { data, error } = await db.client.from('gastos').update(updates).eq('id', id).select().single();
      if (error) throw error;
      return res.json({ ok: true, gasto: data });
    } else {
      const existing = db.client.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
      if (!existing) return res.status(404).json({ ok: false, error: 'Gasto no encontrado.' });
      
      db.client.prepare(`
        UPDATE gastos SET
          proveedor = ?, folio = ?, fecha_factura = ?, monto = ?,
          concepto = ?, fecha_solicitud = ?, estatus = ?, categoria = ?, mes = ?, sheet_url = ?
        WHERE id = ?
      `).run(
        proveedor || existing.proveedor, folio || existing.folio, fechaFactura || existing.fecha_factura,
        monto !== undefined ? monto : existing.monto, concepto || existing.concepto,
        fechaSolicitud || existing.fecha_solicitud, estatus || existing.estatus,
        categoria || existing.categoria, mes || existing.mes, 
        req.body.sheet_url !== undefined ? req.body.sheet_url : existing.sheet_url,
        id
      );
      const row = db.client.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
      return res.json({ ok: true, gasto: row });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PATCH /api/gastos/:id/estatus ────────────────
router.patch('/:id/estatus', async (req, res) => {
  const { id } = req.params;
  const { estatus } = req.body;
  const db = getDB();

  try {
    if (db.type === 'supabase') {
      const { data, error } = await db.client.from('gastos').update({ estatus }).eq('id', id).select().single();
      if (error) throw error;
      return res.json({ ok: true, gasto: data });
    } else {
      db.client.prepare('UPDATE gastos SET estatus = ? WHERE id = ?').run(estatus, id);
      const row = db.client.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
      return res.json({ ok: true, gasto: row });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/gastos/:id ────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const db = getDB();
  try {
    if (db.type === 'supabase') {
      const { error } = await db.client.from('gastos').delete().eq('id', id);
      if (error) throw error;
    } else {
      db.client.prepare('DELETE FROM gastos WHERE id = ?').run(id);
    }
    return res.json({ ok: true, mensaje: 'Gasto eliminado.' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/gastos/stats  →  Data for Charts ──────────────
router.get('/stats', async (req, res) => {
  try {
    const db = getDB();
    const rango = req.query.rango || 'todo';
    const mesFiltro = req.query.mes || '';
    const desde = req.query.desde || '';
    const hasta = req.query.hasta || '';
    const categoria = req.query.categoria || '';
    
    if (db.type === 'supabase') {
      const now = new Date();
      let query = db.client.from('gastos').select('monto, categoria, mes, fecha_factura');
      
      if (desde) query = query.gte('fecha_factura', desde);
      if (hasta) query = query.lte('fecha_factura', hasta);

      if (categoria) {
        const catArray = categoria.split(',').filter(Boolean);
        if (catArray.length > 0) query = query.in('categoria', catArray);
      }

      if (mesFiltro) {
        query = query.eq('mes', mesFiltro);
      } else if (!desde && !hasta) {
        if (rango === 'mes') {
          query = query.eq('mes', now.toISOString().substring(0, 7));
        } else if (rango === 'trimestre') {
          const d = new Date(); d.setMonth(d.getMonth() - 2);
          query = query.gte('mes', d.toISOString().substring(0, 7));
        } else if (rango === 'anual') {
          query = query.gte('mes', now.getFullYear() + '-01');
        }
      }

      const { data: rows, error } = await query;
      if (error) throw error;

      const monthlyObj = {};
      const byCategoryObj = {};
      
      rows.forEach(r => {
        const label = (mesFiltro || desde || hasta || rango === 'mes') ? r.fecha_factura : r.mes;
        monthlyObj[label] = (monthlyObj[label] || 0) + (r.monto || 0);
        byCategoryObj[r.categoria] = (byCategoryObj[r.categoria] || 0) + (r.monto || 0);
      });

      const monthly = Object.entries(monthlyObj).map(([label, total]) => ({ label, total })).sort((a,b) => a.label.localeCompare(b.label));
      const byCategory = Object.entries(byCategoryObj).map(([categoria, total]) => ({ categoria, total })).sort((a,b) => b.total - a.total);

      return res.json({ ok: true, stats: { monthly, byCategory, yearly: [] } });
    } else {
      const sqlite = db.client;
      let dateFilter = 'WHERE 1=1';
      let timeGroup = 'mes';
      let limit = 12;

      const now = new Date();

      if (desde) dateFilter += ` AND fecha_factura >= '${desde}'`;
      if (hasta) dateFilter += ` AND fecha_factura <= '${hasta}'`;

      if (categoria) {
        const catArray = categoria.split(',').filter(Boolean);
        if (catArray.length > 0) {
          dateFilter += ` AND categoria IN (${catArray.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})`;
        }
      }

      if (mesFiltro) {
        dateFilter += ` AND mes = '${mesFiltro}'`;
        timeGroup = 'fecha_factura';
        limit = 31;
      } else if (desde || hasta) {
        timeGroup = 'fecha_factura';
        limit = 100;
      } else if (rango === 'mes') {
        dateFilter += ` AND mes = '${now.toISOString().substring(0, 7)}'`;
        timeGroup = 'fecha_factura';
        limit = 31;
      } else if (rango === 'trimestre') {
        now.setMonth(now.getMonth() - 2);
        dateFilter += ` AND mes >= '${now.toISOString().substring(0, 7)}'`;
        limit = 3;
      } else if (rango === 'anual') {
        dateFilter += ` AND SUBSTR(mes, 1, 4) = '${now.getFullYear()}'`;
      }

      const timeQuery = `SELECT ${timeGroup} as label, SUM(monto) as total FROM gastos ${dateFilter} GROUP BY label ORDER BY label DESC LIMIT ${limit}`;
      const monthly = sqlite.prepare(timeQuery).all().reverse();

      const byCategory = sqlite.prepare(`SELECT categoria, SUM(monto) as total FROM gastos ${dateFilter} GROUP BY categoria ORDER BY total DESC`).all();

      return res.json({ ok: true, stats: { monthly, byCategory, yearly: [] } });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

module.exports = router;
