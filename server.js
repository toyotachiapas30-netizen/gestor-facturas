const fs = require('fs');
require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = 3001; // Regresamos al puerto estándar

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Servir archivos estáticos de forma estándar (ahora que estamos en un disco rápido)
app.use(express.static(path.join(__dirname, 'public')));

// ── Middleware de seguridad básica para Takata ──
function takataAuth(req, res, next) {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  // Usuario y contraseña predeterminados (puedes cambiarlos aquí)
  if (login === 'takata' && password === 'toyota2026') {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Acceso Seguro Takata"');
  res.status(401).send('Acceso denegado: Credenciales incorrectas.');
}

app.use('/takata', takataAuth, express.static(path.join(__dirname, 'seguimiento-takata')));

// ── Rutas ─────────────────────────────────────────────────
app.use('/api/sat',     require('./routes/sat'));
app.use('/api/drive',   require('./routes/drive').router);
app.use('/api/sheets',  require('./routes/sheets'));
app.use('/api/autotec', require('./routes/autotec-buzon'));
app.use('/api/portal',  require('./routes/autotec-portal'));
app.use('/api/mail',    require('./routes/mail'));
app.use('/api/gastos',  require('./routes/gastos'));
app.use('/api/takata',  require('./routes/takata'));

// ── Fallback para el Frontend ──────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ PROYECTO ESTABILIZADO Y LISTO`);
  console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
  console.log(`📂 Nueva ubicación local: ${__dirname}\n`);
});
