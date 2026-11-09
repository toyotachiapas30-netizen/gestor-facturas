/* =============================================
   TOYOTA CHIAPAS – SORTEO EN VIVO  |  app.js
   ============================================= */

// ── STATE ────────────────────────────────────
let names        = [];
let spinning     = false;
let currentAngle = 0;
let rafId        = null;

const PALETTE = [
  '#e50000','#7b0000','#b71c1c','#4a0000',
  '#c62828','#560000','#d32f2f','#8B0000',
  '#a00000','#6a0000','#c0392b','#3b0000',
  '#991a00','#5c1010','#cc2200','#3d0000',
];

// ── AUDIO ────────────────────────────────────
const AudioCtx = window.AudioContext || window.webkitAudioContext;
let audioCtx   = null;
function getAudioCtx() { if (!audioCtx) audioCtx = new AudioCtx(); return audioCtx; }

function playTick() {
  try {
    const ctx = getAudioCtx(), osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(1400, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(700, ctx.currentTime + 0.04);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.06);
  } catch(e) {}
}

function playSpinSound() {
  try {
    const ctx = getAudioCtx(), osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(80, ctx.currentTime);
    osc.frequency.linearRampToValueAtTime(300, ctx.currentTime + 1.2);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.0, ctx.currentTime + 1.2);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 1.3);
  } catch(e) {}
}

function playWinnerSound() {
  try {
    const ctx = getAudioCtx();
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = ctx.createOscillator(), gain = ctx.createGain(), t = ctx.currentTime + i * 0.18;
      osc.connect(gain); gain.connect(ctx.destination);
      osc.type = 'sine'; osc.frequency.setValueAtTime(freq, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.35, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
      osc.start(t); osc.stop(t + 0.75);
    });
    setTimeout(() => {
      try {
        const osc2 = ctx.createOscillator(), gain2 = ctx.createGain();
        osc2.connect(gain2); gain2.connect(ctx.destination); osc2.type = 'square';
        osc2.frequency.setValueAtTime(783.99, ctx.currentTime);
        osc2.frequency.setValueAtTime(1046.5, ctx.currentTime + 0.1);
        gain2.gain.setValueAtTime(0.12, ctx.currentTime);
        gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
        osc2.start(ctx.currentTime); osc2.stop(ctx.currentTime + 0.85);
      } catch(e) {}
    }, 750);
  } catch(e) {}
}

// ── FAREWELL MUSIC ───────────────────────────
let farewellAudio = null, farewellNodes = [], farewellGain = null, farewellLoopTimer = null;

const tryMP3 = new Audio('musica_despedida.mp3');
tryMP3.addEventListener('canplaythrough', () => { farewellAudio = tryMP3; farewellAudio.loop = true; farewellAudio.volume = 0; }, { once: true });
tryMP3.addEventListener('error', () => { farewellAudio = null; }, { once: true });
tryMP3.load();

const FAREWELL_MELODY = [
  [261.63,0.0],[329.63,0.5],[392.00,1.0],[440.00,1.5],
  [523.25,2.0],[440.00,2.5],[392.00,3.0],[329.63,3.5],[261.63,4.0],
];

function scheduleFarewellLoop(ctx, masterGain) {
  FAREWELL_MELODY.forEach(([freq, offset]) => {
    const osc = ctx.createOscillator(), gain = ctx.createGain(), t = ctx.currentTime + offset;
    osc.connect(gain); gain.connect(masterGain); osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    osc.start(t); osc.stop(t + 0.5);
    farewellNodes.push(osc);
  });
}

function startFarewellMusic() {
  try {
    if (farewellAudio) {
      farewellAudio.currentTime = 0; farewellAudio.play();
      let vol = 0;
      const fi = setInterval(() => { vol = Math.min(vol + 0.03, 0.6); farewellAudio.volume = vol; if (vol >= 0.6) clearInterval(fi); }, 60);
      return;
    }
    const ctx = getAudioCtx();
    farewellGain = ctx.createGain();
    farewellGain.gain.setValueAtTime(0, ctx.currentTime);
    farewellGain.gain.linearRampToValueAtTime(0.7, ctx.currentTime + 1.5);
    farewellGain.connect(ctx.destination);
    scheduleFarewellLoop(ctx, farewellGain);
    farewellLoopTimer = setInterval(() => scheduleFarewellLoop(ctx, farewellGain), 5000);
  } catch(e) {}
}

