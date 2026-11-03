// Fills the database with 4 weeks of realistic demo data so the dashboards have something to show.
// Run:  npm run seed          (adds demo data to the existing database)
//       npm run reset         (deletes everything and starts fresh with demo data)
const fs = require('fs');
const path = require('path');

if (process.argv.includes('--reset')) {
  const file = process.env.WW_DB || path.join(__dirname, '..', 'data', 'wastewise.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    try { fs.unlinkSync(f); } catch {}
  }
  console.log('Old database removed.');
}

const { db, MEALS, settings } = require('./db');
const { hashPassword } = require('./auth');
const T = require('./time');

if (db.prepare("SELECT COUNT(*) c FROM users WHERE email = 'demo@rvce.edu.in'").get().c) {
  console.log('Demo data is already loaded. Use `npm run reset` to start over.');
  process.exit(0);
}

let seed = 42;
const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const first = ['Aarav', 'Diya', 'Rohan', 'Ananya', 'Karthik', 'Sneha', 'Aditya', 'Meera', 'Vikram', 'Priya', 'Rahul', 'Kavya', 'Arjun', 'Isha', 'Nikhil', 'Pooja', 'Siddharth', 'Riya', 'Varun', 'Tanvi', 'Harsh', 'Nisha', 'Manoj', 'Shreya', 'Akash', 'Divya', 'Gautam', 'Lakshmi', 'Pranav', 'Bhavana'];
const last = ['Sharma', 'Rao', 'Iyer', 'Reddy', 'Gowda', 'Patel', 'Nair', 'Kulkarni', 'Hegde', 'Shetty', 'Menon', 'Joshi', 'Verma', 'Bhat', 'Pillai'];
const branches = ['CS', 'AI', 'EC', 'CV', 'ME', 'IS'];

const pw = hashPassword('student123');
const insUser = db.prepare("INSERT INTO users(name, email, roll_no, password_hash, role, created_at) VALUES(?,?,?,?, 'student', ?)");
const start = T.addDays(T.localDate(), -27);
const ids = [];
db.exec('BEGIN');
ids.push(Number(insUser.run('Demo Student', 'demo@rvce.edu.in', '1RV25CS000', pw, `${start} 09:00:00`).lastInsertRowid));
const used = new Set();
for (let i = 0; i < 59; i++) {
  let f, l;
  do { f = pick(first); l = pick(last); } while (used.has(f + l));
  used.add(f + l);
  const br = pick(branches);
  const roll = `1RV25${br}${String(100 + i).padStart(3, '0')}`;
  ids.push(Number(insUser.run(`${f} ${l}`, `${f}.${l}${i}@rvce.edu.in`.toLowerCase(), roll, pw, `${start} 09:00:00`).lastInsertRowid));
}
// A few habitual no-show students, so the no-show detection has something to find.
const flaky = new Set(ids.slice(5, 10));

const s = settings();
const insB = db.prepare("INSERT OR IGNORE INTO bookings(user_id, date, meal, status, created_at) VALUES(?,?,?, 'booked', ?)");
const insA = db.prepare('INSERT OR IGNORE INTO attendance(user_id, date, meal, method, created_at) VALUES(?,?,?,?,?)');
const insW = db.prepare('INSERT OR IGNORE INTO waste_logs(date, meal, prepared_kg, wasted_kg, sent_to_biogas_kg, notes) VALUES(?,?,?,?,?,?)');
const insG = db.prepare('INSERT INTO guest_passes(code, requested_by, guest_name, date, meal, amount, paid, payment_mode, paid_at, status, used_at, created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)');
const insGA = db.prepare("INSERT INTO attendance(guest_pass_id, date, meal, method, created_at) VALUES(?,?,?, 'qr', ?)");
const mealPop = { Breakfast: 0.7, Lunch: 0.9, Snacks: 0.55, Dinner: 0.85 };
const now = new Date();
const today = T.localDate();

