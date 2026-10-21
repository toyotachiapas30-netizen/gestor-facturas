const http = require('http');
const https = require('https');
http.globalAgent.keepAlive = false;
https.globalAgent.keepAlive = false;

const fs = require('fs');
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001; 

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Ruta de diagnóstico para verificar que el servidor responde
app.get('/debug-servidor', (req, res) => {
  res.json({ status: 'OK', puerto: PORT, folder: __dirname });
});
app.get('/ping', (req, res) => {
  res.send('pong');
});

// ── Token de sesión para Gestor ──
const GESTOR_SESSION_TOKEN = 'gestor_2026_toyota_secure_session';

function getGestorToken(req) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('gestor_session='));
  return found ? decodeURIComponent(found.split('=')[1]) : null;
}

function gestorAuth(req, res, next) {
  const p = req.path;
  
  // Si la ruta es para Takata (vista o API), permitir continuar (Takata tiene su propio login y middleware takataApiAuth)
  if (p.startsWith('/takata') || p.startsWith('/api/takata')) {
    return next();
  }
  
  // Recursos permitidos sin iniciar sesión
  const allowed = [
    '/login.html', 
    '/styles.css', 
    '/hero_bg.jpg', 
    '/toyota-chiapas.png', 
    '/farrera-poniente.png', 
    '/api/auth/login',
    '/api/drive/callback'
  ];
  
  if (allowed.includes(p) || p === '/login') {
    return next();
  }
  
  const token = getGestorToken(req);
  if (token === GESTOR_SESSION_TOKEN) {
    return next();
  }
  
  if (p.startsWith('/api/') || req.headers['accept']?.includes('application/json')) {
    return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
  }
  
  res.redirect('/login.html');
}

// Aplicar middleware de autenticación antes de servir archivos estáticos
app.use(gestorAuth);

// Servir archivos estáticos de forma estándar
app.use(express.static(path.join(__dirname, 'public')));

// ── Token de sesión para Takata ──
const TAKATA_SESSION_TOKEN = 'takata_2026_toyota_secure_session';
const TAKATA_READONLY_TOKEN = 'takata_readonly_session_token';

function getTakataToken(req) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith('takata_session='));
  return found ? decodeURIComponent(found.split('=')[1]) : null;
}

function takataAuth(req, res, next) {
  if (req.path === '/login.html' || req.path === '/login') {
    return next();
  }

  const token = getTakataToken(req);
  if (token === TAKATA_SESSION_TOKEN || token === TAKATA_READONLY_TOKEN) {
    return next();
  }

  if (req.path.endsWith('.json') || req.headers['accept']?.includes('application/json')) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  
  res.redirect('/takata/login.html');
}

