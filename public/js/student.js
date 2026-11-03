// Student portal logic.
const $ = (id) => document.getElementById(id);
const S = { user: null, config: null, days: [], selected: WW.today() };

async function init() {
  S.user = await WW.requireUser('student');
  if (!S.user) return;
  S.config = await WW.api('/api/config');
  $('guestPrice').textContent = `₹${S.config.guest_price}`;
  $('guestMeal').innerHTML = S.config.meals.map((m) => `<option>${m}</option>`).join('');
  document.querySelector('#guestForm [name=date]').value = WW.today();
  document.querySelector('#guestForm [name=date]').min = WW.today();
  renderUser();
  document.querySelectorAll('[data-nav]').forEach((b) => b.addEventListener('click', () => show(b.dataset.nav)));
  document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); show(g.dataset.goto); } });
  const tab = location.hash.slice(1);
  show(['home', 'menu', 'green', 'guest', 'profile'].includes(tab) ? tab : 'home');
  if (new URLSearchParams(location.search).get('welcome')) WW.toast('Welcome! Your account is ready. Book your first meal below.');
  loadMeals();
  pollNotifications();
  setInterval(pollNotifications, 60000);
  setInterval(loadMeals, 120000);
}

function renderUser() {
  $('hName').textContent = S.user.name;
  $('hRoll').textContent = S.user.roll_no || '';
  $('pEmail').textContent = S.user.email;
  $('faceWarn').classList.toggle('d-none', S.user.face_enrolled);
  $('faceBadge').innerHTML = S.user.face_enrolled ? '<span class="badge text-bg-success">Enrolled</span>' : '<span class="badge text-bg-warning">Not enrolled</span>';
  $('enrolBtn').textContent = S.user.face_enrolled ? 'Re-scan my face' : 'Scan my face';
  const f = $('profileForm');
  f.name.value = S.user.name; f.roll_no.value = S.user.roll_no || '';
}

function show(tab) {
  document.querySelectorAll('section[data-tab]').forEach((s) => s.classList.toggle('d-none', s.dataset.tab !== tab));
  document.querySelectorAll('[data-nav]').forEach((b) => b.classList.toggle('active', b.dataset.nav === tab));
  history.replaceState(null, '', `#${tab}`);
  window.scrollTo(0, 0);
  if (tab === 'menu') loadMenu();
  if (tab === 'green') loadStats();
  if (tab === 'guest') loadPasses();
  if (tab === 'profile') { loadLeaves(); loadComplaints(); }
}

