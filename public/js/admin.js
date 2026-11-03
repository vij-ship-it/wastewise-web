// Admin / warden dashboard.
const $ = (id) => document.getElementById(id);
const A = { config: null, charts: {}, tab: 'live', user: null };
const C = WW.chartColors;

function chart(id, cfg) {
  if (A.charts[id]) A.charts[id].destroy();
  cfg.options = Object.assign({ responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }, cfg.options || {});
  A.charts[id] = new Chart($(id), cfg);
}

async function init() {
  A.user = await WW.requireUser('admin');
  if (!A.user) return;
  A.config = await WW.api('/api/config');
  document.querySelectorAll('.meal-select').forEach((s) => { s.innerHTML = A.config.meals.map((m) => `<option>${m}</option>`).join(''); });
  $('liveDate').value = $('bDate').value = WW.today();
  document.querySelector('#wasteForm [name=date]').value = WW.today();
  document.querySelector('#slurryForm [name=date]').value = WW.today();
  $('rTo').value = WW.today(); $('rFrom').value = WW.addDays(WW.today(), -6);
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  const t = location.hash.slice(1);
  show(document.querySelector(`[data-sec="${t}"]`) ? t : 'live');
  connectStream();
  setInterval(() => { if (A.tab === 'live') loadLive(); }, 30000);
  refreshComplaintBadge();
}

function show(tab) {
  A.tab = tab;
  document.querySelectorAll('[data-sec]').forEach((s) => s.classList.toggle('d-none', s.dataset.sec !== tab));
  document.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  history.replaceState(null, '', `#${tab}`);
  ({ live: loadLive, bookings: loadBookings, guests: loadGuests, waste: loadWaste, announce: loadAnn, complaints: loadComplaints, menu: loadMenu, analytics: loadAnalytics, students: loadStudents, settings: loadSettings }[tab] || (() => {}))();
}

function connectStream() {
  const es = new EventSource('/api/admin/stream');
  let timer = null;
  const refresh = () => { clearTimeout(timer); timer = setTimeout(() => { if (A.tab === 'live') loadLive(); if (A.tab === 'bookings') loadBookings(); }, 400); };
  es.addEventListener('scan', refresh);
  es.addEventListener('update', (e) => { refresh(); try { if (JSON.parse(e.data).type === 'complaint') refreshComplaintBadge(); } catch {} });
}

