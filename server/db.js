// SQLite database (stored in data/wastewise.db). Uses Node's built-in sqlite,
// so there is nothing to compile and nothing to install besides Node itself.
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword } = require('./auth');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const DB_FILE = process.env.WW_DB || path.join(DATA_DIR, 'wastewise.db');
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  roll_no TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS face_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  descriptor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'booked',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(user_id, date, meal)
);
CREATE TABLE IF NOT EXISTS leaves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  from_date TEXT NOT NULL,
  to_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS guest_passes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  requested_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guest_name TEXT NOT NULL,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  amount REAL NOT NULL,
  paid INTEGER NOT NULL DEFAULT 0,
  payment_mode TEXT,
  paid_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  guest_pass_id INTEGER REFERENCES guest_passes(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  method TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_att_user ON attendance(user_id, date, meal) WHERE user_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS scan_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  date TEXT, meal TEXT,
  result TEXT NOT NULL,
  reason TEXT,
  user_id INTEGER,
  label TEXT,
  distance REAL
);
CREATE TABLE IF NOT EXISTS menu (
  day INTEGER NOT NULL,
  meal TEXT NOT NULL,
  items TEXT NOT NULL,
  PRIMARY KEY(day, meal)
);
CREATE TABLE IF NOT EXISTS complaints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  message TEXT NOT NULL,
  photo TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  admin_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'info',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS waste_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  meal TEXT NOT NULL,
  prepared_kg REAL NOT NULL DEFAULT 0,
  wasted_kg REAL NOT NULL,
  sent_to_biogas_kg REAL NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(date, meal)
);
CREATE TABLE IF NOT EXISTS slurry_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  quantity_kg REAL NOT NULL,
  used_for TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS ir_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  date TEXT NOT NULL,
  meal TEXT,
  direction TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

const MEALS = ['Breakfast', 'Lunch', 'Snacks', 'Dinner'];

const DEFAULT_SETTINGS = {
  meal_times: {
    Breakfast: { start: '07:30', end: '09:00' },
    Lunch: { start: '12:00', end: '14:00' },
    Snacks: { start: '16:30', end: '17:30' },
    Dinner: { start: '19:30', end: '21:30' },
  },
  booking_cutoff_hours: 2,     // bookings close this many hours before a meal starts
  booking_days_ahead: 7,
  email_domain: 'rvce.edu.in',
  plate_kg: 0.4,               // average cooked food per plate, used for leftover estimates
  guest_price: 80,             // rupees per guest meal
  biogas_m3_per_kg: 0.1,       // approx. biogas yield per kg of food waste
  slurry_kg_per_kg: 0.8,       // approx. digestate (slurry) per kg of food waste digested
  co2e_kg_per_kg: 1.9,         // approx. CO2-equivalent avoided per kg diverted from landfill
  face_match_threshold: 0.5,   // lower = stricter face matching
  scanner_key: 'wastewise-scanner-key',
};

const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
const putSetting = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function settings() {
  const out = {};
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    const row = getSetting.get(k);
    out[k] = row ? JSON.parse(row.value) : DEFAULT_SETTINGS[k];
  }
  return out;
}
function saveSettings(obj) {
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (obj[k] !== undefined) putSetting.run(k, JSON.stringify(obj[k]));
  }
}

const DEFAULT_MENU = {
  Breakfast: ['Idli, Vada, Sambar, Chutney', 'Poha, Banana, Tea/Coffee', 'Masala Dosa, Chutney', 'Upma, Kesari Bath', 'Aloo Paratha, Curd', 'Puri, Sagu', 'Bread Omelette / Bread Jam, Milk'],
  Lunch: ['Rice, Dal, Beans Palya, Curd, Chapati', 'Jeera Rice, Rajma, Chapati, Salad', 'Rice, Sambar, Cabbage Poriyal, Rasam', 'Veg Pulao, Raita, Dal Fry', 'Rice, Chole, Chapati, Buttermilk', 'Bisi Bele Bath, Curd Rice, Papad', 'Veg Biryani, Raita, Gulab Jamun'],
  Snacks: ['Samosa, Tea', 'Bhel Puri, Coffee', 'Bajji, Tea', 'Biscuits, Milk', 'Pav Bhaji', 'Masala Puri', 'Cake, Coffee'],
  Dinner: ['Chapati, Paneer Butter Masala, Rice, Dal', 'Rice, Sambar, Aloo Gobi, Chapati', 'Fried Rice, Gobi Manchurian', 'Chapati, Mixed Veg Curry, Rice, Rasam', 'Rice, Dal Tadka, Bhindi Fry, Chapati', 'Ragi Mudde, Saaru, Rice', 'Chapati, Kadai Veg, Rice, Payasam'],
};

function ensureDefaults() {
  const menuCount = db.prepare('SELECT COUNT(*) c FROM menu').get().c;
  if (!menuCount) {
    const ins = db.prepare('INSERT INTO menu(day, meal, items) VALUES(?,?,?)');
    for (const meal of MEALS) for (let d = 0; d < 7; d++) ins.run(d, meal, DEFAULT_MENU[meal][d]);
  }
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  if (!admin) {
    db.prepare("INSERT INTO users(name, email, roll_no, password_hash, role) VALUES(?,?,?,?, 'admin')")
      .run('Mess Warden', 'admin@rvce.edu.in', 'ADMIN', hashPassword('admin123'));
    console.log('Created default admin account: admin@rvce.edu.in / admin123');
  }
}
ensureDefaults();

module.exports = { db, MEALS, settings, saveSettings, UPLOAD_DIR, DATA_DIR, DEFAULT_SETTINGS };
