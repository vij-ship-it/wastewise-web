// WasteWise Web: local server. Run with `npm start`, then open http://localhost:3000
const major = Number(process.versions.node.split('.')[0]);
const minor = Number(process.versions.node.split('.')[1]);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`\nWasteWise needs Node.js 22.13 or newer (you have ${process.versions.node}).`);
  console.error('Install the current LTS version from https://nodejs.org and try again.\n');
  process.exit(1);
}

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const express = require('express');
const QRCode = require('qrcode');
const { db, MEALS, settings, saveSettings, UPLOAD_DIR, DEFAULT_SETTINGS } = require('./db');
const { hashPassword, verifyPassword, parseCookies, newToken } = require('./auth');
const T = require('./time');

const app = express();
app.use(express.json({ limit: '12mb' }));

// ---------- static files (all served locally, no internet needed) ----------
const ROOT = path.join(__dirname, '..');
const nm = (p) => path.join(ROOT, 'node_modules', p);
app.use('/vendor/bootstrap', express.static(nm('bootstrap/dist')));
app.use('/vendor/chart', express.static(nm('chart.js/dist')));
app.use('/vendor/faceapi', express.static(nm('@vladmandic/face-api/dist')));
app.use('/models', express.static(nm('@vladmandic/face-api/model')));
app.use('/vendor/jsqr', express.static(nm('jsqr/dist')));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

// ---------- helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };
const wrap = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (e) { next(e); }
};
const num = (v, def = 0) => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? def : Number(v));
const cleanStr = (v, max = 500) => String(v ?? '').trim().slice(0, max);
const checkMeal = (meal) => { if (!MEALS.includes(meal)) fail(400, 'Unknown meal session'); return meal; };
const checkDate = (d) => { if (!T.isDate(d)) fail(400, 'Invalid date'); return d; };

function mealWindow(date, meal, s = settings()) {
  const t = s.meal_times[meal];
  return { start: T.at(date, t.start), end: T.at(date, t.end) };
}
function bookingDeadline(date, meal, s = settings()) {
  const { start } = mealWindow(date, meal, s);
  return new Date(start.getTime() - s.booking_cutoff_hours * 3600 * 1000);
}
function mealEnded(date, meal, s = settings()) {
  return mealWindow(date, meal, s).end <= new Date();
}
// The meal the gate is serving right now (opens 30 min early for queueing).
function currentMeal(now = new Date(), s = settings()) {
  const date = T.localDate(now);
  for (const meal of MEALS) {
    const { start, end } = mealWindow(date, meal, s);
    if (now >= new Date(start.getTime() - 30 * 60000) && now <= end) return { date, meal };
  }
  return null;
}
function onLeave(userId, date) {
  return !!db.prepare('SELECT 1 FROM leaves WHERE user_id = ? AND from_date <= ? AND to_date >= ?').get(userId, date, date);
}
function publicUser(u) {
  if (!u) return null;
  const faces = db.prepare('SELECT COUNT(*) c FROM face_embeddings WHERE user_id = ?').get(u.id).c;
  return { id: u.id, name: u.name, email: u.email, roll_no: u.roll_no, role: u.role, face_enrolled: faces > 0 };
}

// ---------- live updates (Server-Sent Events) for the admin dashboard ----------
const streams = new Set();
function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of streams) res.write(msg);
}

// ---------- auth middleware ----------
const COOKIE = 'ww_token';
app.use((req, res, next) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    req.user = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?').get(token) || null;
    req.token = token;
  }
  next();
});
const requireAuth = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'Please log in' }));
const requireAdmin = (req, res, next) =>
  req.user && req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access only' });
// The gate scanner can be a logged-in admin browser, or any device that sends the scanner key.
const requireScanner = (req, res, next) => {
  if (req.user && req.user.role === 'admin') return next();
  if (req.headers['x-scanner-key'] && req.headers['x-scanner-key'] === settings().scanner_key) return next();
  res.status(403).json({ error: 'Scanner not authorised. Log in as admin or send X-Scanner-Key.' });
};