// ---------- LIVE ----------
$('liveDate').addEventListener('change', loadLive);
async function loadLive() {
  const d = await WW.api(`/api/admin/live?date=${$('liveDate').value}`);
  $('curMeal').textContent = d.current ? `Now serving: ${d.current.meal}` : 'No meal being served right now';
  const tile = (v, l, cls = 'text-ww') => `<div class="col-6 col-md-3"><div class="card p-3"><div class="stat ${cls}">${v}</div><div class="stat-label">${l}</div></div></div>`;
  const totExp = d.meals.reduce((a, m) => a + m.expected, 0);
  const totAct = d.meals.reduce((a, m) => a + m.actual, 0);
  $('liveTop').innerHTML = tile(d.students, 'Registered students') + tile(d.on_leave, 'On leave today', '') + tile(`${totAct} / ${totExp}`, 'Checked in / expected today') + tile(d.open_complaints, 'Open complaints', d.open_complaints ? 'text-danger' : '');
  const plate = (await settingsCache()).plate_kg;
  $('mealCards').innerHTML = d.meals.map((m) => {
    const isNow = d.current && d.current.meal === m.meal && d.current.date === d.date;
    const pct = m.expected ? Math.round((m.actual / m.expected) * 100) : 0;
    const prep = Math.round(m.expected * plate * 1.03 * 10) / 10;
    return `<div class="col-md-6 col-xl-3"><div class="card p-3 h-100 ${isNow ? 'border-success border-2' : ''}">
      <div class="d-flex"><div class="fw-bold">${m.meal}</div><span class="ms-auto small-muted">${m.start}–${m.end}</span></div>
      ${isNow ? '<div class="small text-ww fw-semibold"><span class="live-dot"></span>Serving now</div>' : ''}
      <div class="d-flex align-items-end gap-2 mt-2"><div class="stat">${m.actual}</div><div class="small-muted mb-1">of ${m.expected} expected</div></div>
      <div class="progress my-2" style="height: 6px"><div class="progress-bar bg-success" style="width: ${Math.min(pct, 100)}%"></div></div>
      <div class="small">Students ${m.actual_students}/${m.booked} · Guests ${m.actual_guests}/${m.guests_expected}</div>
      ${m.ended ? `<div class="small">No-shows: <b class="text-danger">${m.no_shows}</b> · Est. leftover: <b>${m.leftover_estimate_kg} kg</b></div>` : `<div class="small">Yet to arrive: ${m.pending}</div><div class="small text-ww">Cook for ≈ ${prep} kg (${m.expected} plates + 3%)</div>`}
      ${m.ir_in ? `<div class="small small-muted">IR sensor count: ${m.ir_in} in / ${m.ir_out} out</div>` : ''}
      ${m.waste ? `<div class="small small-muted">Waste logged: ${m.waste.wasted_kg} kg</div>` : ''}
    </div></div>`;
  }).join('');
  chart('liveChart', {
    type: 'bar',
    data: { labels: d.meals.map((m) => m.meal), datasets: [
      { label: 'Expected (booked + guests)', data: d.meals.map((m) => m.expected), backgroundColor: C.expected, borderRadius: 6 },
      { label: 'Actual (checked in)', data: d.meals.map((m) => m.actual), backgroundColor: C.actual, borderRadius: 6 },
    ] },
    options: { animation: false, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
  });
  $('scanList').innerHTML = d.recent.map((r) => `<div class="d-flex gap-2 border-bottom py-1"><span>${WW.statusBadge(r.result)}</span><span class="flex-fill"><b>${WW.esc(r.label || '')}</b> ${r.meal ? '· ' + r.meal : ''}<br><span class="small-muted">${WW.esc(r.reason || '')}</span></span><span class="small-muted">${(r.ts || '').slice(11, 16)}</span></div>`).join('') || '<div class="small-muted">No scans yet.</div>';
}
let _settings = null;
async function settingsCache(force) { if (!_settings || force) _settings = (await WW.api('/api/admin/settings')).settings; return _settings; }

$('checkinForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const r = await WW.api('/api/admin/checkin', { body: { who: f.who.value, meal: f.meal.value, date: $('liveDate').value, add_booking: f.add_booking.checked } });
    WW.toast(`${r.name} checked in`);
    f.who.value = '';
    loadLive();
  } catch (ex) { WW.toast(ex.message, 'error'); }
});

// ---------- BOOKINGS ----------
$('bDate').addEventListener('change', loadBookings);
$('bMeal').addEventListener('change', loadBookings);
async function loadBookings() {
  const d = await WW.api(`/api/admin/bookings?date=${$('bDate').value}&meal=${$('bMeal').value}`);
  const inCount = d.rows.filter((r) => r.checked_in_at).length;
  $('bSummary').innerHTML = `<b>${d.rows.length}</b> booked · <b class="text-ww">${inCount}</b> checked in · <b class="text-danger">${d.rows.length - inCount}</b> not yet / no-show`;
  $('bRows').innerHTML = d.rows.map((r) => `<tr><td>${WW.esc(r.name)}</td><td>${WW.esc(r.roll_no)}</td><td class="small">${WW.esc(r.email)}</td><td>${r.checked_in_at ? `<span class="badge text-bg-success">${r.checked_in_at.slice(11, 16)}</span>` : '<span class="badge text-bg-light border">–</span>'}</td></tr>`).join('') || '<tr><td colspan="4" class="small-muted">No bookings for this meal.</td></tr>';
  $('bWalkins').innerHTML = d.walkins.length ? `<div class="fw-semibold mt-2">Checked in without a booking</div>` + d.walkins.map((w) => `<div class="small">${WW.esc(w.name)} (${WW.esc(w.roll_no)}) · ${w.method} · ${w.created_at.slice(11, 16)}</div>`).join('') : '';
}

