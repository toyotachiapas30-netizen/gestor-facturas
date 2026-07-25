const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });
const { getAuthorizedClient, getGoogle } = require('./drive');

function getGestorRole(req) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('gestor_role='));
  return found ? decodeURIComponent(found.split('=')[1]) : 'admin';
}

function authorizeGasto(req, gasto) {
  if (!gasto) return false;
  const role = getGestorRole(req);
  if (role === 'admin') return true;
  
  const rawSuc = gasto.sucursal || (gasto.categoria === 'TOYOTA PONIENTE' ? 'Toyota Farrera Poniente' : 'Toyota Chiapas');
  const isPoniente = rawSuc.includes('Poniente');
  
  if (role === 'poniente') return isPoniente;
  if (role === 'oriente') return !isPoniente;
  return false;
}

let _db = null;

function getDB() {
  if (_db) return _db;
  
  const Database = require('better-sqlite3');
  const DATA_DIR = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  
  _db = new Database(path.join(DATA_DIR, 'gastos.db'));
  _db.pragma('journal_mode = WAL');

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
      comprobante_pago_url TEXT,
      sucursal TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    )
  `);

  // Migraciones
  try { _db.exec(`ALTER TABLE gastos ADD COLUMN sheet_url TEXT`); } catch (err) {}
  try { _db.exec(`ALTER TABLE gastos ADD COLUMN comprobante_pago_url TEXT`); } catch (err) {}
  try { _db.exec(`ALTER TABLE gastos ADD COLUMN sucursal TEXT`); } catch (err) {}

  return _db;
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

// ── GET /api/gastos/proveedores ───────────────────────────
router.get('/proveedores', (req, res) => {
  try {
    const db = getDB();
    const rows = db.prepare("SELECT DISTINCT proveedor FROM gastos WHERE id != '00000000-0000-0000-0000-000000000000' ORDER BY proveedor ASC").all();
    res.json({ ok: true, proveedores: rows.map(r => r.proveedor) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/gastos/check/:uuid ───────────────────────────
router.get('/check/:uuid', (req, res) => {
  try {
    const db = getDB();
    const row = db.prepare('SELECT id FROM gastos WHERE uuid = ?').get(req.params.uuid);
    res.json({ ok: true, exists: !!row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/gastos  →  List expenses ──
router.get('/', (req, res) => {
  const { mes, anio, categoria, estatus, desde, hasta, proveedor, sucursal } = req.query;
  const db = getDB();

  try {
    let sql = "SELECT * FROM gastos WHERE id != '00000000-0000-0000-0000-000000000000'";
    const params = [];
    
    if (mes && anio) {
      sql += ' AND mes = ?';
      params.push(`${anio}-${mes}`);
    } else if (anio) {
      sql += ' AND mes LIKE ?';
      params.push(`${anio}-%`);
    } else if (mes) {
      sql += ' AND mes LIKE ?';
      params.push(`%-${mes}`);
    }
    
    if (estatus) { sql += ' AND estatus = ?'; params.push(estatus); }
    if (desde) { sql += ' AND fecha_factura >= ?'; params.push(desde); }
    if (hasta) { sql += ' AND fecha_factura <= ?'; params.push(hasta); }
    if (proveedor) { sql += ' AND proveedor LIKE ?'; params.push(`%${proveedor}%`); }
    
    if (categoria) {
      const catArray = categoria.split('|').filter(Boolean);
      if (catArray.length > 0) {
        sql += ` AND categoria IN (${catArray.map(() => '?').join(',')})`;
        params.push(...catArray);
      }
    }
    
    sql += ' ORDER BY created_at DESC';
    const rows = db.prepare(sql).all(...params);

    // Filtrado por sucursal según el rol de usuario
    const role = getGestorRole(req);
    let targetSucursal = sucursal;
    if (role === 'poniente') {
      targetSucursal = 'Toyota Farrera Poniente';
    } else if (role === 'oriente') {
      targetSucursal = 'Toyota Chiapas';
    }

    let finalRows = rows;
    if (targetSucursal) {
      finalRows = rows.filter(r => {
        const rSuc = r.sucursal || (r.categoria === 'TOYOTA PONIENTE' ? 'Toyota Farrera Poniente' : 'Toyota Chiapas');
        return rSuc === targetSucursal;
      });
    }

    const total = finalRows.reduce((sum, r) => sum + (r.monto || 0), 0);
    const enProceso = finalRows.filter(r => r.estatus === 'en_proceso').length;
    const pagados = finalRows.filter(r => r.estatus === 'pagado').length;
    
    res.json({ ok: true, gastos: finalRows, resumen: { total, enProceso, pagados, count: finalRows.length } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/gastos/meses ────────────────────────────
router.get('/meses', (req, res) => {
  try {
    const db = getDB();
    const rows = db.prepare("SELECT DISTINCT mes FROM gastos WHERE id != '00000000-0000-0000-0000-000000000000' ORDER BY mes DESC").all();
    res.json({ ok: true, meses: rows.map(r => r.mes) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/gastos  →  Create expense ────────────────────
router.post('/', async (req, res) => {
  const { uuid, proveedor, folio, fechaFactura, monto, concepto, fechaSolicitud, estatus, categoria, sheet_url, sucursal } = req.body;
  if (!proveedor || !folio) return res.status(400).json({ ok: false, error: 'Proveedor y folio son requeridos.' });

  const role = getGestorRole(req);
  let finalSucursal = sucursal;
  if (role === 'poniente') {
    finalSucursal = 'Toyota Farrera Poniente';
  } else if (role === 'oriente') {
    finalSucursal = 'Toyota Chiapas';
  }

  const mes = fechaFactura ? fechaFactura.substring(0, 7) : new Date().toISOString().substring(0, 7);
  const db = getDB();

  try {
    if (uuid && uuid.trim() !== '') {
      const existing = db.prepare('SELECT * FROM gastos WHERE uuid = ?').get(uuid.trim());
      if (existing) {
        db.prepare(`
          UPDATE gastos SET
            proveedor = ?, folio = ?, fecha_factura = ?, monto = ?,
            concepto = CASE WHEN ? != '' THEN ? ELSE concepto END,
            categoria = CASE WHEN ? != '' THEN ? ELSE categoria END,
            sheet_url = CASE WHEN ? != '' THEN ? ELSE sheet_url END,
            sucursal = CASE WHEN ? != '' THEN ? ELSE sucursal END
          WHERE id = ?
        `).run(
          proveedor, folio, fechaFactura, monto,
          concepto || '', concepto || '',
          categoria || '', categoria || '',
          sheet_url || '', sheet_url || '',
          finalSucursal || '', finalSucursal || '',
          existing.id
        );
        
        await backupDatabaseToDrive(); // Respaldo inmediato a Google Drive
        const row = db.prepare('SELECT * FROM gastos WHERE id = ?').get(existing.id);
        return res.json({ ok: true, gasto: row });
      }
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO gastos (id, uuid, proveedor, folio, fecha_factura, monto, concepto, fecha_solicitud, estatus, categoria, mes, sheet_url, sucursal)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, uuid || '', proveedor, folio || '', fechaFactura || '', monto || 0,
      concepto || '', fechaSolicitud || '', estatus || 'en_proceso', categoria || 'OTROS',
      mes, sheet_url || '', finalSucursal || ''
    );
    
    await backupDatabaseToDrive(); // Respaldo inmediato a Google Drive
    
    const row = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
    res.json({ ok: true, gasto: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PUT /api/gastos/:id  →  Update expense ──────────────────
router.put('/:id', async (req, res) => {
  const { id } = req.params;
  const { proveedor, folio, fechaFactura, monto, concepto, fechaSolicitud, estatus, categoria, sheet_url, sucursal } = req.body;
  const db = getDB();

  try {
    const existing = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Gasto no encontrado.' });

    // Verificar autorización
    if (!authorizeGasto(req, existing)) {
      return res.status(403).json({ ok: false, error: 'No tienes permisos para modificar este gasto.' });
    }

    const role = getGestorRole(req);
    let finalSucursal = sucursal;
    if (role === 'poniente') {
      finalSucursal = 'Toyota Farrera Poniente';
    } else if (role === 'oriente') {
      finalSucursal = 'Toyota Chiapas';
    }

    const mes = fechaFactura ? fechaFactura.substring(0, 7) : existing.mes;

    db.prepare(`
      UPDATE gastos SET
        proveedor = ?, folio = ?, fecha_factura = ?, monto = ?,
        concepto = ?, fecha_solicitud = ?, estatus = ?, categoria = ?, mes = ?, sheet_url = ?, sucursal = ?
      WHERE id = ?
    `).run(
      proveedor || existing.proveedor, folio || existing.folio, fechaFactura || existing.fecha_factura,
      monto !== undefined ? monto : existing.monto, concepto || existing.concepto,
      fechaSolicitud || existing.fecha_solicitud, estatus || existing.estatus,
      categoria || existing.categoria, mes, 
      sheet_url !== undefined ? sheet_url : existing.sheet_url,
      finalSucursal !== undefined ? finalSucursal : existing.sucursal,
      id
    );

    await backupDatabaseToDrive(); // Respaldo inmediato a Google Drive

    const row = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
    res.json({ ok: true, gasto: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── PATCH /api/gastos/:id/estatus ────────────────
router.patch('/:id/estatus', async (req, res) => {
  const { id } = req.params;
  const { estatus } = req.body;
  const db = getDB();

  try {
    const existing = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Gasto no encontrado.' });

    // Verificar autorización
    if (!authorizeGasto(req, existing)) {
      return res.status(403).json({ ok: false, error: 'No tienes permisos para modificar este gasto.' });
    }

    db.prepare('UPDATE gastos SET estatus = ? WHERE id = ?').run(estatus, id);
    
    await backupDatabaseToDrive(); // Respaldo inmediato a Google Drive
    
    const row = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
    res.json({ ok: true, gasto: row });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/gastos/:id ────────────────
router.delete('/:id', async (req, res) => {
  const { id } = req.params;
  const db = getDB();
  try {
    const existing = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Gasto no encontrado.' });

    // Verificar autorización
    if (!authorizeGasto(req, existing)) {
      return res.status(403).json({ ok: false, error: 'No tienes permisos para eliminar este gasto.' });
    }

    db.prepare('DELETE FROM gastos WHERE id = ?').run(id);
    
    await backupDatabaseToDrive(); // Respaldo inmediato a Google Drive
    
    res.json({ ok: true, mensaje: 'Gasto eliminado.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/gastos/stats  →  Data for Charts ──────────────
router.get('/stats', (req, res) => {
  const { desde, hasta, categoria, mes: mesFiltro, anio: anioFiltro, rango, sucursal } = req.query;
  const db = getDB();

  try {
    const proveedor = req.query.proveedor || '';
    let dateFilter = "WHERE id != '00000000-0000-0000-0000-000000000000'";

    if (desde) dateFilter += ` AND fecha_factura >= '${desde}'`;
    if (hasta) dateFilter += ` AND fecha_factura <= '${hasta}'`;
    if (proveedor) dateFilter += ` AND proveedor LIKE '%${proveedor.replace(/'/g, "''")}%'`;

    if (categoria) {
      const catArray = categoria.split('|').filter(Boolean);
      if (catArray.length > 0) {
        dateFilter += ` AND categoria IN (${catArray.map(c => `'${c.replace(/'/g, "''")}'`).join(',')})`;
      }
    }

    if (mesFiltro && anioFiltro) {
      dateFilter += ` AND mes = '${anioFiltro}-${mesFiltro}'`;
    } else if (anioFiltro) {
      dateFilter += ` AND mes LIKE '${anioFiltro}-%'`;
    } else if (mesFiltro) {
      dateFilter += ` AND mes LIKE '%-${mesFiltro}'`;
    }

    const now = new Date();
    if (rango === 'mes') {
      dateFilter += ` AND mes = '${now.toISOString().substring(0, 7)}'`;
    } else if (rango === 'trimestre') {
      now.setMonth(now.getMonth() - 2);
      dateFilter += ` AND mes >= '${now.toISOString().substring(0, 7)}'`;
    } else if (rango === 'anual') {
      dateFilter += ` AND SUBSTR(mes, 1, 4) = '${now.getFullYear()}'`;
    }

    const rows = db.prepare(`SELECT monto, categoria, mes, fecha_factura, sucursal FROM gastos ${dateFilter}`).all();

    // Filtrado por sucursal según el rol de usuario
    const role = getGestorRole(req);
    let targetSucursal = sucursal;
    if (role === 'poniente') {
      targetSucursal = 'Toyota Farrera Poniente';
    } else if (role === 'oriente') {
      targetSucursal = 'Toyota Chiapas';
    }

    let finalRows = rows;
    if (targetSucursal) {
      finalRows = rows.filter(r => {
        const rSuc = r.sucursal || (r.categoria === 'TOYOTA PONIENTE' ? 'Toyota Farrera Poniente' : 'Toyota Chiapas');
        return rSuc === targetSucursal;
      });
    }

    // Agregar datos en memoria
    const monthlyObj = {};
    const byCategoryObj = {};
    
    finalRows.forEach(r => {
      const label = (mesFiltro || desde || hasta || rango === 'mes') ? r.fecha_factura : r.mes;
      monthlyObj[label] = (monthlyObj[label] || 0) + (r.monto || 0);
      byCategoryObj[r.categoria] = (byCategoryObj[r.categoria] || 0) + (r.monto || 0);
    });

    const monthly = Object.entries(monthlyObj).map(([label, total]) => ({ label, total })).sort((a,b) => a.label.localeCompare(b.label));
    const byCategory = Object.entries(byCategoryObj).map(([categoria, total]) => ({ categoria, total })).sort((a,b) => b.total - a.total);

    res.json({ ok: true, stats: { monthly, byCategory, yearly: [] } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/gastos/:id/upload-pago ────────────────
router.post('/:id/upload-pago', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const file = req.file;
  if (!file) return res.status(400).json({ ok: false, error: 'No se recibió archivo.' });

  try {
    const db = getDB();
    const gasto = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
    if (!gasto) return res.status(404).json({ ok: false, error: 'Gasto no encontrado.' });

    // Verificar autorización
    if (!authorizeGasto(req, gasto)) {
      return res.status(403).json({ ok: false, error: 'No tienes permisos para modificar este gasto.' });
    }

    const client = getAuthorizedClient();
    if (!client) return res.status(401).json({ ok: false, error: 'Google no autorizado.' });
    const drive = getGoogle().drive({ version: 'v3', auth: client });

    // Step 1: Find or create the provider subfolder
    const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const searchRes = await drive.files.list({
      q: `'${rootFolderId}' in parents and name='${gasto.proveedor}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)'
    });
    
    let folderId;
    if (searchRes.data.files.length > 0) {
      folderId = searchRes.data.files[0].id;
    } else {
      const newFolder = await drive.files.create({
        requestBody: { name: gasto.proveedor, mimeType: 'application/vnd.google-apps.folder', parents: [rootFolderId] },
        fields: 'id'
      });
      folderId = newFolder.data.id;
    }

    // Step 2: Upload the PDF
    const driveRes = await drive.files.create({
      requestBody: { name: `PAGO_${gasto.folio}_${file.originalname}`, parents: [folderId] },
      media: { mimeType: 'application/pdf', body: require('stream').Readable.from(file.buffer) },
      fields: 'id, webViewLink'
    });

    const url = driveRes.data.webViewLink;

    // Step 3: Update DB
    db.prepare('UPDATE gastos SET comprobante_pago_url = ?, estatus = ? WHERE id = ?').run(url, 'pagado', id);
    
    await backupDatabaseToDrive(); // Respaldo inmediato a Google Drive

    res.json({ ok: true, url });
  } catch (err) {
    console.error('Upload pago error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── DELETE /api/gastos/:id/pago ────────────────
router.delete('/:id/pago', async (req, res) => {
  const { id } = req.params;
  const db = getDB();
  try {
    const gasto = db.prepare('SELECT * FROM gastos WHERE id = ?').get(id);
    if (!gasto) return res.status(404).json({ ok: false, error: 'Gasto no encontrado.' });

    // Verificar autorización
    if (!authorizeGasto(req, gasto)) {
      return res.status(403).json({ ok: false, error: 'No tienes permisos para modificar este gasto.' });
    }

    db.prepare('UPDATE gastos SET comprobante_pago_url = NULL, estatus = ? WHERE id = ?').run('en_proceso', id);
    
    await backupDatabaseToDrive(); // Respaldo inmediato a Google Drive

    res.json({ ok: true, mensaje: 'Comprobante eliminado del registro.' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Sincronización con Google Drive ────────────────────────
let backupTimer = null;
let isBackingUp = false;

function triggerBackup() {
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupDatabaseToDrive().catch(err => {
      console.error('⚠️ Error en respaldo automático a Drive:', err.message);
    });
  }, 1000);
}

async function backupDatabaseToDrive() {
  if (isBackingUp) return;
  isBackingUp = true;

  const DATA_DIR = path.join(__dirname, '..', 'data');
  const dbPath = path.join(DATA_DIR, 'gastos.db');
  const backupTempPath = path.join(DATA_DIR, 'gastos_backup.db');

  try {
    const client = getAuthorizedClient();
    if (!client) {
      console.log('ℹ️ Google Drive no autorizado, omitiendo respaldo de base de datos.');
      return;
    }

    if (!fs.existsSync(dbPath)) {
      console.log('ℹ️ Archivo local de base de datos no existe. Omitiendo respaldo.');
      return;
    }

    // Guard de seguridad: verificar que la base de datos local no esté vacía antes de sobrescribir
    const db = getDB();
    const countRow = db.prepare("SELECT count(*) as count FROM gastos").get();
    const count = countRow ? countRow.count : 0;
    
    if (count === 0) {
      console.warn('⚠️ Alerta de seguridad: La base de datos local tiene 0 registros. Omitiendo respaldo a Drive para proteger la copia remota.');
      return;
    }

    // Generar snapshot consistente y seguro mediante la API nativa de SQLite backup
    await db.backup(backupTempPath);

    console.log(`💾 Respaldando base de datos SQLite (${count} registros) en Google Drive...`);
    const drive = getGoogle().drive({ version: 'v3', auth: client });
    const searchRes = await drive.files.list({
      q: "name = 'gestor_facturas_database.db' and trashed = false",
      fields: 'files(id)'
    });

    const media = {
      mimeType: 'application/x-sqlite3',
      body: fs.createReadStream(backupTempPath)
    };

    if (searchRes.data.files.length > 0) {
      const fileId = searchRes.data.files[0].id;
      await drive.files.update({
        fileId,
        requestBody: { name: 'gestor_facturas_database.db' },
        media
      });
      console.log('✅ Respaldo de base de datos actualizado con éxito en Google Drive.');
    } else {
      await drive.files.create({
        requestBody: {
          name: 'gestor_facturas_database.db'
        },
        media,
        fields: 'id'
      });
      console.log('✅ Respaldo de base de datos creado con éxito en Google Drive.');
    }
  } catch (err) {
    console.error('❌ Error al respaldar base de datos en Google Drive:', err.message);
  } finally {
    isBackingUp = false;
    if (fs.existsSync(backupTempPath)) {
      try { fs.unlinkSync(backupTempPath); } catch (e) {}
    }
  }
}

async function restoreDatabaseFromDrive() {
  const DATA_DIR = path.join(__dirname, '..', 'data');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const dbPath = path.join(DATA_DIR, 'gastos.db');
  const tempPath = path.join(DATA_DIR, 'gastos_download.db.tmp');

  try {
    const client = getAuthorizedClient();
    if (!client) {
      console.log('ℹ️ Google Drive no autorizado. Usando base de datos SQLite local vacía.');
      return;
    }
    const drive = getGoogle().drive({ version: 'v3', auth: client });

    console.log('🔍 Buscando respaldo de base de datos en Google Drive...');
    const res = await drive.files.list({
      q: "name = 'gestor_facturas_database.db' and trashed = false",
      fields: 'files(id)'
    });

    if (res.data.files.length > 0) {
      const fileId = res.data.files[0].id;
      console.log(`📥 Descargando respaldo seguro desde Google Drive (File ID: ${fileId})...`);

      // Descargar en un archivo temporal primero para nunca truncar gastos.db si la red falla
      const dest = fs.createWriteStream(tempPath);
      const driveRes = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
      );

      await new Promise((resolve, reject) => {
        driveRes.data
          .pipe(dest)
          .on('finish', resolve)
          .on('error', reject);
      });

      // Verificar tamaño de archivo descargado
      const stats = fs.statSync(tempPath);
      if (!stats || stats.size === 0) {
        console.error('⚠️ El archivo descargado desde Drive está vacío (0 bytes). Restauración abortada para proteger datos locales.');
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        return;
      }

      // Verificar validez SQLite del archivo descargado
      const Database = require('better-sqlite3');
      const testDb = new Database(tempPath);
      const testCount = testDb.prepare("SELECT count(*) as count FROM gastos").get().count;
      testDb.close();

      console.log(`✅ Archivo restaurado verificado correctamente con ${testCount} registros.`);

      // Copiar atómicamente el archivo verificado a la base de datos de producción
      fs.copyFileSync(tempPath, dbPath);
      fs.unlinkSync(tempPath);
      console.log('✅ Base de datos SQLite restaurada con éxito.');
    } else {
      console.log('ℹ️ No se encontró ningún respaldo de base de datos en Google Drive.');
    }
  } catch (err) {
    console.error('⚠️ Error al restaurar base de datos desde Google Drive:', err.message);
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) {}
    }
  }
}

// ── GET /api/gastos/:id/download-comprobante ────────
router.get('/:id/download-comprobante', async (req, res) => {
  const { id } = req.params;
  try {
    const db = getDB();
    const row = db.prepare('SELECT comprobante_pago_url FROM gastos WHERE id = ?').get(id);
    if (!row || !row.comprobante_pago_url) return res.status(404).send('No hay comprobante.');
    res.redirect(row.comprobante_pago_url);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

module.exports = {
  router,
  restoreDatabaseFromDrive,
  backupDatabaseToDrive
};
