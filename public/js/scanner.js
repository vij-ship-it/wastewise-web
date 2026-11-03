// Gate scanner: recognises faces with the webcam and checks students in.
const $ = (id) => document.getElementById(id);
const state = { mode: 'face', busy: false, pauseUntil: 0, key: null, stableHits: 0 };
try { state.key = localStorage.getItem('ww_scanner_key'); } catch {}

async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.key) headers['X-Scanner-Key'] = state.key;
  const res = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; throw e; }
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const setStatus = (t) => { $('statusBar').textContent = t; };
setInterval(() => { $('clock').textContent = new Date().toLocaleString(); }, 1000);

function beep(ok) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = ok ? 880 : 220; o.type = ok ? 'sine' : 'square';
    g.gain.value = 0.08; o.start(); o.stop(ctx.currentTime + (ok ? 0.18 : 0.4));
  } catch {}
}

function selectedMeal() { return $('mealSel').value; }
function selectedDate() { return selectedMeal() === 'auto' ? undefined : $('dateSel').value || undefined; }

async function refreshStatus() {
  const s = await api(`/api/scanner/status?meal=${encodeURIComponent(selectedMeal() || 'auto')}&date=${selectedDate() || ''}`);
  if (!$('mealSel').options.length) {
    $('mealSel').innerHTML = '<option value="auto">AUTO (current meal time)</option>' + s.meals.map((m) => `<option value="${m}">${m.toUpperCase()} (manual override)</option>`).join('');
  }
  const sess = s.session;
  $('sessionInfo').innerHTML = sess ? `<span class="ok">● ${sess.meal.toUpperCase()}</span> · ${sess.date}<br>Expected: ${sess.expected} · In: ${sess.checked_in}` : '<span class="warn">● NO MEAL SESSION OPEN NOW</span><br>Pick a meal above to test outside meal hours.';
  $('cntIn').textContent = sess ? sess.checked_in : 0;
  $('cntFaces').textContent = s.enrolled_faces;
  $('log').innerHTML = s.recent.map(logLine).join('');
}
function logLine(r) {
  const cls = r.result === 'granted' ? 'ok' : r.result === 'duplicate' ? 'warn' : 'bad';
  const t = (r.ts || new Date().toTimeString()).slice(-8, -3);
  return `<div><span class="${cls}">[${r.result.toUpperCase()}]</span> ${esc(t)} ${esc(r.label || '')}${r.meal ? ' · ' + esc(r.meal) : ''}<br><span style="opacity:.7">${esc(r.reason || '')}</span></div>`;
}

function showResult(r) {
  const box = $('result');
  box.className = `result show ${r.result}`;
  $('rHead').textContent = r.result === 'granted' ? 'ACCESS GRANTED' : r.result === 'duplicate' ? 'ALREADY CHECKED IN' : 'ACCESS DENIED';
  $('rWho').textContent = [r.label, r.roll_no].filter(Boolean).join('  |  ');
  $('rWhy').textContent = r.reason || '';
  beep(r.result === 'granted');
  state.pauseUntil = Date.now() + 3500;
  setTimeout(() => { box.className = 'result'; }, 3200);
  $('log').insertAdjacentHTML('afterbegin', logLine({ ...r, ts: new Date().toTimeString().slice(0, 8) + '   ' }));
  refreshStatus().catch(() => {});
}

async function faceLoop() {
  const video = $('video');
  if (state.mode === 'face' && !state.busy && Date.now() > state.pauseUntil && video.readyState >= 2) {
    state.busy = true;
    try {
      const r = await Face.detect(video);
      if (r.count === 0) { state.stableHits = 0; Face.draw($('overlay'), video, []); setStatus('READY · LOOK INTO THE CAMERA'); }
      else if (r.count > 1) { state.stableHits = 0; Face.draw($('overlay'), video, r.all, '#f5a623', 'ONE PERSON AT A TIME'); setStatus('MULTIPLE FACES DETECTED · ONE PERSON AT A TIME'); }
      else {
        Face.draw($('overlay'), video, r.all, '#2ecc71', 'SCANNING');
        state.stableHits++;
        setStatus('FACE DETECTED · HOLD STILL…');
        if (state.stableHits >= 2 && r.detection.detection.score > 0.6) {
          state.stableHits = 0;
          const res = await api('/api/scanner/identify', { descriptor: Array.from(r.detection.descriptor), meal: selectedMeal(), date: selectedDate() });
          Face.draw($('overlay'), video, r.all, res.result === 'granted' ? '#2ecc71' : res.result === 'duplicate' ? '#f5a623' : '#ff5b4a', (res.label || '').toUpperCase());
          showResult(res);
        }
      }
    } catch (e) { setStatus('ERROR: ' + e.message); state.pauseUntil = Date.now() + 2000; }
    state.busy = false;
  }
  setTimeout(faceLoop, 250);
}

function qrLoop() {
  const video = $('video');
  if (state.mode === 'qr' && !state.busy && Date.now() > state.pauseUntil && video.readyState >= 2) {
    const c = $('qrCanvas');
    c.width = video.videoWidth; c.height = video.videoHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, c.width, c.height);
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const code = jsQR(img.data, img.width, img.height, { inversionAttempts: 'attemptBoth' });
    if (code && code.data) checkGuest(code.data);
  }
  setTimeout(qrLoop, 300);
}
async function checkGuest(code) {
  state.busy = true;
  try { showResult(await api('/api/scanner/guest', { code, meal: selectedMeal(), date: selectedDate() })); }
  catch (e) { setStatus('ERROR: ' + e.message); }
  state.busy = false;
}

function setMode(m) {
  state.mode = m;
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === m));
  Face.draw($('overlay'), $('video'), []);
  setStatus(m === 'face' ? 'FACE MODE · LOOK INTO THE CAMERA' : 'GUEST MODE · HOLD THE QR CODE UP TO THE CAMERA');
}

async function start() {
  try { await api('/api/scanner/status'); }
  catch (e) {
    if (e.status === 403) { $('authBox').classList.remove('d-none'); return; }
    throw e;
  }
  $('main').classList.remove('d-none');
  await refreshStatus();
  setInterval(() => refreshStatus().catch(() => {}), 10000);
  document.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  const d = new Date();
  $('dateSel').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  $('mealSel').addEventListener('change', () => { $('dateSel').classList.toggle('d-none', selectedMeal() === 'auto'); refreshStatus(); });
  $('dateSel').addEventListener('change', () => refreshStatus());
  $('codeBtn').addEventListener('click', () => { const v = $('codeInput').value.trim(); if (v) { checkGuest(v); $('codeInput').value = ''; } });
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('codeBtn').click(); });
  try {
    await Face.startCamera($('video'));
    setStatus('LOADING FACE RECOGNITION MODELS…');
    await Face.load();
    setMode('face');
    faceLoop();
    qrLoop();
  } catch (e) {
    setStatus('CAMERA ERROR: ' + e.message + ' (guest codes can still be typed on the right)');
  }
}

$('keyBtn').addEventListener('click', () => {
  state.key = $('keyInput').value.trim();
  try { localStorage.setItem('ww_scanner_key', state.key); } catch {}
  $('authBox').classList.add('d-none');
  start();
});
start();
