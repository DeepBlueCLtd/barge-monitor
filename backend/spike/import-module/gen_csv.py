"""Generate an 'awkward' CSV for the S-IMPORT spike: 1 Hz rows, dd/MM/yyyy time, units in
headings, ';' separator, -9999 as the missing-value code (about 1 % of values).

    python gen_csv.py OUT.csv [ROWS] [START_EPOCH]
"""
import math, random, sys, datetime as dt

out = sys.argv[1]
rows = int(sys.argv[2]) if len(sys.argv) > 2 else 500_000
start = int(sys.argv[3]) if len(sys.argv) > 3 else 1735689600  # 2025-01-01T00:00:00Z
rnd = random.Random(42)
cols = ["Date Time (dd/mm/yyyy hh:mm:ss UTC)", "Air Temp (degC)", "RH (%)", "Pressure (hPa)",
        "Wind Speed (m/s)", "Wind Dir (deg)", "Water Temp (degC)", "Salinity (PSU)", "CO2 (ppm)"]
with open(out, "w", newline="\n") as f:
    f.write(";".join(cols) + "\n")
    for i in range(rows):
        t = dt.datetime.fromtimestamp(start + i, dt.timezone.utc)
        d = math.sin(2 * math.pi * i / 86400)
        v = [12 + 6 * d, 70 - 15 * d, 1013 + 5 * math.sin(i / 50000), 5 + 3 * abs(d), (i / 30) % 360,
             10 + 2 * d, 5 + 0.5 * math.cos(i / 7000), 420 + 20 * d]
        v = [x + rnd.gauss(0, 0.1) for x in v]
        vals = ["-9999" if rnd.random() < 0.01 else f"{x:.3f}" for x in v]
        f.write(t.strftime("%d/%m/%Y %H:%M:%S") + ";" + ";".join(vals) + "\n")
