// End-to-end API test on a throwaway database. Run: npm test
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-test-'));
process.env.WW_DB = path.join(tmp, 'test.db');
const app = require('../server/index');
const T = require('../server/time');

let server, base;
before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); }));
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

function client() {
  let cookie = '';
  return async (p, body, method, headers = {}) => {
    const res = await fetch(base + p, {
      method: method || (body ? 'POST' : 'GET'),
      headers: { 'Content-Type': 'application/json', cookie, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, data: ct.includes('json') ? await res.json() : await res.text() };
  };
}
const face = (seed) => Array.from({ length: 128 }, (_, i) => Math.sin(i * 0.37 + seed) * 0.1);
const tomorrow = T.addDays(T.localDate(), 1);

test('full student → scanner → admin flow', async () => {
  const stu = client();
  const adm = client();

  let r = await stu('/api/auth/register', { name: 'Test', email: 'x@gmail.com', roll_no: 'R1', password: 'secret1' });
  assert.equal(r.status, 400, 'non-college email rejected');

  r = await stu('/api/auth/register', { name: 'Asha Test', email: 'asha@rvce.edu.in', roll_no: '1rv25cs001', password: 'secret1', descriptors: [face(1), face(1.01)] });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.face_enrolled, true);

  // a second person with the same face cannot register it again
  const other = client();
  r = await other('/api/auth/register', { name: 'Copy', email: 'copy@rvce.edu.in', roll_no: 'R2', password: 'secret1', descriptors: [face(1)] });
  assert.equal(r.status, 409);

  r = await stu('/api/meals');
  assert.equal(r.data.days.length, 7);

  r = await stu('/api/bookings', { date: tomorrow, meal: 'Lunch', action: 'book' });
  assert.equal(r.status, 200);

  r = await adm('/api/auth/login', { email: 'admin@rvce.edu.in', password: 'admin123', role: 'admin' });
  assert.equal(r.status, 200);

  // scanner: recognised + booked → granted
  r = await adm('/api/scanner/identify', { descriptor: face(1.005), meal: 'Lunch', date: tomorrow });
  assert.equal(r.data.result, 'granted', JSON.stringify(r.data));
  assert.equal(r.data.label, 'Asha Test');
  // second scan → duplicate
  r = await adm('/api/scanner/identify', { descriptor: face(1.005), meal: 'Lunch', date: tomorrow });
  assert.equal(r.data.result, 'duplicate');
  // not booked for Dinner → denied
  r = await adm('/api/scanner/identify', { descriptor: face(1.005), meal: 'Dinner', date: tomorrow });
  assert.equal(r.data.result, 'denied');
  // unknown face → denied
  r = await adm('/api/scanner/identify', { descriptor: face(4), meal: 'Lunch', date: tomorrow });
  assert.equal(r.data.result, 'denied');
  assert.match(r.data.reason, /not recognised/);
  // scanner key works without a login
  r = await client()('/api/scanner/status', null, 'GET', { 'X-Scanner-Key': 'wastewise-scanner-key' });
  assert.equal(r.status, 200);
  r = await client()('/api/scanner/status');
  assert.equal(r.status, 403);

  // guest pass via QR
  r = await stu('/api/guest-passes', { guest_name: 'Ravi', date: tomorrow, meal: 'Dinner' });
  const code = r.data.code;
  r = await adm('/api/scanner/guest', { code: `WWGUEST:${code}`, meal: 'Lunch', date: tomorrow });
  assert.equal(r.data.result, 'denied', 'wrong meal');
  r = await adm('/api/scanner/guest', { code: `WWGUEST:${code}`, meal: 'Dinner', date: tomorrow });
  assert.equal(r.data.result, 'granted');
  r = await adm('/api/scanner/guest', { code, meal: 'Dinner', date: tomorrow });
  assert.equal(r.data.result, 'duplicate');
  const passes = (await stu('/api/guest-passes')).data.passes;
  const qr = await fetch(`${base}/api/guest-passes/${passes[0].id}/qr`, { headers: { cookie: '' } });
  assert.equal(qr.status, 401);

  // leave cancels bookings
  await stu('/api/bookings', { date: T.addDays(T.localDate(), 3), meal: 'Dinner', action: 'book' });
  r = await stu('/api/leaves', { from_date: T.addDays(T.localDate(), 2), to_date: T.addDays(T.localDate(), 4) });
  assert.equal(r.status, 200);
  r = await stu('/api/meals');
  assert.equal(r.data.days[3].on_leave, true);
  r = await stu('/api/bookings', { date: T.addDays(T.localDate(), 3), meal: 'Lunch', action: 'book' });
  assert.equal(r.status, 400);

  // complaint with photo
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  r = await stu('/api/complaints', { category: 'Hygiene', message: 'Table dirty', photo: png });
  assert.equal(r.status, 200);
  const comp = (await adm('/api/admin/complaints')).data.complaints[0];
  r = await adm(`/api/admin/complaints/${comp.id}`, { status: 'resolved', admin_note: 'Cleaned' }, 'PUT');
  assert.equal(r.status, 200);

  // student cannot reach admin APIs
  r = await stu('/api/admin/live');
  assert.equal(r.status, 403);

  // waste log → biogas
  r = await adm('/api/admin/waste', { date: T.localDate(), meal: 'Breakfast', prepared_kg: 50, wasted_kg: 10, sent_to_biogas_kg: '' });
  assert.equal(r.status, 200);
  r = await adm('/api/public/sustainability');
  assert.equal(r.data.wasted_kg, 10);
  assert.equal(r.data.biogas_m3, 1);

  r = await adm(`/api/admin/live?date=${tomorrow}`);
  const lunch = r.data.meals.find((m) => m.meal === 'Lunch');
  assert.equal(lunch.expected, 1);
  assert.equal(lunch.actual, 1);

  r = await adm('/api/admin/analytics?days=7');
  assert.ok(Array.isArray(r.data.daily));
  r = await adm(`/api/admin/report?from=${T.localDate()}&to=${tomorrow}`);
  assert.equal(r.status, 200);
  r = await adm(`/api/admin/report.csv?from=${T.localDate()}&to=${tomorrow}`);
  assert.match(r.data, /^date,meal,expected/);

  r = await stu('/api/stats/me');
  assert.equal(r.data.meals_attended, 1);
});