function startSession(res, userId) {
  const token = newToken();
  db.prepare('INSERT INTO sessions(token, user_id) VALUES(?, ?)').run(token, userId);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`);
}

// ---------- face matching ----------
function parseDescriptor(d) {
  if (!Array.isArray(d) || d.length !== 128 || d.some((x) => typeof x !== 'number' || !isFinite(x))) {
    fail(400, 'Invalid face descriptor');
  }
  return d;
}
function distance(a, b) {
  let s = 0;
  for (let i = 0; i < 128; i++) { const x = a[i] - b[i]; s += x * x; }
  return Math.sqrt(s);
}
function bestMatch(descriptor, excludeUserId = null) {
  const rows = db.prepare(`SELECT f.user_id, f.descriptor, u.name, u.roll_no, u.email FROM face_embeddings f JOIN users u ON u.id = f.user_id`).all();
  let best = null;
  for (const r of rows) {
    if (r.user_id === excludeUserId) continue;
    const dist = distance(descriptor, JSON.parse(r.descriptor));
    if (!best || dist < best.distance) best = { ...r, distance: dist };
  }
  return best;
}
function saveFaces(userId, descriptors) {
  if (!Array.isArray(descriptors) || descriptors.length < 1 || descriptors.length > 10) fail(400, 'Send 1 to 10 face samples');
  const list = descriptors.map(parseDescriptor);
  const threshold = settings().face_match_threshold;
  for (const d of list) {
    const other = bestMatch(d, userId);
    if (other && other.distance < threshold - 0.05) {
      fail(409, `This face already looks registered to another account (${other.name}). Ask the admin if this is a mistake.`);
    }
  }
  db.prepare('DELETE FROM face_embeddings WHERE user_id = ?').run(userId);
  const ins = db.prepare('INSERT INTO face_embeddings(user_id, descriptor) VALUES(?, ?)');
  for (const d of list) ins.run(userId, JSON.stringify(d.map((x) => Math.round(x * 1e6) / 1e6)));
}

// ======================= AUTH =======================
app.post('/api/auth/register', wrap((req, res) => {
  const s = settings();
  const name = cleanStr(req.body.name, 100);
  const email = cleanStr(req.body.email, 200).toLowerCase();
  const roll = cleanStr(req.body.roll_no, 40).toUpperCase();
  const password = String(req.body.password || '');
  if (!name || !email || !roll) fail(400, 'Name, college email and roll number are required');
  if (!email.endsWith('@' + s.email_domain)) fail(400, `Only @${s.email_domain} email addresses can register`);
  if (password.length < 6) fail(400, 'Password must be at least 6 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) fail(409, 'An account with this email already exists');
  db.exec('BEGIN');
  try {
    const r = db.prepare("INSERT INTO users(name, email, roll_no, password_hash, role) VALUES(?,?,?,?, 'student')")
      .run(name, email, roll, hashPassword(password));
    const id = Number(r.lastInsertRowid);
    if (req.body.descriptors && req.body.descriptors.length) saveFaces(id, req.body.descriptors);
    db.exec('COMMIT');
    startSession(res, id);
    res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)) });
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}));

app.post('/api/auth/login', wrap((req, res) => {
  const email = cleanStr(req.body.email, 200).toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !verifyPassword(String(req.body.password || ''), u.password_hash)) fail(401, 'Wrong email or password');
  if (req.body.role === 'admin' && u.role !== 'admin') fail(403, 'This account is not an admin account');
  startSession(res, u.id);
  res.json({ user: publicUser(u) });
}));

app.post('/api/auth/logout', (req, res) => {
  if (req.token) db.prepare('DELETE FROM sessions WHERE token = ?').run(req.token);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => res.json({ user: publicUser(req.user) }));

// ======================= STUDENT =======================
app.put('/api/profile', requireAuth, wrap((req, res) => {
  const name = cleanStr(req.body.name, 100);
  const roll = cleanStr(req.body.roll_no, 40).toUpperCase();
  if (!name) fail(400, 'Name is required');
  db.prepare('UPDATE users SET name = ?, roll_no = ? WHERE id = ?').run(name, roll || req.user.roll_no, req.user.id);
  if (req.body.new_password) {
    if (!verifyPassword(String(req.body.current_password || ''), req.user.password_hash)) fail(400, 'Current password is wrong');
    if (String(req.body.new_password).length < 6) fail(400, 'New password must be at least 6 characters');
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(String(req.body.new_password)), req.user.id);
  }
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
}));

app.post('/api/face/enroll', requireAuth, wrap((req, res) => {
  saveFaces(req.user.id, req.body.descriptors);
  res.json({ ok: true, user: publicUser(req.user) });
}));

app.get('/api/config', (req, res) => {
  const s = settings();
  res.json({ meals: MEALS, meal_times: s.meal_times, booking_cutoff_hours: s.booking_cutoff_hours, booking_days_ahead: s.booking_days_ahead, email_domain: s.email_domain, guest_price: s.guest_price, face_match_threshold: s.face_match_threshold });
});

app.get('/api/menu', (req, res) => {
  res.json({ menu: db.prepare('SELECT day, meal, items FROM menu ORDER BY day').all() });
});

// Meal sessions for the next N days with the student's booking status.
app.get('/api/meals', requireAuth, wrap((req, res) => {
  const s = settings();
  const today = T.localDate();
  const days = Math.min(num(req.query.days, s.booking_days_ahead), 14);
  const now = new Date();
  const menu = {};
  for (const m of db.prepare('SELECT * FROM menu').all()) menu[`${m.day}|${m.meal}`] = m.items;
  const out = [];
  for (let i = 0; i < days; i++) {
    const date = T.addDays(today, i);
    const leave = onLeave(req.user.id, date);
    const sessions = MEALS.map((meal) => {
      const b = db.prepare('SELECT status FROM bookings WHERE user_id = ? AND date = ? AND meal = ?').get(req.user.id, date, meal);
      const att = db.prepare('SELECT created_at FROM attendance WHERE user_id = ? AND date = ? AND meal = ?').get(req.user.id, date, meal);
      const deadline = bookingDeadline(date, meal, s);
      const { end } = mealWindow(date, meal, s);
      return {
        meal, ...s.meal_times[meal],
        items: menu[`${T.weekday(date)}|${meal}`] || '',
        booked: b?.status === 'booked',
        status: leave ? 'leave' : (b?.status || 'none'),
        attended: !!att, attended_at: att?.created_at || null,
        open: !leave && now < deadline,
        deadline: T.localDateTime(deadline),
        ended: now > end,
      };
    });
    out.push({ date, weekday: T.weekday(date), on_leave: leave, sessions });
  }
  res.json({ days: out, cutoff_hours: s.booking_cutoff_hours });
}));

app.post('/api/bookings', requireAuth, wrap((req, res) => {
  const date = checkDate(req.body.date);
  const meal = checkMeal(req.body.meal);
  const action = req.body.action === 'cancel' ? 'cancel' : 'book';
  const s = settings();
  if (new Date() >= bookingDeadline(date, meal, s)) fail(400, `Booking for ${meal} closed ${s.booking_cutoff_hours} hours before the meal`);
  if (date > T.addDays(T.localDate(), s.booking_days_ahead)) fail(400, `You can only book up to ${s.booking_days_ahead} days ahead`);
  if (onLeave(req.user.id, date)) fail(400, 'You are on leave for this date. Remove the leave first.');
  db.prepare(`INSERT INTO bookings(user_id, date, meal, status) VALUES(?,?,?,?)
    ON CONFLICT(user_id, date, meal) DO UPDATE SET status = excluded.status, created_at = datetime('now','localtime')`)
    .run(req.user.id, date, meal, action === 'book' ? 'booked' : 'cancelled');
  broadcast('update', { type: 'booking' });
  res.json({ ok: true });
}));

app.get('/api/leaves', requireAuth, (req, res) => {
  res.json({ leaves: db.prepare('SELECT * FROM leaves WHERE user_id = ? ORDER BY from_date DESC').all(req.user.id) });
});
app.post('/api/leaves', requireAuth, wrap((req, res) => {
  const from = checkDate(req.body.from_date);
  const to = checkDate(req.body.to_date);
  if (to < from) fail(400, '"To" date must be on or after "From" date');
  if (to < T.localDate()) fail(400, 'Leave must include today or a future date');
  db.prepare('INSERT INTO leaves(user_id, from_date, to_date) VALUES(?,?,?)').run(req.user.id, from, to);
  // Auto-cancel bookings in this range that have not closed yet, so the kitchen stops counting them.
  const s = settings();
  const now = new Date();
  for (const b of db.prepare("SELECT * FROM bookings WHERE user_id = ? AND date BETWEEN ? AND ? AND status = 'booked'").all(req.user.id, from, to)) {
    if (now < mealWindow(b.date, b.meal, s).start) db.prepare("UPDATE bookings SET status = 'leave' WHERE id = ?").run(b.id);
  }
  broadcast('update', { type: 'leave' });
  res.json({ ok: true });
}));
app.delete('/api/leaves/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM leaves WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

// ---- guest passes ----
function passView(p) {
  const today = T.localDate();
  let status = p.status;
  if (status === 'active' && (p.date < today || mealEnded(p.date, p.meal))) status = 'expired';
  return { ...p, status, qr_text: `WWGUEST:${p.code}` };
}
app.get('/api/guest-passes', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM guest_passes WHERE requested_by = ? ORDER BY date DESC, id DESC').all(req.user.id);
  res.json({ passes: rows.map(passView) });
});
app.post('/api/guest-passes', requireAuth, wrap((req, res) => {
  const date = checkDate(req.body.date);
  const meal = checkMeal(req.body.meal);
  const guest = cleanStr(req.body.guest_name, 100);
  if (!guest) fail(400, 'Guest name is required');
  if (mealEnded(date, meal)) fail(400, 'That meal session is already over');
  const code = crypto.randomBytes(5).toString('hex').toUpperCase();
  db.prepare('INSERT INTO guest_passes(code, requested_by, guest_name, date, meal, amount) VALUES(?,?,?,?,?,?)')
    .run(code, req.user.id, guest, date, meal, settings().guest_price);
  broadcast('update', { type: 'guest' });
  res.json({ ok: true, code });
}));
app.delete('/api/guest-passes/:id', requireAuth, (req, res) => {
  db.prepare("UPDATE guest_passes SET status = 'cancelled' WHERE id = ? AND requested_by = ? AND status = 'active'").run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});
app.get('/api/guest-passes/:id/qr', requireAuth, wrap(async (req, res) => {
  const p = db.prepare('SELECT * FROM guest_passes WHERE id = ?').get(Number(req.params.id));
  if (!p || (p.requested_by !== req.user.id && req.user.role !== 'admin')) fail(404, 'Pass not found');
  const png = await QRCode.toBuffer(`WWGUEST:${p.code}`, { width: 360, margin: 2 });
  res.type('png').send(png);
}));

// ---- complaints ----
function savePhoto(dataUrl) {
  if (!dataUrl) return null;
  const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl);
  if (!m) fail(400, 'Photo must be a PNG, JPG or WEBP image');
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) fail(400, 'Photo is too large (max 8 MB)');
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${m[1] === 'jpeg' ? 'jpg' : m[1]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  return name;
}
app.get('/api/complaints', requireAuth, (req, res) => {
  res.json({ complaints: db.prepare('SELECT * FROM complaints WHERE user_id = ? ORDER BY id DESC').all(req.user.id) });
});
app.post('/api/complaints', requireAuth, wrap((req, res) => {
  const category = cleanStr(req.body.category, 40) || 'Other';
  const message = cleanStr(req.body.message, 2000);
  if (!message) fail(400, 'Please describe the issue');
  const photo = savePhoto(req.body.photo);
  db.prepare('INSERT INTO complaints(user_id, category, message, photo) VALUES(?,?,?,?)').run(req.user.id, category, message, photo);
  broadcast('update', { type: 'complaint' });
  res.json({ ok: true });
}));
app.get('/uploads/:file', requireAuth, (req, res) => {
  const file = path.basename(req.params.file);
  const c = db.prepare('SELECT user_id FROM complaints WHERE photo = ?').get(file);
  if (!c || (c.user_id !== req.user.id && req.user.role !== 'admin')) return res.status(404).end();
  res.sendFile(path.join(UPLOAD_DIR, file));
});

app.get('/api/announcements', (req, res) => {
  res.json({ announcements: db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 30').all() });
});

// Reminders shown in the portal (and as browser notifications while it is open).
app.get('/api/notifications', requireAuth, wrap((req, res) => {
  const s = settings();
  const now = new Date();
  const today = T.localDate(now);
  const out = [];
  for (const meal of MEALS) {
    const { start, end } = mealWindow(today, meal, s);
    const deadline = bookingDeadline(today, meal, s);
    const b = db.prepare('SELECT status FROM bookings WHERE user_id = ? AND date = ? AND meal = ?').get(req.user.id, today, meal);
    const att = db.prepare('SELECT 1 FROM attendance WHERE user_id = ? AND date = ? AND meal = ?').get(req.user.id, today, meal);
    const minsToEnd = (end - now) / 60000;
    const minsToDeadline = (deadline - now) / 60000;
    if (b?.status === 'booked' && !att && now >= start && minsToEnd > 0 && minsToEnd <= 30) {
      out.push({ id: `end-${today}-${meal}`, kind: 'warning', title: `${meal} ends in ${Math.ceil(minsToEnd)} min`, body: `You booked ${meal} but haven't checked in yet. Please come soon or your plate counts as a no-show.` });
    }
    if (b?.status !== 'booked' && minsToDeadline > 0 && minsToDeadline <= 60 && !onLeave(req.user.id, today)) {
      out.push({ id: `close-${today}-${meal}`, kind: 'info', title: `${meal} booking closes in ${Math.ceil(minsToDeadline)} min`, body: `Book now if you plan to eat ${meal} today.` });
    }
  }
  const ann = db.prepare('SELECT * FROM announcements ORDER BY id DESC LIMIT 5').all()
    .map((a) => ({ id: `ann-${a.id}`, kind: a.kind, title: a.title, body: a.body, created_at: a.created_at }));
  res.json({ reminders: out, announcements: ann });
}));