// ---------- GUESTS ----------
async function loadGuests() {
  const d = await WW.api('/api/admin/guest-passes');
  const tile = (v, l) => `<div class="col-6 col-md-3"><div class="card p-3"><div class="stat text-ww">${v}</div><div class="stat-label">${l}</div></div></div>`;
  $('gTop').innerHTML = tile(d.passes.length, 'Passes issued') + tile(d.passes.filter((p) => p.status === 'used').length, 'Guest meals served') + tile(`₹${d.collected}`, 'Collected') + tile(`₹${d.due}`, 'Payment due');
  $('gRows').innerHTML = d.passes.map((p) => `<tr><td>${WW.prettyDate(p.date)}</td><td>${p.meal}</td><td>${WW.esc(p.guest_name)}</td><td class="small">${WW.esc(p.requested_by_name)}<br><span class="small-muted">${WW.esc(p.roll_no)}</span></td><td><code>${p.code}</code></td><td>${WW.statusBadge(p.status)}</td>
    <td>${p.paid ? `<span class="badge text-bg-success">₹${p.amount} ${p.payment_mode}</span>` : `<div class="input-group input-group-sm" style="width: 170px"><select class="form-select" id="pm${p.id}"><option>Cash</option><option>UPI</option><option>Card</option><option>Mess account</option></select><button class="btn btn-ww" data-pay="${p.id}">Paid ₹${p.amount}</button></div>`}</td>
    <td>${p.status === 'active' ? `<button class="btn btn-link btn-sm text-danger" data-gcancel="${p.id}">Cancel</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="8" class="small-muted">No guest passes yet.</td></tr>';
  $('gRows').querySelectorAll('[data-pay]').forEach((b) => b.addEventListener('click', async () => {
    await WW.api(`/api/admin/guest-passes/${b.dataset.pay}/pay`, { body: { mode: $('pm' + b.dataset.pay).value } });
    loadGuests();
  }));
  $('gRows').querySelectorAll('[data-gcancel]').forEach((b) => b.addEventListener('click', async () => {
    await WW.api(`/api/admin/guest-passes/${b.dataset.gcancel}/cancel`, { method: 'POST' });
    loadGuests();
  }));
}

// ---------- WASTE ----------
async function loadWaste() {
  const [w, s, cfg] = await Promise.all([WW.api('/api/admin/waste'), WW.api('/api/admin/slurry'), settingsCache()]);
  const tile = (v, l) => `<div class="col-6 col-md-3"><div class="card p-3"><div class="stat text-ww">${v}</div><div class="stat-label">${l}</div></div></div>`;
  $('wTop').innerHTML = tile(`${s.wasted_kg} kg`, 'Total food waste logged') + tile(`${s.biogas_m3} m³`, 'Biogas generated (est.)') + tile(`${s.slurry_produced_kg} kg`, 'Slurry produced (est.)') + tile(`${s.slurry_used_kg} kg`, 'Slurry used in farms');
  $('wHint').textContent = `Biogas estimate = waste sent to biogas × ${cfg.biogas_m3_per_kg} m³/kg (change in Settings).`;
  let cum = 0;
  const rows = [...w.rows].reverse().map((r) => { cum += r.biogas_m3; return { ...r, cum: Math.round(cum * 100) / 100 }; }).reverse();
  $('wRows').innerHTML = rows.map((r) => `<tr><td>${WW.prettyDate(r.date)}</td><td>${r.meal}</td><td>${r.prepared_kg || '–'}</td><td><b>${r.wasted_kg}</b></td><td>${r.sent_to_biogas_kg}</td><td>${r.biogas_m3}</td><td>${r.cum}</td><td><button class="btn btn-link btn-sm text-danger p-0" data-wdel="${r.id}">✕</button></td></tr>`).join('') || '<tr><td colspan="8" class="small-muted">No waste logged yet.</td></tr>';
  $('wRows').querySelectorAll('[data-wdel]').forEach((b) => b.addEventListener('click', async () => { if (confirm('Delete this waste entry?')) { await WW.api(`/api/admin/waste/${b.dataset.wdel}`, { method: 'DELETE' }); loadWaste(); } }));
  $('sRows').innerHTML = s.rows.map((r) => `<tr><td>${WW.prettyDate(r.date)}</td><td>${r.quantity_kg} kg</td><td>${WW.esc(r.used_for)}</td><td><button class="btn btn-link btn-sm text-danger p-0" data-sdel="${r.id}">✕</button></td></tr>`).join('');
  $('sRows').querySelectorAll('[data-sdel]').forEach((b) => b.addEventListener('click', async () => { await WW.api(`/api/admin/slurry/${b.dataset.sdel}`, { method: 'DELETE' }); loadWaste(); }));
}
$('wasteForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await WW.api('/api/admin/waste', { body: Object.fromEntries(new FormData(e.target)) }); WW.toast('Waste log saved'); e.target.wasted_kg.value = ''; e.target.prepared_kg.value = ''; e.target.sent_to_biogas_kg.value = ''; e.target.notes.value = ''; loadWaste(); }
  catch (ex) { WW.toast(ex.message, 'error'); }
});
$('slurryForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await WW.api('/api/admin/slurry', { body: Object.fromEntries(new FormData(e.target)) }); WW.toast('Slurry usage logged'); e.target.quantity_kg.value = ''; e.target.used_for.value = ''; loadWaste(); }
  catch (ex) { WW.toast(ex.message, 'error'); }
});