function stopFarewellMusic() {
  try {
    if (farewellAudio) {
      let vol = farewellAudio.volume;
      const fo = setInterval(() => { vol = Math.max(vol - 0.04, 0); farewellAudio.volume = vol; if (vol <= 0) { clearInterval(fo); farewellAudio.pause(); farewellAudio.currentTime = 0; } }, 60);
      return;
    }
    if (farewellLoopTimer) { clearInterval(farewellLoopTimer); farewellLoopTimer = null; }
    if (farewellGain) {
      const ctx = getAudioCtx();
      farewellGain.gain.cancelScheduledValues(ctx.currentTime);
      farewellGain.gain.setValueAtTime(farewellGain.gain.value, ctx.currentTime);
      farewellGain.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.0);
      setTimeout(() => { farewellNodes.forEach(n => { try { n.stop(); } catch(e) {} }); farewellNodes = []; farewellGain = null; }, 1100);
    }
  } catch(e) {}
}

// ── CONFETTI ─────────────────────────────────
const confettiCanvas = document.getElementById('confetti-canvas');
const confettiCtx    = confettiCanvas.getContext('2d');
let confettiParticles = [], confettiRaf = null;

function resizeConfettiCanvas() { confettiCanvas.width = window.innerWidth; confettiCanvas.height = window.innerHeight; }
resizeConfettiCanvas();
window.addEventListener('resize', resizeConfettiCanvas);

const CONFETTI_COLORS = ['#e50000','#ffffff','#f5c518','#ff6b6b','#ff4444','#ffd700','#ff9800','#4fc3f7'];

function createConfetti(n = 180) {
  confettiParticles = [];
  for (let i = 0; i < n; i++) {
    confettiParticles.push({
      x: Math.random() * confettiCanvas.width, y: -Math.random() * confettiCanvas.height * 0.5,
      w: 6 + Math.random() * 10, h: 10 + Math.random() * 16,
      color: CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)],
      speed: 3 + Math.random() * 5, angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.18, drift: (Math.random() - 0.5) * 2.5,
      opacity: 0.85 + Math.random() * 0.15,
    });
  }
}

function animateConfetti() {
  confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  let alive = false;
  confettiParticles.forEach(p => {
    p.y += p.speed; p.x += p.drift; p.angle += p.spin; p.opacity -= 0.003;
    if (p.y < confettiCanvas.height + 20 && p.opacity > 0) {
      alive = true;
      confettiCtx.save();
      confettiCtx.translate(p.x, p.y); confettiCtx.rotate(p.angle);
      confettiCtx.globalAlpha = Math.max(0, p.opacity); confettiCtx.fillStyle = p.color;
      confettiCtx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      confettiCtx.restore();
    }
  });
  if (alive) { confettiRaf = requestAnimationFrame(animateConfetti); }
  else { confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height); confettiRaf = null; }
}

function launchConfetti() {
  if (confettiRaf) cancelAnimationFrame(confettiRaf);
  createConfetti(220); animateConfetti();
  setTimeout(() => { createConfetti(180); animateConfetti(); }, 1000);
}

// ── WHEEL ────────────────────────────────────
const wheelCanvas = document.getElementById('wheel-canvas');
const wheelCtx    = wheelCanvas.getContext('2d');
const WHEEL_R     = wheelCanvas.width / 2;

function truncate(str, max) { return str.length > max ? str.slice(0, max - 1) + '…' : str; }
function clampFontSize(name) {
  const base = Math.max(11, Math.min(17, Math.floor(360 / Math.max(names.length, 1) / 5)));
  const w = name.length * base * 0.62, maxW = WHEEL_R * 0.80;
  return w > maxW ? Math.max(9, Math.floor(base * maxW / w)) : base;
}