app.post('/takata/login', (req, res) => {
  const { usuario, clave } = req.body || {};
  if (usuario === 'takata' && clave === 'toyota2026') {
    res.setHeader('Set-Cookie', [
      `takata_session=${TAKATA_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      `takata_role=admin; Path=/; SameSite=Strict; Max-Age=604800`
    ]);
    res.json({ ok: true, role: 'admin' });
  } else if (usuario === 'visor' && clave === 'toyota2026') {
    res.setHeader('Set-Cookie', [
      `takata_session=${TAKATA_READONLY_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`,
      `takata_role=readonly; Path=/; SameSite=Strict; Max-Age=604800`
    ]);
    res.json({ ok: true, role: 'readonly' });
  } else {
    res.status(401).json({ error: 'Credenciales inválidas' });
  }
});

app.use('/takata', takataAuth, express.static(path.join(__dirname, 'seguimiento-takata')));

function takataApiAuth(req, res, next) {
  if (req.path === '/login' || req.path === '/logout') return next();
  const token = getTakataToken(req);
  if (!token || (token !== TAKATA_SESSION_TOKEN && token !== TAKATA_READONLY_TOKEN)) {
    return res.status(401).json({ error: 'No autorizado. Inicia sesión en /takata/' });
  }
  
  // Bloquear métodos de escritura si es visor
  if (token === TAKATA_READONLY_TOKEN && req.method !== 'GET') {
    return res.status(403).json({ error: 'Usuario de solo lectura. No tienes permisos para modificar.' });
  }
  
  return next();
}

// ── Conexión con admin.toyoter.com (KPIs | Seguimientos -> Control de Pagos) ──
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

async function resolveControlPagosAssociate(empInput) {
  const target = normalizeEmp(empInput);
  if (!target) return null;

  const url = `${DO_SUPABASE_URL}/rest/v1/taller_citas?folio=in.(__KPI_USERS_control-pagos__,__DO_SYSTEM_USERS__,__DO_ASSOCIATES_DIRECTORY__)&fecha_cita=eq.2099-12-31&select=folio,datos_recepcion`;
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

  // 1. Usuarios globales de sistema con permiso a KPIs
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
          gestorRole: 'admin',
          accesoOriente: true,
          accesoPoniente: true
        });
      }
    }
  }

  // 2. Lista específica de Control de Pagos en KPIs | Seguimientos (Opción B: Switch 1 = Oriente, Switch 2 = Poniente)
  const kpiRow = rows.find(x => x.folio === '__KPI_USERS_control-pagos__');
  if (Array.isArray(kpiRow?.datos_recepcion?.users)) {
    for (const u of kpiRow.datos_recepcion.users) {
      const emp = normalizeEmp(u.employeeNumber);
      if (!emp) continue;
      const dirInfo = assocMap.get(emp);
      const bestName = (dirInfo && dirInfo.fullName) || (!isGenericName(u.fullName) ? u.fullName : `Asociado #${emp}`);
      const accesoOriente = u.canUploadExcel !== undefined ? !!u.canUploadExcel : true;
      const accesoPoniente = u.canEditTracking !== undefined ? !!u.canEditTracking : true;

      if (!accesoOriente && !accesoPoniente) {
        authorizedMap.delete(emp);
        continue;
      }

      let gestorRole = 'admin';
      if (accesoOriente && accesoPoniente) {
        gestorRole = 'admin';
      } else if (accesoOriente) {
        gestorRole = 'oriente';
      } else if (accesoPoniente) {
        gestorRole = 'poniente';
      }

      authorizedMap.set(emp, {
        employeeNumber: emp,
        fullName: bestName,
        gestorRole,
        accesoOriente,
        accesoPoniente
      });
    }
  }

  return authorizedMap.get(target) || null;
}

// ── Rutas de Autenticación del Gestor ────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { numEmpleado, usuario, clave } = req.body || {};
    const candidate = (numEmpleado || usuario || '').trim();
    const lowerUser = candidate.toLowerCase();

    // 1. Acceso de respaldo con usuario y contraseña tradicional
    if (clave === 'toyota2026' && (lowerUser === 'admin' || lowerUser === 'oriente' || lowerUser === 'poniente')) {
      const labelMap = { admin: 'Administrador General', oriente: 'Sucursal Oriente', poniente: 'Sucursal Poniente' };
      res.setHeader('Set-Cookie', [
        `gestor_session=${GESTOR_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
        `gestor_role=${lowerUser}; Path=/; SameSite=Lax; Max-Age=604800`,
        `gestor_emp=${encodeURIComponent(lowerUser.toUpperCase())}; Path=/; SameSite=Lax; Max-Age=604800`,
        `gestor_name=${encodeURIComponent(labelMap[lowerUser])}; Path=/; SameSite=Lax; Max-Age=604800`
      ]);
      return res.json({
        ok: true,
        role: lowerUser,
        user: { employeeNumber: lowerUser.toUpperCase(), fullName: labelMap[lowerUser], role: lowerUser }
      });
    }

    // 2. Acceso directo por Número de Empleado desde admin.toyoter.com (KPIs | Seguimientos)
    if (candidate) {
      const assoc = await resolveControlPagosAssociate(candidate);
      if (assoc) {
        res.setHeader('Set-Cookie', [
          `gestor_session=${GESTOR_SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
          `gestor_role=${assoc.gestorRole}; Path=/; SameSite=Lax; Max-Age=604800`,
          `gestor_emp=${encodeURIComponent(assoc.employeeNumber)}; Path=/; SameSite=Lax; Max-Age=604800`,
          `gestor_name=${encodeURIComponent(assoc.fullName)}; Path=/; SameSite=Lax; Max-Age=604800`
        ]);
        return res.json({
          ok: true,
          role: assoc.gestorRole,
          user: {
            employeeNumber: assoc.employeeNumber,
            fullName: assoc.fullName,
            role: assoc.gestorRole,
            accesoOriente: assoc.accesoOriente,
            accesoPoniente: assoc.accesoPoniente
          }
        });
      }
    }

    return res.status(401).json({
      ok: false,
      error: 'Número de empleado sin acceso autorizado en admin.toyoter.com (KPIs | Seguimientos → Control de Pagos).'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', [
    'gestor_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    'gestor_role=; Path=/; SameSite=Lax; Max-Age=0',
    'gestor_emp=; Path=/; SameSite=Lax; Max-Age=0',
    'gestor_name=; Path=/; SameSite=Lax; Max-Age=0'
  ]);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const token = getGestorToken(req);
  if (token !== GESTOR_SESSION_TOKEN) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  
  const cookies = req.headers.cookie || '';
  const parseCookie = name => {
    const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(`${name}=`));
    return found ? decodeURIComponent(found.split('=')[1]) : '';
  };

  let role = parseCookie('gestor_role') || 'admin';
  const emp = parseCookie('gestor_emp') || '';
  let fullName = parseCookie('gestor_name') || '';

  // Revalidación en tiempo real contra admin.toyoter.com si entró con Número de Empleado
  if (emp && !['ADMIN', 'ORIENTE', 'PONIENTE'].includes(emp.toUpperCase())) {
    try {
      const liveAssoc = await resolveControlPagosAssociate(emp);
      if (!liveAssoc) {
        res.setHeader('Set-Cookie', [
          'gestor_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
          'gestor_role=; Path=/; SameSite=Lax; Max-Age=0',
          'gestor_emp=; Path=/; SameSite=Lax; Max-Age=0',
          'gestor_name=; Path=/; SameSite=Lax; Max-Age=0'
        ]);
        return res.status(401).json({ error: 'Acceso revocado desde admin.toyoter.com', revoked: true });
      }
      role = liveAssoc.gestorRole;
      fullName = liveAssoc.fullName;
      res.setHeader('Set-Cookie', [
        `gestor_role=${role}; Path=/; SameSite=Lax; Max-Age=604800`,
        `gestor_name=${encodeURIComponent(fullName)}; Path=/; SameSite=Lax; Max-Age=604800`
      ]);
    } catch (e) {}
  }

  res.json({
    ok: true,
    role,
    user: {
      employeeNumber: emp,
      fullName,
      role
    }
  });
});