app.get('/api/stats/me', requireAuth, wrap((req, res) => {
  const s = settings();
  const bookings = db.prepare("SELECT date, meal, status FROM bookings WHERE user_id = ? AND status = 'booked' ORDER BY date DESC").all(req.user.id);
  const attended = new Set(db.prepare('SELECT date, meal FROM attendance WHERE user_id = ?').all(req.user.id).map((a) => `${a.date}|${a.meal}`));
  let noShows = 0, past = 0;
  const history = bookings.slice(0, 60).map((b) => {
    const ended = mealEnded(b.date, b.meal, s);
    const att = attended.has(`${b.date}|${b.meal}`);
    return { ...b, attended: att, result: att ? 'attended' : ended ? 'no-show' : 'upcoming' };
  });
  for (const b of bookings) {
    if (!mealEnded(b.date, b.meal, s)) continue;
    past++;
    if (!attended.has(`${b.date}|${b.meal}`)) noShows++;
  }
  res.json({
    total_booked: bookings.length, meals_attended: attended.size, no_shows: noShows,
    attendance_rate: past ? Math.round(((past - noShows) / past) * 100) : null,
    guest_passes: db.prepare('SELECT COUNT(*) c FROM guest_passes WHERE requested_by = ?').get(req.user.id).c,
    history,
  });
}));