// ---------- ANNOUNCEMENTS ----------
async function loadAnn() {
  const { announcements } = await WW.api('/api/announcements');
  $('annList').innerHTML = announcements.map((a) => `<div class="card p-3"><div class="d-flex"><span class="badge text-bg-light border">${a.kind}</span><span class="small-muted ms-2">${a.created_at}</span><button class="btn btn-link btn-sm text-danger ms-auto p-0" data-adel="${a.id}">Delete</button></div><div class="fw-bold mt-1">${WW.esc(a.title)}</div><div class="small">${WW.esc(a.body)}</div></div>`).join('') || '<p class="small-muted">No announcements yet.</p>';
  $('annList').querySelectorAll('[data-adel]').forEach((b) => b.addEventListener('click', async () => { await WW.api(`/api/admin/announcements/${b.dataset.adel}`, { method: 'DELETE' }); loadAnn(); }));
}
$('annForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await WW.api('/api/admin/announcements', { body: Object.fromEntries(new FormData(e.target)) }); e.target.reset(); WW.toast('Announcement sent'); loadAnn(); }
  catch (ex) { WW.toast(ex.message, 'error'); }
});

// ---------- COMPLAINTS ----------
async function refreshComplaintBadge() {
  const { complaints } = await WW.api('/api/admin/complaints');
  const n = complaints.filter((c) => c.status !== 'resolved').length;
  $('cBadge').textContent = n; $('cBadge').classList.toggle('d-none', !n);
  return complaints;
}
async function loadComplaints() {
  const complaints = await refreshComplaintBadge();
  $('compList').innerHTML = complaints.map((c) => `<div class="card p-3">
    <div class="d-flex flex-wrap gap-2 align-items-center"><span class="fw-bold">${WW.esc(c.category)}</span>${WW.statusBadge(c.status)}<span class="small-muted">${WW.esc(c.name)} (${WW.esc(c.roll_no)}) · ${c.created_at}</span></div>
    <div class="my-2">${WW.esc(c.message)}</div>
    ${c.photo ? `<a href="/uploads/${c.photo}" target="_blank"><img src="/uploads/${c.photo}" alt="attached photo" style="max-height: 160px" class="rounded border mb-2"></a>` : ''}
    <div class="row g-2">
      <div class="col-md-3"><select class="form-select form-select-sm" id="cs${c.id}">${['open', 'in_progress', 'resolved'].map((s) => `<option value="${s}" ${s === c.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}</select></div>
      <div class="col-md-7"><input class="form-control form-control-sm" id="cn${c.id}" placeholder="Note to student" value="${WW.esc(c.admin_note || '')}"></div>
      <div class="col-md-2"><button class="btn btn-ww btn-sm w-100" data-cupd="${c.id}">Update</button></div>
    </div></div>`).join('') || '<p class="small-muted">No complaints. 🎉</p>';
  $('compList').querySelectorAll('[data-cupd]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.cupd;
    await WW.api(`/api/admin/complaints/${id}`, { method: 'PUT', body: { status: $('cs' + id).value, admin_note: $('cn' + id).value } });
    WW.toast('Complaint updated');
    loadComplaints();
  }));
}

// ---------- MENU ----------
async function loadMenu() {
  const { menu } = await WW.api('/api/menu');
  $('menuHead').innerHTML = `<tr><th>Day</th>${A.config.meals.map((m) => `<th>${m}</th>`).join('')}</tr>`;
  $('menuBody').innerHTML = WW.days.map((d, i) => `<tr><th>${d}</th>${A.config.meals.map((m) => {
    const it = menu.find((x) => x.day === i && x.meal === m);
    return `<td><textarea class="form-control form-control-sm" rows="2" data-day="${i}" data-meal="${m}">${WW.esc(it ? it.items : '')}</textarea></td>`;
  }).join('')}</tr>`).join('');
}
$('saveMenu').addEventListener('click', async () => {
  const items = [...document.querySelectorAll('#menuBody textarea')].map((t) => ({ day: Number(t.dataset.day), meal: t.dataset.meal, items: t.value }));
  try { await WW.api('/api/admin/menu', { method: 'PUT', body: { items } }); WW.toast('Menu saved'); } catch (ex) { WW.toast(ex.message, 'error'); }
});

// ---------- ANALYTICS ----------
$('aDays').addEventListener('change', loadAnalytics);
async function loadAnalytics() {
  const d = await WW.api(`/api/admin/analytics?days=${$('aDays').value}`);
  const labels = d.daily.map((x) => WW.prettyDate(x.date, { day: 'numeric', month: 'short' }));
  chart('aTrend', { type: 'line', data: { labels, datasets: A.config.meals.map((m, i) => ({ label: m, data: d.daily.map((x) => x.meals[m]?.actual ?? 0), borderColor: C.meals[i], backgroundColor: C.meals[i], tension: 0.3, pointRadius: 2 })) }, options: { scales: { y: { beginAtZero: true } } } });
  chart('aExp', { type: 'bar', data: { labels, datasets: [{ label: 'Expected', data: d.daily.map((x) => x.expected), backgroundColor: C.expected }, { label: 'Actual', data: d.daily.map((x) => x.actual), backgroundColor: C.actual }] }, options: { scales: { y: { beginAtZero: true } } } });
  chart('aWaste', { type: 'line', data: { labels, datasets: [
    { label: 'Food waste (kg)', data: d.daily.map((x) => x.wasted_kg), borderColor: C.waste, backgroundColor: C.waste, yAxisID: 'y', tension: 0.3 },
    { label: 'Waste per plate (g)', data: d.daily.map((x) => x.waste_per_plate_g), borderColor: C.noshow, backgroundColor: C.noshow, borderDash: [5, 4], yAxisID: 'y1', tension: 0.3 },
  ] }, options: { scales: { y: { beginAtZero: true, title: { display: true, text: 'kg' } }, y1: { beginAtZero: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'g / plate' } } } } });
  const rate = (o) => (o.booked ? Math.round((o.no_shows / o.booked) * 1000) / 10 : 0);
  chart('aNoShow', { type: 'bar', data: { labels: [...d.byWeekday.map((w) => w.day), ...d.byMeal.map((m) => m.meal)], datasets: [{ label: 'No-show rate (%)', data: [...d.byWeekday.map(rate), ...d.byMeal.map(rate)], backgroundColor: [...d.byWeekday.map(() => C.noshow), ...d.byMeal.map((_, i) => C.meals[i])], borderRadius: 6 }] }, options: { plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { callback: (v) => v + '%' } } } } });
  chart('aGuests', { type: 'bar', data: { labels, datasets: [{ label: 'Guest meals per day', data: d.daily.map((x) => x.guests), backgroundColor: C.guests, borderRadius: 4 }] }, options: { scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } } });
  $('aTop').innerHTML = d.topNoShow.map((s) => `<tr><td>${WW.esc(s.name)}</td><td>${WW.esc(s.roll_no)}</td><td class="text-danger fw-bold">${s.no_shows}</td><td>${s.booked}</td><td>${s.rate}%</td></tr>`).join('') || '<tr><td colspan="5" class="small-muted">No no-shows in this period.</td></tr>';
}

// ---------- REPORTS ----------
$('rWeek').addEventListener('click', () => { $('rTo').value = WW.today(); $('rFrom').value = WW.addDays(WW.today(), -6); });
$('rMonth').addEventListener('click', () => { $('rTo').value = WW.today(); $('rFrom').value = WW.addDays(WW.today(), -29); });
$('rOpen').addEventListener('click', () => window.open(`/report?from=${$('rFrom').value}&to=${$('rTo').value}`, '_blank'));
$('rCsv').addEventListener('click', () => { location.href = `/api/admin/report.csv?from=${$('rFrom').value}&to=${$('rTo').value}`; });

// ---------- STUDENTS ----------
let students = [];
$('stSearch').addEventListener('input', renderStudents);
async function loadStudents() { students = (await WW.api('/api/admin/students')).students; renderStudents(); }
function renderStudents() {
  const q = $('stSearch').value.toLowerCase();
  const list = students.filter((s) => !q || `${s.name} ${s.roll_no} ${s.email}`.toLowerCase().includes(q));
  $('stRows').innerHTML = list.map((s) => `<tr><td>${WW.esc(s.name)}</td><td>${WW.esc(s.roll_no)}</td><td>${WW.esc(s.email)}</td>
    <td>${s.faces ? '<span class="badge text-bg-success">Enrolled</span>' : '<span class="badge text-bg-warning">None</span>'}</td><td>${s.booked}</td><td>${s.attended}</td><td class="${s.no_shows > 5 ? 'text-danger fw-bold' : ''}">${s.no_shows}</td>
    <td class="text-nowrap">${s.faces ? `<button class="btn btn-link btn-sm p-0 me-2" data-rf="${s.id}">Reset face</button>` : ''}<button class="btn btn-link btn-sm text-danger p-0" data-del="${s.id}">Delete</button></td></tr>`).join('');
  $('stRows').querySelectorAll('[data-rf]').forEach((b) => b.addEventListener('click', async () => { if (confirm('Remove this student\'s face data? They will need to enrol again.')) { await WW.api(`/api/admin/students/${b.dataset.rf}/face`, { method: 'DELETE' }); loadStudents(); } }));
  $('stRows').querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => { if (confirm('Delete this student and all their bookings? This cannot be undone.')) { await WW.api(`/api/admin/students/${b.dataset.del}`, { method: 'DELETE' }); loadStudents(); } }));
}

// ---------- SETTINGS ----------
async function loadSettings() {
  const s = await settingsCache(true);
  $('setTimes').innerHTML = A.config.meals.map((m) => `<div class="row g-2 align-items-center mb-2"><div class="col-4 small fw-semibold">${m}</div><div class="col-4"><input type="time" class="form-control form-control-sm" data-mt="${m}" data-k="start" value="${s.meal_times[m].start}"></div><div class="col-4"><input type="time" class="form-control form-control-sm" data-mt="${m}" data-k="end" value="${s.meal_times[m].end}"></div></div>`).join('');
  const f = $('setForm');
  for (const k of ['booking_cutoff_hours', 'booking_days_ahead', 'email_domain', 'guest_price', 'plate_kg', 'biogas_m3_per_kg', 'slurry_kg_per_kg', 'co2e_kg_per_kg', 'face_match_threshold', 'scanner_key']) f[k].value = s[k];
}
$('setForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.meal_times = {};
  document.querySelectorAll('[data-mt]').forEach((i) => { (body.meal_times[i.dataset.mt] ||= {})[i.dataset.k] = i.value; });
  try { await WW.api('/api/admin/settings', { method: 'PUT', body }); await settingsCache(true); A.config = await WW.api('/api/config'); WW.toast('Settings saved'); }
  catch (ex) { WW.toast(ex.message, 'error'); }
});
document.querySelectorAll('[data-ir]').forEach((b) => b.addEventListener('click', async () => {
  try { await WW.api('/api/sensor/ir', { body: { direction: b.dataset.ir } }); WW.toast(`IR event recorded (${b.dataset.ir})`, 'info'); } catch (ex) { WW.toast(ex.message, 'error'); }
}));
$('pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await WW.api('/api/profile', { method: 'PUT', body: { name: A.user.name, roll_no: A.user.roll_no, ...Object.fromEntries(new FormData(e.target)) } }); e.target.reset(); WW.toast('Password changed'); }
  catch (ex) { WW.toast(ex.message, 'error'); }
});

init();