// ── Rutas ─────────────────────────────────────────────────
app.use('/api/sat',     require('./routes/sat'));
app.use('/api/drive',   require('./routes/drive').router);
app.use('/api/sheets',  require('./routes/sheets'));
app.use('/api/autotec', require('./routes/autotec-buzon'));
app.use('/api/portal',  require('./routes/autotec-portal'));
app.use('/api/mail',    require('./routes/mail'));
app.use('/api/gastos',  require('./routes/gastos').router);
app.use('/api/takata',  takataApiAuth, require('./routes/takata')); // ← Protegida

// ── Fallback para el Frontend ──────────────────────────────
app.get('*', (req, res) => {
  const index = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(404).send('Frontend no encontrado en el servidor.');
  }
});

async function startServer() {
  // 1. Restaurar base de datos SQLite desde Google Drive
  try {
    const { restoreDatabaseFromDrive } = require('./routes/gastos');
    await restoreDatabaseFromDrive();
  } catch (err) {
    console.error('⚠️ Error al restaurar base de datos desde Google Drive:', err.message);
  }

  app.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n✅ SERVIDOR ACTUALIZADO`);
    console.log(`🚀 Corriendo en puerto: ${PORT}`);

    // 2. Restaurar tokens de Google desde la base de datos en el arranque del servidor
    try {
      const { restoreTokensFromDatabase } = require('./routes/drive');
      await restoreTokensFromDatabase();
    } catch (err) {
      console.error('⚠️ Error al iniciar restauración de tokens:', err.message);
    }
  });
}

startServer();

// ── Manejadores de Apagado Seguro (Graceful Shutdown) ──────
async function handleShutdown(signal) {
  console.log(`\n🛑 Servidor recibiendo señal ${signal}. Guardando respaldo final en Google Drive...`);
  try {
    const { backupDatabaseToDrive } = require('./routes/gastos');
    await backupDatabaseToDrive();
    console.log('✅ Respaldo final completado.');
  } catch (e) {
    console.error('⚠️ Error en respaldo final:', e.message);
  }
  process.exit(0);
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));