function drawWheel(angleOffset = 0) {
  const n = names.length;
  wheelCtx.clearRect(0, 0, wheelCanvas.width, wheelCanvas.height);
  if (n === 0) {
    wheelCtx.save();
    wheelCtx.beginPath(); wheelCtx.arc(WHEEL_R, WHEEL_R, WHEEL_R - 4, 0, Math.PI * 2);
    wheelCtx.fillStyle = 'rgba(20,20,20,0.9)'; wheelCtx.fill();
    wheelCtx.strokeStyle = 'rgba(229,0,0,0.5)'; wheelCtx.lineWidth = 6; wheelCtx.stroke();
    wheelCtx.fillStyle = 'rgba(255,255,255,0.25)'; wheelCtx.font = 'bold 1rem Outfit,sans-serif';
    wheelCtx.textAlign = 'center'; wheelCtx.textBaseline = 'middle';
    wheelCtx.fillText('Agrega participantes', WHEEL_R, WHEEL_R - 14);
    wheelCtx.fillText('para ver la ruleta 🎰', WHEEL_R, WHEEL_R + 14);
    wheelCtx.restore(); return;
  }
  const slice = (Math.PI * 2) / n, offsetRad = (angleOffset * Math.PI) / 180;
  names.forEach((name, i) => {
    const start = offsetRad + i * slice - Math.PI / 2, end = start + slice, mid = start + slice / 2;
    wheelCtx.save();
    wheelCtx.beginPath(); wheelCtx.moveTo(WHEEL_R, WHEEL_R);
    wheelCtx.arc(WHEEL_R, WHEEL_R, WHEEL_R - 4, start, end); wheelCtx.closePath();
    wheelCtx.fillStyle = PALETTE[i % PALETTE.length]; wheelCtx.fill();
    wheelCtx.strokeStyle = 'rgba(0,0,0,0.45)'; wheelCtx.lineWidth = 2; wheelCtx.stroke();
    wheelCtx.restore();
    wheelCtx.save(); wheelCtx.translate(WHEEL_R, WHEEL_R); wheelCtx.rotate(mid);
    wheelCtx.fillStyle = '#fff'; wheelCtx.font = `bold ${clampFontSize(name)}px Outfit,sans-serif`;
    wheelCtx.textAlign = 'right'; wheelCtx.textBaseline = 'middle';
    wheelCtx.shadowColor = 'rgba(0,0,0,0.8)'; wheelCtx.shadowBlur = 6;
    wheelCtx.fillText(truncate(name, 18), WHEEL_R * 0.62, 0); wheelCtx.restore();
  });
  // Hub
  wheelCtx.save();
  const grad = wheelCtx.createRadialGradient(WHEEL_R, WHEEL_R, 0, WHEEL_R, WHEEL_R, 34);
  grad.addColorStop(0, '#fff'); grad.addColorStop(0.5, '#e50000'); grad.addColorStop(1, '#a00000');
  wheelCtx.beginPath(); wheelCtx.arc(WHEEL_R, WHEEL_R, 34, 0, Math.PI * 2);
  wheelCtx.fillStyle = grad; wheelCtx.shadowColor = 'rgba(0,0,0,0.8)'; wheelCtx.shadowBlur = 12; wheelCtx.fill();
  wheelCtx.strokeStyle = 'rgba(255,255,255,0.5)'; wheelCtx.lineWidth = 3; wheelCtx.stroke();
  wheelCtx.fillStyle = '#fff'; wheelCtx.font = 'bold 22px Outfit,sans-serif';
  wheelCtx.textAlign = 'center'; wheelCtx.textBaseline = 'middle';
  wheelCtx.fillText('T', WHEEL_R, WHEEL_R); wheelCtx.restore();
}

// ── SPIN ─────────────────────────────────────
function spin() {
  if (spinning || names.length < 2) return;
  spinning = true;
  document.getElementById('btn-spin').disabled = true;
  const winnerIndex = Math.floor(Math.random() * names.length);
  const sliceDeg = 360 / names.length;
  const targetOffset = 360 - (winnerIndex * sliceDeg + sliceDeg / 2);
  const fullSpins = (5 + Math.floor(Math.random() * 5)) * 360;
  const targetAngle = currentAngle + fullSpins + targetOffset - (currentAngle % 360);
  const duration = 5000 + Math.random() * 2000;
  const startTime = performance.now(), startAngle = currentAngle;
  let lastTickSlice = -1;
  playSpinSound();

  function easeOut(t) { return 1 - Math.pow(1 - t, 3); }
  function frame(now) {
    const elapsed = now - startTime, progress = Math.min(elapsed / duration, 1);
    currentAngle = startAngle + (targetAngle - startAngle) * easeOut(progress);
    drawWheel(currentAngle);
    const normalized = ((currentAngle % 360) + 360) % 360;
    const sliceIndex = Math.floor(((360 - normalized) % 360) / sliceDeg) % names.length;
    if (sliceIndex !== lastTickSlice) { lastTickSlice = sliceIndex; if (Math.random() < 0.85 || progress > 0.7) playTick(); }
    if (progress < 1) { rafId = requestAnimationFrame(frame); }
    else { currentAngle = targetAngle; spinning = false; document.getElementById('btn-spin').disabled = names.length < 2; showWinner(names[winnerIndex]); }
  }
  rafId = requestAnimationFrame(frame);
}

