// Optional: IR beam-break headcount sensor at the mess door (from the EL poster).
// Wire an IR obstacle/beam sensor OUT pin to D2 (entry) and, optionally, a second one to D3 (exit).
// Each time someone breaks the beam, the board prints IN or OUT over USB serial.
// ir_bridge.py (in this folder) reads those lines and sends them to WasteWise on the laptop.

const int ENTRY_PIN = 2;
const int EXIT_PIN = 3;
const unsigned long DEBOUNCE_MS = 700;  // one person = one count

int lastEntry = HIGH, lastExit = HIGH;
unsigned long lastEntryTime = 0, lastExitTime = 0;

void setup() {
  Serial.begin(9600);
  pinMode(ENTRY_PIN, INPUT_PULLUP);
  pinMode(EXIT_PIN, INPUT_PULLUP);
}

void loop() {
  int e = digitalRead(ENTRY_PIN);
  int x = digitalRead(EXIT_PIN);
  unsigned long now = millis();
  // Most IR modules pull the pin LOW when something is in front of them.
  if (e == LOW && lastEntry == HIGH && now - lastEntryTime > DEBOUNCE_MS) { Serial.println("IN"); lastEntryTime = now; }
  if (x == LOW && lastExit == HIGH && now - lastExitTime > DEBOUNCE_MS) { Serial.println("OUT"); lastExitTime = now; }
  lastEntry = e; lastExit = x;
  delay(10);
}