// ======================= SCANNER (gate) =======================
function logScan(entry) {
  // A person standing at the gate gets scanned every few seconds; log a repeated result only once.
  const recent = db.prepare(`SELECT 1 FROM scan_log WHERE ts >= datetime('now','localtime','-15 seconds')
    AND result = ? AND IFNULL(user_id, 0) = ? AND IFNULL(meal, '') = ? AND IFNULL(label, '') = ?`)
    .get(entry.result, entry.user_id || 0, entry.meal || '', entry.label || '');
  if (recent && entry.result !== 'granted') return entry;
  db.prepare('INSERT INTO scan_log(date, meal, result, reason, user_id, label, distance) VALUES(?,?,?,?,?,?,?)')
    .run(entry.date || null, entry.meal || null, entry.result, entry.reason || null, entry.user_id || null, entry.label || null, entry.distance ?? null);
  broadcast('scan', entry);
  return entry;
}
function resolveSession(body) {
  if (body.meal && body.meal !== 'auto') return { date: T.isDate(body.date) ? body.date : T.localDate(), meal: checkMeal(body.meal) };
  return currentMeal();
}

app.get('/api/scanner/status', requireScanner, wrap((req, res) => {
  const cur = currentMeal();
  const sess = resolveSession({ meal: req.query.meal, date: req.query.date });
  let session = null;
  if (sess) {
    const booked = db.prepare("SELECT COUNT(*) c FROM bookings WHERE date = ? AND meal = ? AND status = 'booked'").get(sess.date, sess.meal).c;
    const guests = db.prepare("SELECT COUNT(*) c FROM guest_passes WHERE date = ? AND meal = ? AND status IN ('active','used')").get(sess.date, sess.meal).c;
    const inNow = db.prepare('SELECT COUNT(*) c FROM attendance WHERE date = ? AND meal = ?').get(sess.date, sess.meal).c;
    session = { ...sess, expected: booked + guests, checked_in: inNow };
  }
  const recent = db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 15').all();
  const faces = db.prepare('SELECT COUNT(DISTINCT user_id) c FROM face_embeddings').get().c;
  res.json({ current: cur, session, enrolled_faces: faces, recent, meals: MEALS, threshold: settings().face_match_threshold });
}));

// Scanner sends a 128-number face descriptor computed in the browser; the server finds the student.
app.post('/api/scanner/identify', requireScanner, wrap((req, res) => {
  const descriptor = parseDescriptor(req.body.descriptor);
  const sess = resolveSession(req.body);
  if (!sess) return res.json(logScan({ result: 'denied', reason: 'No meal session is open right now', label: 'Unknown' }));
  const { date, meal } = sess;
  const match = bestMatch(descriptor);
  const threshold = settings().face_match_threshold;
  if (!match || match.distance > threshold) {
    return res.json(logScan({ date, meal, result: 'denied', reason: 'Face not recognised. Please register first or contact the admin.', label: 'Unregistered', distance: match?.distance }));
  }
  const who = { user_id: match.user_id, label: match.name, roll_no: match.roll_no, distance: Math.round(match.distance * 1000) / 1000, date, meal };
  if (db.prepare('SELECT 1 FROM attendance WHERE user_id = ? AND date = ? AND meal = ?').get(match.user_id, date, meal)) {
    return res.json(logScan({ ...who, result: 'duplicate', reason: `Already checked in for ${meal}` }));
  }
  const booking = db.prepare('SELECT status FROM bookings WHERE user_id = ? AND date = ? AND meal = ?').get(match.user_id, date, meal);
  if (!booking || booking.status !== 'booked') {
    return res.json(logScan({ ...who, result: 'denied', reason: `No ${meal} booking found. Please contact the mess admin.` }));
  }
  db.prepare("INSERT INTO attendance(user_id, date, meal, method) VALUES(?,?,?,'face')").run(match.user_id, date, meal);
  res.json(logScan({ ...who, result: 'granted', reason: `Booking verified for ${meal}. Enjoy your meal!` }));
}));

app.post('/api/scanner/guest', requireScanner, wrap((req, res) => {
  const code = cleanStr(req.body.code, 100).toUpperCase().replace(/^WWGUEST:/, '');
  const sess = resolveSession(req.body);
  const p = db.prepare('SELECT * FROM guest_passes WHERE code = ?').get(code);
  if (!p) return res.json(logScan({ ...(sess || {}), result: 'denied', reason: 'Invalid guest pass', label: 'Guest' }));
  const label = `Guest: ${p.guest_name}`;
  if (p.status === 'used') return res.json(logScan({ ...(sess || {}), result: 'duplicate', reason: 'This guest pass was already used', label }));
  if (p.status === 'cancelled') return res.json(logScan({ ...(sess || {}), result: 'denied', reason: 'This guest pass was cancelled', label }));
  if (!sess) return res.json(logScan({ result: 'denied', reason: 'No meal session is open right now', label }));
  if (p.date !== sess.date || p.meal !== sess.meal) {
    return res.json(logScan({ ...sess, result: 'denied', reason: `Pass is for ${p.meal} on ${p.date}`, label }));
  }
  db.prepare("UPDATE guest_passes SET status = 'used', used_at = datetime('now','localtime') WHERE id = ?").run(p.id);
  db.prepare("INSERT INTO attendance(guest_pass_id, date, meal, method) VALUES(?,?,?,'qr')").run(p.id, sess.date, sess.meal);
  const payNote = p.paid ? 'Paid.' : `Collect ₹${p.amount} at the counter.`;
  res.json(logScan({ ...sess, result: 'granted', reason: `Guest pass valid. ${payNote}`, label }));
}));

// Optional IR beam sensor at the door (see hardware/ folder). Each beam break posts one event.
app.post('/api/sensor/ir', requireScanner, wrap((req, res) => {
  const direction = req.body.direction === 'out' ? 'out' : 'in';
  const cur = currentMeal();
  db.prepare('INSERT INTO ir_events(date, meal, direction) VALUES(?,?,?)').run(T.localDate(), req.body.meal || cur?.meal || null, direction);
  broadcast('update', { type: 'ir' });
  res.json({ ok: true });
}));

// ======================= ADMIN =======================
const admin = express.Router();
admin.use(requireAdmin);