function showWinner(name) {
  document.getElementById('winner-name-display').textContent = name;
  document.getElementById('winner-modal').classList.remove('hidden');
  playWinnerSound(); launchConfetti();
}

// ── NAME MANAGEMENT ──────────────────────────
function addName() {
  const input = document.getElementById('name-input'), raw = input.value.trim();
  if (!raw) return;
  names.push(raw); input.value = '';
  renderNames(); drawWheel(currentAngle); updateSpinBtn();
}
function removeName(i) { names.splice(i, 1); renderNames(); drawWheel(currentAngle); updateSpinBtn(); }
function clearAll() {
  if (!names.length || !confirm('¿Borrar todos los participantes?')) return;
  names = []; currentAngle = 0; renderNames(); drawWheel(0); updateSpinBtn();
}
function renderNames() {
  const list = document.getElementById('names-list');
  document.getElementById('names-count').textContent = `${names.length} participante${names.length !== 1 ? 's' : ''}`;
  list.innerHTML = '';
  names.forEach((name, i) => {
    const li = document.createElement('li'); li.className = 'name-item';
    const dot = document.createElement('span'); dot.className = 'name-dot'; dot.style.background = PALETTE[i % PALETTE.length];
    const txt = document.createElement('span'); txt.className = 'name-text'; txt.textContent = name;
    const btn = document.createElement('button'); btn.className = 'btn-remove'; btn.title = 'Quitar'; btn.textContent = '✕';
    btn.addEventListener('click', () => removeName(i));
    li.append(dot, txt, btn); list.appendChild(li);
  });
}
function updateSpinBtn() {
  const ok = names.length >= 2 && !spinning;
  document.getElementById('btn-spin').disabled = !ok;
  document.querySelector('.spin-hint').style.opacity = ok ? '0' : '1';
}

// ── EVENT LISTENERS ──────────────────────────
document.getElementById('btn-add').addEventListener('click', addName);
document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') addName(); });
document.getElementById('btn-spin').addEventListener('click', () => { getAudioCtx(); spin(); });
document.getElementById('btn-clear').addEventListener('click', clearAll);
document.getElementById('btn-close-modal').addEventListener('click', () => document.getElementById('winner-modal').classList.add('hidden'));
document.getElementById('btn-show-thanks').addEventListener('click', () => {
  document.getElementById('winner-modal').classList.add('hidden');
  document.getElementById('thanks-modal').classList.remove('hidden');
  startFarewellMusic();
});
document.getElementById('btn-close-thanks').addEventListener('click', () => {
  document.getElementById('thanks-modal').classList.add('hidden');
  stopFarewellMusic();
});
wheelCanvas.addEventListener('click', () => { if (!spinning && names.length >= 2) { getAudioCtx(); spin(); } });

// ── FULLSCREEN ───────────────────────────────
const btnFS = document.getElementById('btn-fullscreen');
const fsExp = document.getElementById('fs-icon-expand');
const fsCom = document.getElementById('fs-icon-compress');

function updateFsIcons() {
  const full = !!document.fullscreenElement;
  fsExp.style.display = full ? 'none'  : 'block';
  fsCom.style.display = full ? 'block' : 'none';
  btnFS.title = full ? 'Salir de pantalla completa' : 'Pantalla completa';
}

btnFS.addEventListener('click', function () {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen()
      .then(updateFsIcons)
      .catch(() => { const el = document.documentElement; if (el.webkitRequestFullscreen) el.webkitRequestFullscreen(); });
  } else {
    document.exitFullscreen()
      .then(updateFsIcons)
      .catch(() => { if (document.webkitExitFullscreen) document.webkitExitFullscreen(); });
  }
});
document.addEventListener('fullscreenchange', updateFsIcons);
document.addEventListener('webkitfullscreenchange', updateFsIcons);

// ── INIT ─────────────────────────────────────
drawWheel(0);
updateSpinBtn();
