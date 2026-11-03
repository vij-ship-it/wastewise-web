"""Optional: forwards IN/OUT lines from the Arduino IR sensor to WasteWise.

    pip install pyserial
    python ir_bridge.py COM3            (Windows; check the port in Arduino IDE)
    python3 ir_bridge.py /dev/tty.usbmodem1101   (Mac)

The counts show up on the admin Live headcount page next to the face-scan count.
"""
import json
import sys
import urllib.request

import serial  # pyserial

SERVER = "http://localhost:3000/api/sensor/ir"
SCANNER_KEY = "wastewise-scanner-key"  # must match Admin -> Settings -> Scanner key


def send(direction):
    req = urllib.request.Request(
        SERVER,
        data=json.dumps({"direction": direction}).encode(),
        headers={"Content-Type": "application/json", "X-Scanner-Key": SCANNER_KEY},
    )
    try:
        urllib.request.urlopen(req, timeout=3).read()
        print("sent", direction)
    except Exception as exc:  # keep running even if the server is restarting
        print("could not reach WasteWise:", exc)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    port = serial.Serial(sys.argv[1], 9600, timeout=1)
    print("Listening on", sys.argv[1])
    while True:
        line = port.readline().decode(errors="ignore").strip().upper()
        if line in ("IN", "OUT"):
            send(line.lower())


if __name__ == "__main__":
    main()