function mealSummary(date, meal, s = settings()) {
  const booked = db.prepare("SELECT COUNT(*) c FROM bookings WHERE date = ? AND meal = ? AND status = 'booked'").get(date, meal).c;
  const guests = db.prepare("SELECT COUNT(*) c FROM guest_passes WHERE date = ? AND meal = ? AND status IN ('active','used')").get(date, meal).c;
  const att = db.prepare('SELECT SUM(user_id IS NOT NULL) st, SUM(guest_pass_id IS NOT NULL) gu FROM attendance WHERE date = ? AND meal = ?').get(date, meal);
  const noShows = db.prepare(`SELECT COUNT(*) c FROM bookings b WHERE b.date = ? AND b.meal = ? AND b.status = 'booked'
    AND NOT EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = b.user_id AND a.date = b.date AND a.meal = b.meal)`).get(date, meal).c;
  const ir = db.prepare("SELECT SUM(direction = 'in') i, SUM(direction = 'out') o FROM ir_events WHERE date = ? AND meal = ?").get(date, meal);
  const waste = db.prepare('SELECT * FROM waste_logs WHERE date = ? AND meal = ?').get(date, meal) || null;
  const expected = booked + guests;
  const actual = (att.st || 0) + (att.gu || 0);
  const ended = mealEnded(date, meal, s);
  return {
    date, meal, ...s.meal_times[meal], ended,
    expected, booked, guests_expected: guests,
    actual, actual_students: att.st || 0, actual_guests: att.gu || 0,
    no_shows: ended ? noShows : null, pending: ended ? 0 : noShows,
    ir_in: ir.i || 0, ir_out: ir.o || 0,
    leftover_estimate_kg: ended ? Math.round(Math.max(0, expected - actual) * s.plate_kg * 10) / 10 : null,
    waste,
  };
}

admin.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('event: hello\ndata: {}\n\n');
  streams.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => { clearInterval(ping); streams.delete(res); });
});

admin.get('/live', wrap((req, res) => {
  const date = T.isDate(req.query.date) ? req.query.date : T.localDate();
  const s = settings();
  const meals = MEALS.map((m) => mealSummary(date, m, s));
  const students = db.prepare("SELECT COUNT(*) c FROM users WHERE role = 'student'").get().c;
  const onLeave = db.prepare("SELECT COUNT(DISTINCT user_id) c FROM leaves WHERE from_date <= ? AND to_date >= ?").get(date, date).c;
  const recent = db.prepare('SELECT * FROM scan_log ORDER BY id DESC LIMIT 20').all();
  const openComplaints = db.prepare("SELECT COUNT(*) c FROM complaints WHERE status != 'resolved'").get().c;
  res.json({ date, current: currentMeal(), meals, students, on_leave: onLeave, recent, open_complaints: openComplaints });
}));

admin.get('/bookings', wrap((req, res) => {
  const date = checkDate(req.query.date || T.localDate());
  const meal = checkMeal(req.query.meal || 'Lunch');
  const rows = db.prepare(`SELECT u.id, u.name, u.roll_no, u.email, b.status,
      (SELECT a.created_at FROM attendance a WHERE a.user_id = u.id AND a.date = b.date AND a.meal = b.meal) AS checked_in_at
    FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.date = ? AND b.meal = ? AND b.status = 'booked' ORDER BY u.name`).all(date, meal);
  const walkins = db.prepare(`SELECT u.id, u.name, u.roll_no, a.method, a.created_at FROM attendance a JOIN users u ON u.id = a.user_id
    WHERE a.date = ? AND a.meal = ? AND NOT EXISTS (SELECT 1 FROM bookings b WHERE b.user_id = a.user_id AND b.date = a.date AND b.meal = a.meal AND b.status = 'booked')`).all(date, meal);
  res.json({ date, meal, rows, walkins });
}));

// Manual check-in for edge cases (forgot to book, face not matching, etc.).
admin.post('/checkin', wrap((req, res) => {
  const q = cleanStr(req.body.who, 200);
  const date = checkDate(req.body.date || T.localDate());
  const meal = checkMeal(req.body.meal);
  const u = db.prepare("SELECT * FROM users WHERE role = 'student' AND (lower(email) = lower(?) OR upper(roll_no) = upper(?))").get(q, q);
  if (!u) fail(404, 'No student with that email or roll number');
  if (req.body.add_booking) {
    db.prepare(`INSERT INTO bookings(user_id, date, meal, status) VALUES(?,?,?,'booked') ON CONFLICT(user_id, date, meal) DO UPDATE SET status = 'booked'`).run(u.id, date, meal);
  }
  if (db.prepare('SELECT 1 FROM attendance WHERE user_id = ? AND date = ? AND meal = ?').get(u.id, date, meal)) fail(409, `${u.name} is already checked in`);
  db.prepare("INSERT INTO attendance(user_id, date, meal, method) VALUES(?,?,?,'manual')").run(u.id, date, meal);
  logScan({ date, meal, result: 'granted', reason: 'Manual check-in by admin', user_id: u.id, label: u.name });
  res.json({ ok: true, name: u.name });
}));