// ---------- booking ----------
async function loadMeals() {
  const r = await WW.api('/api/meals');
  S.days = r.days;
  $('cutoffNote').textContent = `Booking for each meal closes ${r.cutoff_hours} hours before it starts. Cancel if your plans change so the kitchen cooks less.`;
  renderDays();
}
function renderDays() {
  $('dayChips').innerHTML = S.days.map((d) => {
    const n = d.sessions.filter((s) => s.booked).length;
    return `<button class="day-chip ${d.date === S.selected ? 'active' : ''}" data-day="${d.date}">${WW.dayLabel(d.date)}${n ? ` · ${n}` : ''}</button>`;
  }).join('');
  $('dayChips').querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => { S.selected = b.dataset.day; renderDays(); }));
  const day = S.days.find((d) => d.date === S.selected) || S.days[0];
  $('leaveBanner').classList.toggle('d-none', !day.on_leave);
  $('mealList').innerHTML = day.sessions.map((s) => {
    let badge, btn = '';
    if (s.status === 'leave') badge = '<span class="badge text-bg-light border" style="color: var(--ww-purple)">ON LEAVE</span>';
    else if (s.attended) badge = '<span class="badge text-bg-success">ATTENDED</span>';
    else if (s.booked && s.ended) badge = '<span class="badge text-bg-danger">NO-SHOW</span>';
    else if (s.booked) badge = '<span class="badge text-bg-success">BOOKED</span>';
    else if (!s.open) badge = '<span class="badge text-bg-secondary">BOOKING CLOSED</span>';
    else badge = '<span class="badge text-bg-light border">OPEN</span>';
    if (s.open && s.status !== 'leave') {
      btn = s.booked
        ? `<button class="btn btn-outline-danger btn-sm" data-act="cancel" data-meal="${s.meal}">Cancel booking</button>`
        : `<button class="btn btn-ww btn-sm px-4" data-act="book" data-meal="${s.meal}">Book</button>`;
    }
    const closes = s.open ? `<div class="small-muted mt-1">Booking closes ${s.deadline.slice(11, 16)}${s.deadline.slice(0, 10) !== WW.today() ? ' on ' + WW.prettyDate(s.deadline.slice(0, 10)) : ''}</div>` : '';
    return `<div class="card p-3 meal-card ${s.booked ? 'booked' : ''} ${s.status === 'leave' ? 'leave' : ''}">
      <div class="d-flex align-items-start">
        <div><div class="fw-bold fs-5">${s.meal}</div><div class="small-muted">${s.start}–${s.end}</div></div>
        <div class="ms-auto">${badge}</div>
      </div>
      ${s.items ? `<div class="small mt-2">🍽️ ${WW.esc(s.items)}</div>` : ''}
      ${closes}
      ${btn ? `<div class="mt-2">${btn}</div>` : ''}
    </div>`;
  }).join('');
  $('mealList').querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => book(day.date, b.dataset.meal, b.dataset.act)));
  $('bookAllBtn').classList.toggle('d-none', !day.sessions.some((s) => s.open && !s.booked && s.status !== 'leave'));
}
async function book(date, meal, action) {
  try {
    await WW.api('/api/bookings', { body: { date, meal, action } });
    WW.toast(action === 'book' ? `${meal} booked for ${WW.dayLabel(date)}` : `${meal} cancelled. Thanks for saving food!`, action === 'book' ? 'success' : 'info');
    loadMeals();
  } catch (e) { WW.toast(e.message, 'error'); }
}
$('bookAllBtn').addEventListener('click', async () => {
  const day = S.days.find((d) => d.date === S.selected);
  const todo = day.sessions.filter((s) => s.open && !s.booked && s.status !== 'leave');
  for (const s of todo) { try { await WW.api('/api/bookings', { body: { date: day.date, meal: s.meal, action: 'book' } }); } catch (e) { WW.toast(e.message, 'error'); } }
  WW.toast(`Booked ${todo.length} meal(s) for ${WW.dayLabel(day.date)}`);
  loadMeals();
});

// ---------- menu ----------
async function loadMenu() {
  const { menu } = await WW.api('/api/menu');
  const todayIdx = (new Date().getDay() + 6) % 7;
  $('menuList').innerHTML = WW.days.map((d, i) => {
    const items = S.config.meals.map((m) => {
      const it = menu.find((x) => x.day === i && x.meal === m);
      return `<div class="d-flex gap-2 small py-1"><span class="fw-semibold" style="width: 80px">${m}</span><span>${WW.esc(it ? it.items : '-')}</span></div>`;
    }).join('');
    return `<div class="card p-3 ${i === todayIdx ? 'border-success' : ''}"><div class="fw-bold mb-1">${d}${i === todayIdx ? ' <span class="badge bg-ww">Today</span>' : ''}</div>${items}</div>`;
  }).join('');
}

