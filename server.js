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

// Servir archivos estáticos de forma estándar
app.use(express.static(path.join(__dirname, 'public')));

// ── Middleware de seguridad básica para Takata ──
function takataAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  if (!auth) {
    res.set('WWW-Authenticate', 'Basic realm="Acceso Seguro Takata"');
    return res.status(401).send('Acceso requerido.');
  }
  
  const b64auth = auth.split(' ')[1] || '';
  const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login === 'takata' && password === 'toyota2026') {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="Acceso Seguro Takata"');
  res.status(401).send('Credenciales incorrectas.');
}

// Servir Takata (con y sin slash final)
app.use('/takata', takataAuth, express.static(path.join(__dirname, 'seguimiento-takata'), { redirect: true }));

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
  const index = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(404).send('Frontend no encontrado en el servidor.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ SERVIDOR ACTUALIZADO`);
  console.log(`🚀 Corriendo en puerto: ${PORT}`);
});