admin.get('/guest-passes', (req, res) => {
  const rows = db.prepare(`SELECT g.*, u.name AS requested_by_name, u.roll_no FROM guest_passes g JOIN users u ON u.id = g.requested_by ORDER BY g.date DESC, g.id DESC LIMIT 300`).all();
  const passes = rows.map(passView);
  const collected = passes.filter((p) => p.paid).reduce((a, p) => a + p.amount, 0);
  const due = passes.filter((p) => !p.paid && p.status === 'used').reduce((a, p) => a + p.amount, 0);
  res.json({ passes, collected, due });
});
admin.post('/guest-passes/:id/pay', wrap((req, res) => {
  const mode = ['Cash', 'UPI', 'Card', 'Mess account'].includes(req.body.mode) ? req.body.mode : 'Cash';
  db.prepare("UPDATE guest_passes SET paid = 1, payment_mode = ?, paid_at = datetime('now','localtime') WHERE id = ?").run(mode, Number(req.params.id));
  res.json({ ok: true });
}));
admin.post('/guest-passes/:id/cancel', (req, res) => {
  db.prepare("UPDATE guest_passes SET status = 'cancelled' WHERE id = ? AND status = 'active'").run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- waste + biogas + slurry ----
admin.get('/waste', (req, res) => {
  const s = settings();
  const rows = db.prepare('SELECT * FROM waste_logs ORDER BY date DESC, id DESC LIMIT 200').all()
    .map((w) => ({ ...w, biogas_m3: Math.round(w.sent_to_biogas_kg * s.biogas_m3_per_kg * 100) / 100 }));
  res.json({ rows });
});
admin.post('/waste', wrap((req, res) => {
  const date = checkDate(req.body.date);
  const meal = checkMeal(req.body.meal);
  const wasted = num(req.body.wasted_kg, -1);
  if (wasted < 0) fail(400, 'Enter the wasted quantity in kg');
  const toBiogas = req.body.sent_to_biogas_kg === '' || req.body.sent_to_biogas_kg == null ? wasted : num(req.body.sent_to_biogas_kg);
  db.prepare(`INSERT INTO waste_logs(date, meal, prepared_kg, wasted_kg, sent_to_biogas_kg, notes) VALUES(?,?,?,?,?,?)
    ON CONFLICT(date, meal) DO UPDATE SET prepared_kg = excluded.prepared_kg, wasted_kg = excluded.wasted_kg, sent_to_biogas_kg = excluded.sent_to_biogas_kg, notes = excluded.notes`)
    .run(date, meal, num(req.body.prepared_kg), wasted, Math.min(toBiogas, wasted), cleanStr(req.body.notes));
  broadcast('update', { type: 'waste' });
  res.json({ ok: true });
}));
admin.delete('/waste/:id', (req, res) => { db.prepare('DELETE FROM waste_logs WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

admin.get('/slurry', (req, res) => {
  res.json({ rows: db.prepare('SELECT * FROM slurry_logs ORDER BY date DESC, id DESC LIMIT 200').all(), ...sustainabilityTotals() });
});
admin.post('/slurry', wrap((req, res) => {
  const date = checkDate(req.body.date);
  const q = num(req.body.quantity_kg, -1);
  if (q <= 0) fail(400, 'Enter the slurry quantity in kg');
  const usedFor = cleanStr(req.body.used_for, 200);
  if (!usedFor) fail(400, 'Say where the slurry was used (e.g. campus garden)');
  db.prepare('INSERT INTO slurry_logs(date, quantity_kg, used_for, notes) VALUES(?,?,?,?)').run(date, q, usedFor, cleanStr(req.body.notes));
  res.json({ ok: true });
}));
admin.delete('/slurry/:id', (req, res) => { db.prepare('DELETE FROM slurry_logs WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

// ---- announcements ----
admin.post('/announcements', wrap((req, res) => {
  const title = cleanStr(req.body.title, 120);
  const body = cleanStr(req.body.body, 2000);
  const kind = ['info', 'warning', 'special', 'closure', 'menu'].includes(req.body.kind) ? req.body.kind : 'info';
  if (!title || !body) fail(400, 'Title and message are required');
  db.prepare('INSERT INTO announcements(title, body, kind) VALUES(?,?,?)').run(title, body, kind);
  res.json({ ok: true });
}));
admin.delete('/announcements/:id', (req, res) => { db.prepare('DELETE FROM announcements WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });

// ---- complaints ----
admin.get('/complaints', (req, res) => {
  res.json({ complaints: db.prepare('SELECT c.*, u.name, u.roll_no FROM complaints c JOIN users u ON u.id = c.user_id ORDER BY (c.status = \'resolved\'), c.id DESC').all() });
});
admin.put('/complaints/:id', wrap((req, res) => {
  const status = ['open', 'in_progress', 'resolved'].includes(req.body.status) ? req.body.status : fail(400, 'Bad status');
  db.prepare("UPDATE complaints SET status = ?, admin_note = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(status, cleanStr(req.body.admin_note, 1000), Number(req.params.id));
  res.json({ ok: true });
}));

// ---- menu + settings ----
admin.put('/menu', wrap((req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : fail(400, 'Bad menu');
  const up = db.prepare('INSERT INTO menu(day, meal, items) VALUES(?,?,?) ON CONFLICT(day, meal) DO UPDATE SET items = excluded.items');
  for (const it of items) {
    const day = num(it.day, -1);
    if (day < 0 || day > 6) continue;
    up.run(day, checkMeal(it.meal), cleanStr(it.items, 300));
  }
  res.json({ ok: true });
}));
admin.get('/settings', (req, res) => res.json({ settings: settings(), defaults: DEFAULT_SETTINGS }));
admin.put('/settings', wrap((req, res) => {
  const b = req.body || {};
  const out = {};
  if (b.meal_times) {
    out.meal_times = {};
    for (const m of MEALS) {
      const t = b.meal_times[m];
      if (!t || !/^\d{2}:\d{2}$/.test(t.start) || !/^\d{2}:\d{2}$/.test(t.end) || t.end <= t.start) fail(400, `Check the times for ${m}`);
      out.meal_times[m] = { start: t.start, end: t.end };
    }
  }
  for (const k of ['booking_cutoff_hours', 'booking_days_ahead', 'plate_kg', 'guest_price', 'biogas_m3_per_kg', 'slurry_kg_per_kg', 'co2e_kg_per_kg', 'face_match_threshold']) {
    if (b[k] !== undefined) { const v = num(b[k], -1); if (v < 0) fail(400, `Bad value for ${k}`); out[k] = v; }
  }
  if (b.email_domain) out.email_domain = cleanStr(b.email_domain, 100).replace(/^@/, '').toLowerCase();
  if (b.scanner_key) out.scanner_key = cleanStr(b.scanner_key, 100);
  saveSettings(out);
  res.json({ ok: true, settings: settings() });
}));

// ---- students ----
admin.get('/students', (req, res) => {
  const s = settings();
  const rows = db.prepare(`SELECT u.id, u.name, u.email, u.roll_no, u.created_at,
      (SELECT COUNT(*) FROM face_embeddings f WHERE f.user_id = u.id) AS faces,
      (SELECT COUNT(*) FROM attendance a WHERE a.user_id = u.id) AS attended
    FROM users u WHERE u.role = 'student' ORDER BY u.name`).all();
  const noShow = noShowCounts(T.addDays(T.localDate(), -365), T.localDate(), s);
  res.json({ students: rows.map((r) => ({ ...r, booked: noShow.booked[r.id] || 0, no_shows: noShow.missed[r.id] || 0 })) });
});
admin.delete('/students/:id/face', (req, res) => { db.prepare('DELETE FROM face_embeddings WHERE user_id = ?').run(Number(req.params.id)); res.json({ ok: true }); });
admin.delete('/students/:id', (req, res) => {
  db.prepare("DELETE FROM users WHERE id = ? AND role = 'student'").run(Number(req.params.id));
  res.json({ ok: true });
});

// ---- analytics + reports ----
function noShowCounts(from, to, s) {
  const rows = db.prepare(`SELECT b.user_id, b.date, b.meal, EXISTS (SELECT 1 FROM attendance a WHERE a.user_id = b.user_id AND a.date = b.date AND a.meal = b.meal) AS att
    FROM bookings b WHERE b.status = 'booked' AND b.date BETWEEN ? AND ?`).all(from, to);
  const booked = {}, missed = {};
  for (const r of rows) {
    if (!mealEnded(r.date, r.meal, s)) continue;
    booked[r.user_id] = (booked[r.user_id] || 0) + 1;
    if (!r.att) missed[r.user_id] = (missed[r.user_id] || 0) + 1;
  }
  return { booked, missed, rows };
}

function rangeData(from, to) {
  const s = settings();
  const dates = T.dateRange(from, to);
  const key = (d, m) => `${d}|${m}`;
  const grp = (sql) => { const o = {}; for (const r of db.prepare(sql).all(from, to)) o[key(r.date, r.meal)] = r; return o; };
  const bk = grp("SELECT date, meal, COUNT(*) c FROM bookings WHERE status = 'booked' AND date BETWEEN ? AND ? GROUP BY date, meal");
  const gp = grp("SELECT date, meal, COUNT(*) c FROM guest_passes WHERE status IN ('active','used') AND date BETWEEN ? AND ? GROUP BY date, meal");
  const at = grp('SELECT date, meal, SUM(user_id IS NOT NULL) st, SUM(guest_pass_id IS NOT NULL) gu FROM attendance WHERE date BETWEEN ? AND ? GROUP BY date, meal');
  const ws = grp('SELECT date, meal, prepared_kg, wasted_kg, sent_to_biogas_kg FROM waste_logs WHERE date BETWEEN ? AND ?');
  const rows = [];
  for (const date of dates) for (const meal of MEALS) {
    const booked = bk[key(date, meal)]?.c || 0;
    const guests = gp[key(date, meal)]?.c || 0;
    const st = at[key(date, meal)]?.st || 0;
    const gu = at[key(date, meal)]?.gu || 0;
    const w = ws[key(date, meal)];
    const ended = mealEnded(date, meal, s);
    rows.push({
      date, weekday: T.weekday(date), meal, ended,
      expected: booked + guests, booked, guests, actual: st + gu, actual_students: st, actual_guests: gu,
      no_shows: ended ? Math.max(0, booked - st) : 0,
      leftover_estimate_kg: ended ? Math.round(Math.max(0, booked + guests - st - gu) * s.plate_kg * 10) / 10 : 0,
      prepared_kg: w?.prepared_kg ?? null, wasted_kg: w?.wasted_kg ?? null,
      biogas_m3: w ? Math.round(w.sent_to_biogas_kg * s.biogas_m3_per_kg * 100) / 100 : null,
    });
  }
  return { rows, s };
}

admin.get('/analytics', wrap((req, res) => {
  const days = Math.min(Math.max(num(req.query.days, 30), 7), 365);
  const to = T.localDate();
  const from = T.addDays(to, -(days - 1));
  const { rows, s } = rangeData(from, to);
  const byDate = {};
  for (const r of rows) {
    const d = (byDate[r.date] ||= { date: r.date, expected: 0, actual: 0, no_shows: 0, wasted_kg: 0, guests: 0, meals: {} });
    d.expected += r.expected; d.actual += r.actual; d.no_shows += r.no_shows; d.wasted_kg += r.wasted_kg || 0; d.guests += r.actual_guests;
    d.meals[r.meal] = { expected: r.expected, actual: r.actual };
  }
  const daily = Object.values(byDate).map((d) => ({ ...d, wasted_kg: Math.round(d.wasted_kg * 10) / 10, waste_per_plate_g: d.actual ? Math.round((d.wasted_kg / d.actual) * 1000) : null }));
  const weekdayNames = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const byWeekday = weekdayNames.map((n) => ({ day: n, booked: 0, no_shows: 0, actual: 0 }));
  const byMeal = MEALS.map((m) => ({ meal: m, booked: 0, no_shows: 0, actual: 0, guests: 0 }));
  for (const r of rows) {
    if (!r.ended) continue;
    const w = byWeekday[r.weekday]; w.booked += r.booked; w.no_shows += r.no_shows; w.actual += r.actual;
    const m = byMeal[MEALS.indexOf(r.meal)]; m.booked += r.booked; m.no_shows += r.no_shows; m.actual += r.actual; m.guests += r.actual_guests;
  }
  const ns = noShowCounts(from, to, s);
  const users = {};
  for (const u of db.prepare("SELECT id, name, roll_no FROM users WHERE role = 'student'").all()) users[u.id] = u;
  const topNoShow = Object.keys(ns.missed).map((id) => ({ ...users[id], no_shows: ns.missed[id], booked: ns.booked[id], rate: Math.round((ns.missed[id] / ns.booked[id]) * 100) }))
    .filter((x) => x.name).sort((a, b) => b.no_shows - a.no_shows || b.rate - a.rate).slice(0, 10);
  const guestRows = db.prepare("SELECT date, meal, COUNT(*) c FROM guest_passes WHERE status IN ('active','used') AND date BETWEEN ? AND ? GROUP BY date, meal").all(from, to);
  res.json({ from, to, daily, byWeekday, byMeal, topNoShow, guest_total: guestRows.reduce((a, r) => a + r.c, 0) });
}));

function reportData(from, to) {
  const { rows, s } = rangeData(from, to);
  const ended = rows.filter((r) => r.ended);
  const sum = (arr, k) => Math.round(arr.reduce((a, r) => a + (r[k] || 0), 0) * 100) / 100;
  const totals = {
    expected: sum(ended, 'expected'), actual: sum(ended, 'actual'), no_shows: sum(ended, 'no_shows'),
    guests: sum(ended, 'actual_guests'), prepared_kg: sum(rows, 'prepared_kg'), wasted_kg: sum(rows, 'wasted_kg'),
    biogas_m3: sum(rows, 'biogas_m3'), leftover_estimate_kg: sum(ended, 'leftover_estimate_kg'),
  };
  totals.accuracy_pct = totals.expected ? Math.round((Math.min(totals.actual, totals.expected) / totals.expected) * 1000) / 10 : null;
  totals.waste_per_plate_g = totals.actual ? Math.round((totals.wasted_kg / totals.actual) * 1000) : null;
  const meals = MEALS.map((m) => {
    const r = ended.filter((x) => x.meal === m);
    return { meal: m, expected: sum(r, 'expected'), actual: sum(r, 'actual'), no_shows: sum(r, 'no_shows'), wasted_kg: sum(r, 'wasted_kg') };
  });
  const complaints = db.prepare("SELECT status, COUNT(*) c FROM complaints WHERE date(created_at) BETWEEN ? AND ? GROUP BY status").all(from, to);
  const guestMoney = db.prepare("SELECT SUM(CASE WHEN paid = 1 THEN amount ELSE 0 END) paid, COUNT(*) n FROM guest_passes WHERE status IN ('active','used') AND date BETWEEN ? AND ?").get(from, to);
  const slurry = db.prepare('SELECT SUM(quantity_kg) q FROM slurry_logs WHERE date BETWEEN ? AND ?').get(from, to).q || 0;
  const ns = noShowCounts(from, to, s);
  const users = {};
  for (const u of db.prepare("SELECT id, name, roll_no FROM users WHERE role = 'student'").all()) users[u.id] = u;
  const topNoShow = Object.keys(ns.missed).map((id) => ({ ...users[id], no_shows: ns.missed[id], booked: ns.booked[id] })).filter((x) => x.name).sort((a, b) => b.no_shows - a.no_shows).slice(0, 10);
  return { from, to, rows, totals, meals, complaints, guest_passes: guestMoney.n || 0, guest_revenue: guestMoney.paid || 0, slurry_used_kg: Math.round(slurry * 10) / 10, topNoShow, plate_kg: s.plate_kg, co2e_avoided_kg: Math.round(totals.wasted_kg * s.co2e_kg_per_kg) };
}
function reportRange(q) {
  const to = T.isDate(q.to) ? q.to : T.localDate();
  let from = T.isDate(q.from) ? q.from : null;
  if (!from) from = T.addDays(to, q.period === 'month' ? -29 : -6);
  if (from > to) fail(400, '"From" must be before "To"');
  return { from, to };
}
admin.get('/report', wrap((req, res) => { const { from, to } = reportRange(req.query); res.json(reportData(from, to)); }));
admin.get('/report.csv', wrap((req, res) => {
  const { from, to } = reportRange(req.query);
  const { rows } = reportData(from, to);
  const head = ['date', 'meal', 'expected', 'booked', 'guests', 'actual', 'actual_students', 'actual_guests', 'no_shows', 'leftover_estimate_kg', 'prepared_kg', 'wasted_kg', 'biogas_m3'];
  const csv = [head.join(',')].concat(rows.map((r) => head.map((h) => r[h] ?? '').join(','))).join('\n');
  res.setHeader('Content-Disposition', `attachment; filename="wastewise-report-${from}-to-${to}.csv"`);
  res.type('text/csv').send(csv);
}));

app.use('/api/admin', admin);

// ======================= PUBLIC SUSTAINABILITY DASHBOARD =======================
function sustainabilityTotals() {
  const s = settings();
  const w = db.prepare('SELECT SUM(wasted_kg) wasted, SUM(sent_to_biogas_kg) bio, SUM(prepared_kg) prep, COUNT(*) n FROM waste_logs').get();
  const slurryUsed = db.prepare('SELECT SUM(quantity_kg) q FROM slurry_logs').get().q || 0;
  const biogas = (w.bio || 0) * s.biogas_m3_per_kg;
  const slurryProduced = (w.bio || 0) * s.slurry_kg_per_kg;
  return {
    wasted_kg: Math.round((w.wasted || 0) * 10) / 10,
    sent_to_biogas_kg: Math.round((w.bio || 0) * 10) / 10,
    biogas_m3: Math.round(biogas * 10) / 10,
    lpg_equiv_kg: Math.round(biogas * 0.43 * 10) / 10, // ~0.43 kg LPG per m3 of biogas
    slurry_produced_kg: Math.round(slurryProduced),
    slurry_used_kg: Math.round(slurryUsed * 10) / 10,
    co2e_avoided_kg: Math.round((w.bio || 0) * s.co2e_kg_per_kg),
  };
}
app.get('/api/public/sustainability', wrap((req, res) => {
  const s = settings();
  const to = T.localDate();
  const from = T.addDays(to, -29);
  const { rows } = rangeData(from, to);
  const meals = db.prepare('SELECT COUNT(*) c FROM attendance').get().c;
  const totals = sustainabilityTotals();
  // Weekly waste per plate, to show whether waste is going down over time.
  const weekly = db.prepare(`SELECT strftime('%Y-%W', date) wk, MIN(date) start, SUM(wasted_kg) wasted FROM waste_logs GROUP BY wk ORDER BY wk DESC LIMIT 12`).all().reverse()
    .map((w) => {
      const served = db.prepare('SELECT COUNT(*) c FROM attendance WHERE strftime(\'%Y-%W\', date) = ?').get(w.wk).c;
      return { week_of: w.start, wasted_kg: Math.round(w.wasted * 10) / 10, per_plate_g: served ? Math.round((w.wasted / served) * 1000) : null };
    });
  const daily = {};
  for (const r of rows) { const d = (daily[r.date] ||= { date: r.date, wasted_kg: 0, biogas_m3: 0 }); d.wasted_kg += r.wasted_kg || 0; d.biogas_m3 += r.biogas_m3 || 0; }
  const recentSlurry = db.prepare('SELECT date, quantity_kg, used_for FROM slurry_logs ORDER BY date DESC LIMIT 8').all();
  const first = weekly.find((w) => w.per_plate_g), last = [...weekly].reverse().find((w) => w.per_plate_g);
  const reduction = first && last && first !== last ? Math.round(((first.per_plate_g - last.per_plate_g) / first.per_plate_g) * 100) : null;
  res.json({ meals_served: meals, ...totals, waste_reduction_pct: reduction, weekly, daily: Object.values(daily).map((d) => ({ ...d, wasted_kg: Math.round(d.wasted_kg * 10) / 10, biogas_m3: Math.round(d.biogas_m3 * 100) / 100 })), recent_slurry: recentSlurry, factors: { biogas_m3_per_kg: s.biogas_m3_per_kg, slurry_kg_per_kg: s.slurry_kg_per_kg, co2e_kg_per_kg: s.co2e_kg_per_kg } });
}));

// ---------- errors ----------
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload is too large' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const PORT = Number(process.env.PORT) || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    console.log('\n  WasteWise Web is running');
    console.log(`  Student portal:   http://localhost:${PORT}`);
    console.log(`  Admin dashboard:  http://localhost:${PORT}/admin`);
    console.log(`  Face scanner:     http://localhost:${PORT}/scanner`);
    console.log(`  Public dashboard: http://localhost:${PORT}/sustainability`);
    if (lan) console.log(`  Other devices on the same Wi-Fi: http://${lan.address}:${PORT}  (booking works; camera needs localhost)`);
    console.log('\n  Default admin login: admin@rvce.edu.in / admin123');
    console.log('  Press Ctrl+C to stop.\n');
  });
}
module.exports = app;