for (let dayIdx = 0; dayIdx < 30; dayIdx++) {
  const date = T.addDays(start, dayIdx);
  if (date > T.addDays(today, 1)) break;
  const wd = T.weekday(date);
  const weekend = wd >= 5;
  const progress = dayIdx / 27; // waste per plate drops as students get used to booking
  for (const meal of MEALS) {
    const { start: ms, end: me } = { start: T.at(date, s.meal_times[meal].start), end: T.at(date, s.meal_times[meal].end) };
    let booked = 0, came = 0;
    for (const uid of ids) {
      if (uid === ids[0] && date >= today) continue; // leave today's bookings to the person demoing
      const p = mealPop[meal] * (weekend ? 0.6 : 1);
      if (rand() > p) continue;
      insB.run(uid, date, meal, `${T.addDays(date, -1)} 20:00:00`);
      booked++;
      if (me > now) continue; // future or ongoing meal: no attendance yet
      const showP = flaky.has(uid) ? 0.45 : 0.92 - (weekend ? 0.05 : 0);
      if (rand() < showP) {
        const t = new Date(ms.getTime() + rand() * (me - ms) * 0.8);
        insA.run(uid, date, meal, rand() < 0.95 ? 'face' : 'manual', T.localDateTime(t));
        came++;
      }
    }
    if (me > now) continue;
    // guests
    const nGuests = rand() < (weekend ? 0.6 : 0.3) ? 1 + Math.floor(rand() * 3) : 0;
    for (let g = 0; g < nGuests; g++) {
      const paid = rand() < 0.85 ? 1 : 0;
      const t = T.localDateTime(new Date(ms.getTime() + rand() * (me - ms) * 0.8));
      const r = insG.run(Math.floor(rand() * 1e10).toString(16).toUpperCase().padStart(10, '0'), pick(ids), `${pick(first)} (guest)`, date, meal, s.guest_price,
        paid, paid ? pick(['Cash', 'UPI', 'UPI']) : null, paid ? t : null, 'used', t, `${date} 08:00:00`);
      insGA.run(Number(r.lastInsertRowid), date, meal, t);
      came++;
    }
    // waste log: grams wasted per plate falls from ~140 g to ~70 g over the month
    const perPlate = (0.14 - 0.07 * progress) * (0.85 + rand() * 0.3);
    const wasted = Math.round(came * perPlate * 10) / 10;
    const prepared = Math.round((came * s.plate_kg + wasted) * 10) / 10;
    insW.run(date, meal, prepared, wasted, Math.round(wasted * 0.9 * 10) / 10, '');
  }
}

const insS = db.prepare('INSERT INTO slurry_logs(date, quantity_kg, used_for, notes) VALUES(?,?,?,?)');
for (let w = 0; w < 4; w++) insS.run(T.addDays(start, 6 + w * 7), 40 + Math.round(rand() * 25), pick(['Campus garden', 'Horticulture dept. nursery', 'Nearby farm (Kengeri)']), 'Digestate from biogas plant');

const insC = db.prepare("INSERT INTO complaints(user_id, category, message, status, admin_note, created_at) VALUES(?,?,?,?,?,?)");
insC.run(ids[3], 'Food quality', 'Dal was too salty at lunch today.', 'resolved', 'Spoke to the cook, fixed from next day.', `${T.addDays(today, -9)} 14:10:00`);
insC.run(ids[12], 'Hygiene', 'Water dispenser near counter 2 is leaking.', 'in_progress', 'Plumber called.', `${T.addDays(today, -3)} 13:05:00`);
insC.run(ids[20], 'Booking', 'I booked dinner but the scanner said no booking.', 'open', null, `${T.addDays(today, -1)} 20:15:00`);

const insN = db.prepare('INSERT INTO announcements(title, body, kind, created_at) VALUES(?,?,?,?)');
insN.run('Welcome to WasteWise Web', 'Please book your meals at least 2 hours in advance. Every plate you skip without booking saves food!', 'info', `${start} 08:00:00`);
insN.run('Special dinner on Friday', 'Festival special: Veg biryani, paneer tikka and gulab jamun this Friday. Book early!', 'special', `${T.addDays(today, -2)} 10:00:00`);
db.exec('COMMIT');

console.log(`Demo data loaded: ${ids.length} students, 4 weeks of bookings, attendance, waste and biogas logs.`);
console.log('Demo student login: demo@rvce.edu.in / student123');
console.log('Admin login:        admin@rvce.edu.in / admin123');
