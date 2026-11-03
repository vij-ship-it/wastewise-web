# WasteWise Web

**Smart food-waste reduction for college messes.** Students pre-book their meals, walk in through a face-recognition scanner at the mess gate, and the warden sees live headcount, expected vs actual attendance, waste, biogas and slurry in one dashboard.

Everything runs **on your laptop**: a small Node.js server, a local SQLite database file and face recognition that runs inside the browser using the laptop webcam. No cloud account and no internet connection are needed once it's installed.

RVCE Experiential Learning project, Sustainability & Environment theme.
Team: Owais Sabir, Lakshya Sinha, Kaveesha Goyal, Vinayak Basavaraj Hokrani, Aditya Raj Ishwar.

---

## Quick start

You need **Node.js 22.13 or newer**. Install the **LTS** version from <https://nodejs.org> if you don't have it (version 24 LTS works).

### Windows

1. Install Node.js: download the **Windows Installer (.msi)** for the LTS version from <https://nodejs.org> and click through it with the default options.
2. Get the code. Either:
   - On the GitHub page click **Code → Download ZIP**, then right-click the ZIP and choose **Extract All**, or
   - If you have Git: `git clone https://github.com/vij-ship-it/wastewise-web.git`
3. Open the `wastewise-web` folder in File Explorer, click the address bar, type `cmd` and press Enter. A Command Prompt opens in that folder.
4. Run these commands one at a time:
   ```
   npm install
   npm run seed
   npm start
   ```
5. Open **Chrome or Edge** and go to <http://localhost:3000>

### Mac

1. Install Node.js: download the **macOS Installer (.pkg)** for the LTS version from <https://nodejs.org> and run it. (Or, with Homebrew: `brew install node`.)
2. Get the code. Either download the ZIP from GitHub (**Code → Download ZIP**, then double-click it), or run `git clone https://github.com/vij-ship-it/wastewise-web.git`
3. Open **Terminal** and go into the folder, for example:
   ```
   cd ~/Downloads/wastewise-web
   ```
4. Run:
   ```
   npm install
   npm run seed
   npm start
   ```
5. Open **Chrome, Safari or Edge** and go to <http://localhost:3000>

`npm install` downloads the libraries once (needs internet that one time). `npm run seed` is optional: it adds 60 demo students and 4 weeks of sample bookings, attendance and waste logs so the charts have data. Leave it out if you want a clean, empty system.

To stop the server press **Ctrl + C** in the terminal window. To start it again later, just run `npm start` in the same folder.

### Logins

| Who | Email | Password |
|---|---|---|
| Admin / warden | `admin@rvce.edu.in` | `admin123` |
| Demo student (only after `npm run seed`) | `demo@rvce.edu.in` | `student123` |

Change the admin password in **Admin → Settings** before using it for real.

### Pages

| Page | Address | Who uses it |
|---|---|---|
| Student portal | <http://localhost:3000/student> | Students (book meals, guest pass, leave, complaints) |
| Register | <http://localhost:3000/register> | New students (college email + face enrolment) |
| Admin dashboard | <http://localhost:3000/admin> | Mess warden / admin |
| Gate face scanner | <http://localhost:3000/scanner> | Laptop at the mess entrance |
| Public sustainability dashboard | <http://localhost:3000/sustainability> | Anyone, no login |

---

## Try the whole flow in 5 minutes

1. Go to **Register**, fill in your name, an `@rvce.edu.in` email, roll number and password. Allow the camera, press **Start face scan** and look at the camera until the bar fills.
2. You land on the student portal. Pick a day and press **Book** on a meal. (Bookings close 2 hours before a meal starts, so if today's meals are closed, book tomorrow's.)
3. Open a new tab, log in as admin, then open the **Gate face scanner**.
4. The scanner automatically uses the meal that is being served right now. If you are testing outside meal hours, pick the meal you booked in the **Session** box on the right (manual override) and set the date you booked it for.
5. Look at the webcam. You should see **ACCESS GRANTED** with your name. Try again and it says **ALREADY CHECKED IN**. Someone who isn't registered, or who didn't book, gets **ACCESS DENIED**.
6. Watch the admin **Live headcount** page update by itself.
7. For a guest: on the student portal open **Guest**, create a pass, then switch the scanner to **GUEST QR** and hold the QR code (on a phone screen) up to the webcam, or type the code.