// ---------- stats ----------
async function loadStats() {
  const [me, pub] = await Promise.all([WW.api('/api/stats/me'), WW.api('/api/public/sustainability')]);
  const tile = (v, l) => `<div class="col-6 col-md-3"><div class="card p-3 text-center"><div class="stat text-ww">${v}</div><div class="stat-label">${l}</div></div></div>`;
  $('myStats').innerHTML = tile(me.total_booked, 'Meals booked') + tile(me.meals_attended, 'Meals attended') + tile(me.no_shows, 'No-shows') + tile(me.attendance_rate == null ? '–' : me.attendance_rate + '%', 'Show-up rate');
  const t2 = (v, l) => `<div class="col-6 col-md-3"><div class="fw-bold fs-5">${v}</div><div class="stat-label">${l}</div></div>`;
  $('campusStats').innerHTML = t2(pub.meals_served, 'Meals served') + t2(pub.wasted_kg + ' kg', 'Waste logged') + t2(pub.biogas_m3 + ' m³', 'Biogas made') + t2(pub.slurry_used_kg + ' kg', 'Slurry used');
  $('historyRows').innerHTML = me.history.map((h) => {
    const cls = { attended: 'success', 'no-show': 'danger', upcoming: 'secondary' }[h.result];
    return `<tr><td>${WW.prettyDate(h.date)}</td><td>${h.meal}</td><td><span class="badge text-bg-${cls}">${h.result}</span></td></tr>`;
  }).join('') || '<tr><td colspan="3" class="small-muted">No bookings yet.</td></tr>';
}

// ---------- guest passes ----------
$('guestForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await WW.api('/api/guest-passes', { body: Object.fromEntries(new FormData(e.target)) });
    e.target.guest_name.value = '';
    WW.toast('Guest pass created. Show the QR code at the scanner.');
    loadPasses();
  } catch (ex) { WW.toast(ex.message, 'error'); }
});
async function loadPasses() {
  const { passes } = await WW.api('/api/guest-passes');
  $('passList').innerHTML = passes.map((p) => `<div class="card p-3">
      <div class="d-flex align-items-start gap-3">
        ${p.status === 'active' ? `<img src="/api/guest-passes/${p.id}/qr" width="140" height="140" alt="QR code" class="rounded border bg-white">` : ''}
        <div class="flex-fill">
          <div class="fw-bold">${WW.esc(p.guest_name)}</div>
          <div class="small-muted">${p.meal} · ${WW.prettyDate(p.date)}</div>
          <div class="small mt-1">Code: <code>${p.code}</code></div>
          <div class="small">₹${p.amount} · ${p.paid ? 'Paid' : 'Pay at counter'}</div>
          <div class="mt-2">${WW.statusBadge(p.status)}</div>
          ${p.status === 'active' ? `<button class="btn btn-link btn-sm text-danger px-0" data-cancel="${p.id}">Cancel pass</button>` : ''}
        </div>
      </div></div>`).join('') || '<p class="small-muted">No guest passes yet.</p>';
  $('passList').querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    await WW.api(`/api/guest-passes/${b.dataset.cancel}`, { method: 'DELETE' });
    loadPasses();
  }));
}

// ---------- profile ----------
$('profileForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const body = Object.fromEntries(new FormData(e.target));
    S.user = (await WW.api('/api/profile', { method: 'PUT', body })).user;
    e.target.current_password.value = ''; e.target.new_password.value = '';
    renderUser();
    WW.toast('Profile saved.');
  } catch (ex) { WW.toast(ex.message, 'error'); }
});

let enrolling = false;
$('enrolBtn').addEventListener('click', async () => {
  if (enrolling) return;
  enrolling = true;
  const btn = $('enrolBtn');
  btn.disabled = true;
  $('enrolBox').classList.remove('d-none');
  const N = 5;
  try {
    await Face.startCamera($('video'));
    $('camMsg').textContent = 'Loading face models…';
    await Face.load();
    const samples = await Face.captureSamples($('video'), $('overlay'), N, (n, msg) => { $('bar').style.width = `${(n / N) * 100}%`; $('camMsg').textContent = msg; });
    await WW.api('/api/face/enroll', { body: { descriptors: samples } });
    S.user.face_enrolled = true;
    renderUser();
    WW.toast('Face enrolled! You can now check in at the gate scanner.');
  } catch (ex) { WW.toast(ex.message, 'error'); }
  Face.stopCamera($('video'));
  $('enrolBox').classList.add('d-none');
  $('bar').style.width = '0%';
  btn.disabled = false;
  enrolling = false;
});