---

## Features

Everything listed in the project report and poster is included.

**Student side**
- College email login. Only `@rvce.edu.in` addresses can register (the domain can be changed in Settings).
- One-time face enrolment at registration (5 samples), re-scan any time from Profile.
- Meal pre-booking for Breakfast, Lunch, Snacks and Dinner, up to 7 days ahead. Booking closes 2 hours before each meal.
- Weekly menu viewer.
- Attendance by face scan at the gate.
- Reminders: "booking closes in X min" and "your booked meal ends in X min", as pop-up browser notifications while the portal is open.
- Skip meal / vacation mode. Bookings in the date range are cancelled automatically so the kitchen stops counting them.
- Guest pass request with a single-use QR code, pay-per-meal.
- Complaints and feedback with an optional photo.
- Personal stats: booking history, meals attended, no-shows and show-up rate.

**Admin / warden side**
- Separate admin login with role-based access (students can't open admin pages or APIs).
- Live headcount per meal session that updates instantly when someone is scanned.
- Expected vs actual attendance, no-shows, estimated leftover food and a "cook for about X kg" suggestion for upcoming meals.
- Manual check-in for edge cases (forgot to book, face not matching).
- Bookings list per meal showing who has checked in.
- Guest pass management and payment log (cash / UPI / card).
- Daily waste log, which feeds the biogas tracker and slurry estimates.
- Agricultural slurry usage log.
- Announcements (special meals, closures, menu changes) pushed to every student.
- Complaint management: open → in progress → resolved, with a note back to the student.
- Weekly menu editor, meal timings and all rules in Settings.
- Analytics: meal-wise attendance trends, expected vs actual, waste reduction over time, no-show patterns by weekday and meal, students with most no-shows, guest meal frequency.
- Weekly and monthly reports: printable page (save as PDF) and CSV download.

**Face scanner (BioScan Pro screen)**
- Matches the face against registered students in real time.
- Checks there is a valid booking for the current meal before granting entry.
- Blocks unbooked or unregistered people and tells them to contact the admin.
- Blocks double entry for the same meal.
- Only one person in frame at a time.
- Guest entry by QR code as a fallback.
- Works on the admin's laptop, or on a separate gate laptop using the scanner key.

**Sustainability module**
- Leftover estimate = (booked + guest plates − people who actually came) × food per plate.
- Biogas estimate from food waste (default 0.1 m³ per kg) with a cumulative tracker.
- Slurry produced (estimate) and slurry used in agriculture (logged).
- CO₂-equivalent avoided and LPG equivalent.
- Public, read-only dashboard for all students.
- All conversion factors are editable in **Admin → Settings**.

**Optional IR sensor (from the poster)**
The poster describes an IR beam sensor at the door. That's supported as an extra headcount check: `hardware/ir_sensor/ir_sensor.ino` (Arduino) and `hardware/ir_bridge.py` send each beam break to the server, and the count appears on the Live headcount cards next to the face-scan count. You can test it without hardware using the **+1 IN / +1 OUT** buttons in Settings.

---

## How face recognition works

- The browser loads the face-api.js models from this laptop (`/models`) and computes a list of 128 numbers (a "face descriptor") for the face it sees.
- At registration, 5 descriptors are saved for the student. **No photos are stored.**
- At the gate, the scanner sends the descriptor to the server, which finds the closest registered student. If the distance is below the match threshold (default 0.5, editable in Settings) it's a match.
- The same face can't be registered to two accounts.

Tips: use good, even light on the face, and keep about 50 cm from the webcam. If a student is often not recognised, ask them to re-scan from Profile, or lower the threshold slightly. Raise it if strangers are being matched.

---

## Using other devices on the same Wi-Fi

When the server starts it prints an address like `http://192.168.1.20:3000`. Students can open that on their phones (same Wi-Fi) to book meals, request guest passes and so on.

Browsers only allow camera access on `localhost` or HTTPS, so **run the face scanner and face enrolment on the laptop that runs the server** (at `http://localhost:3000`). If you want a second laptop as the gate scanner, in Chrome on that laptop open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, add `http://<server-ip>:3000`, enable it and restart Chrome. Then open `/scanner` there and enter the scanner key from Settings.

On Windows, the first `npm start` may show a firewall prompt. Allow it on **private networks** if you want phones to connect.

---

## Useful commands

| Command | What it does |
|---|---|
| `npm start` | Start the server on port 3000 |
| `npm run seed` | Add demo students and 4 weeks of sample data |
| `npm run reset` | Delete **all** data and reload fresh demo data (stop the server first) |
| `npm test` | Run the automated end-to-end API test |

Use a different port: `PORT=4000 npm start` (Mac) or `set PORT=4000 && npm start` (Windows Command Prompt).

All data lives in `data/wastewise.db` (plus uploaded complaint photos in `data/uploads/`). Back up that folder to keep your data. Delete it to start completely empty (a fresh admin account is created on next start).

---

## Troubleshooting

- **"WasteWise needs Node.js 22.13 or newer"**: install the current LTS from nodejs.org, close and reopen the terminal, and check with `node -v`.
- **`npm` is not recognised (Windows)**: close and reopen Command Prompt after installing Node.js, or restart the laptop.
- **Camera doesn't start**: make sure you opened `http://localhost:3000` (not the 192.168… address), allow camera access in the browser, and close other apps that use the webcam (Zoom, Teams, Camera app). On Mac, also allow the browser in **System Settings → Privacy & Security → Camera**.
- **"Port 3000 is already in use"**: another copy is running. Close it, or use a different port as shown above.
- **Scanner says "No meal session is open right now"**: it's outside meal hours. Pick a meal in the Session box to test, or change the meal timings in Settings.
- **Face not recognised**: re-enrol in brighter light, look straight at the camera, and check only one face is in view.

---

## Project structure

```
server/
  index.js     web server and REST API (auth, bookings, scanner, admin, reports)
  db.js        SQLite tables, default settings and weekly menu
  auth.js      password hashing and login sessions
  time.js      date helpers (uses the laptop's local time)
  seed.js      demo data generator
public/
  index.html, login.html, register.html
  student.html  + js/student.js     student portal
  admin.html    + js/admin.js       admin dashboard
  scanner.html  + js/scanner.js     gate face scanner
  sustainability.html               public dashboard
  report.html                       printable weekly/monthly report
  js/face.js                        face detection and enrolment helpers
hardware/      optional IR sensor sketch and serial bridge
test/          automated end-to-end API test
data/          your database (created on first run, not committed)
```

**Tech stack:** Node.js + Express, SQLite (built into Node), HTML/CSS/JavaScript with Bootstrap 5, Chart.js for charts, face-api.js (TensorFlow.js) for face recognition, jsQR and qrcode for guest passes.

### REST API for hardware

A separate scanner device can call the API with the header `X-Scanner-Key: <key from Settings>`:

- `POST /api/scanner/identify` with `{ "descriptor": [128 numbers], "meal": "auto" }` returns `{ result: "granted" | "denied" | "duplicate", label, reason }`
- `POST /api/scanner/guest` with `{ "code": "WWGUEST:ABC123" }`
- `POST /api/sensor/ir` with `{ "direction": "in" | "out" }`
- `GET /api/scanner/status`

## License

MIT