$('leaveForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await WW.api('/api/leaves', { body: Object.fromEntries(new FormData(e.target)) });
    e.target.reset();
    WW.toast('Leave marked. Your meals in that range are cancelled.');
    loadLeaves(); loadMeals();
  } catch (ex) { WW.toast(ex.message, 'error'); }
});
async function loadLeaves() {
  const { leaves } = await WW.api('/api/leaves');
  const today = WW.today();
  $('leaveList').innerHTML = leaves.filter((l) => l.to_date >= today).map((l) =>
    `<div class="d-flex align-items-center small border rounded p-2 mt-1 bg-body"><span>${WW.prettyDate(l.from_date)} → ${WW.prettyDate(l.to_date)}</span>
     <button class="btn btn-link btn-sm text-danger ms-auto" data-del="${l.id}">Remove</button></div>`).join('');
  $('leaveList').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    await WW.api(`/api/leaves/${b.dataset.del}`, { method: 'DELETE' });
    WW.toast('Leave removed. Remember to book your meals again.', 'info');
    loadLeaves(); loadMeals();
  }));
}

$('complaintForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const file = f.photo.files[0];
    const photo = file ? await WW.fileToDataUrl(file) : null;
    await WW.api('/api/complaints', { body: { category: f.category.value, message: f.message.value, photo } });
    f.reset();
    WW.toast('Submitted. The mess team will look into it.');
    loadComplaints();
  } catch (ex) { WW.toast(ex.message, 'error'); }
});
async function loadComplaints() {
  const { complaints } = await WW.api('/api/complaints');
  $('complaintList').innerHTML = complaints.map((c) => `<div class="border rounded p-2 small">
    <div class="d-flex"><span class="fw-semibold">${WW.esc(c.category)}</span><span class="ms-auto">${WW.statusBadge(c.status)}</span></div>
    <div>${WW.esc(c.message)}</div>
    ${c.photo ? `<a href="/uploads/${c.photo}" target="_blank" class="text-ww">View photo</a>` : ''}
    ${c.admin_note ? `<div class="mt-1 text-ww">Admin: ${WW.esc(c.admin_note)}</div>` : ''}
    <div class="small-muted">${c.created_at}</div></div>`).join('');
}

// ---------- reminders / announcements ----------
function seen() { try { return new Set(JSON.parse(localStorage.getItem('ww_seen') || '[]')); } catch { return new Set(); } }
function markSeen(ids) { try { const s = seen(); ids.forEach((i) => s.add(i)); localStorage.setItem('ww_seen', JSON.stringify([...s].slice(-200))); } catch {} }
async function pollNotifications() {
  let r;
  try { r = await WW.api('/api/notifications'); } catch { return; }
  const items = [...r.reminders, ...r.announcements];
  const colors = { warning: 'warning', info: 'info', special: 'success', closure: 'danger', menu: 'primary' };
  $('notices').innerHTML = r.reminders.map((n) => `<div class="alert alert-${colors[n.kind] || 'info'} py-2"><b>${WW.esc(n.title)}</b><br><span class="small">${WW.esc(n.body)}</span></div>`).join('')
    + r.announcements.slice(0, 2).map((a) => `<div class="card p-3 mb-3 border-${colors[a.kind] || 'info'}"><div class="small-muted">📢 Announcement · ${a.created_at.slice(0, 16)}</div><div class="fw-bold">${WW.esc(a.title)}</div><div class="small">${WW.esc(a.body)}</div></div>`).join('');
  const s = seen();
  const fresh = items.filter((n) => !s.has(n.id));
  if (fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    fresh.forEach((n) => new Notification(n.title, { body: n.body, icon: '/img/logo.svg', tag: n.id }));
  }
  markSeen(fresh.map((n) => n.id));
}
$('notifBtn').addEventListener('click', async () => {
  if (!('Notification' in window)) return WW.toast('This browser does not support notifications', 'error');
  const p = await Notification.requestPermission();
  WW.toast(p === 'granted' ? 'Notifications on' : 'Notifications were blocked in the browser', p === 'granted' ? 'success' : 'warning');
  if (p === 'granted') new Notification('WasteWise reminders are on', { body: 'We will remind you before bookings close and meals end.', icon: '/img/logo.svg' });
});

init();
