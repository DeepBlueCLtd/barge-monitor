// Worked examples for the analyst's workspace. Each is an ordinary Connected
// Systems client; the promoting ones register a product by standard resource
// creation (FR-36), one for each generic view type (FR-61, AT-08).
const HEAD = `import csapi
bow = await csapi.datastream("bow", "weather")
rows = await csapi.observations(bow["id"], phenomenonTime=await csapi.recent(2))
print(len(rows), "records from the bow sensor")
`;

export const EXAMPLES: { id: string; title: string; code: string }[] = [
  {
    id: 'quantity',
    title: 'Promote a Quantity: smoothed air temperature',
    code: `# Promote a product: a System, a datastream with a SWE Common schema, then observations.
# It reaches the display client at its next handshake: press "Restart client".
${HEAD}
import numpy as np
WINDOW = 300  # seconds
t = np.array([r["air_temperature"] if r["air_temperature"] is not None else np.nan for r in rows])
kernel = np.ones(WINDOW) / WINDOW
smooth = np.convolve(np.nan_to_num(t, nan=np.nanmean(t)), kernel, mode="same")
out = [{"time": r["time"], "air_temperature_smoothed": round(float(v), 2)} for r, v in zip(rows[::10], smooth[::10])]
await csapi.promote("smoothed-air-temperature", "Smoothed air temperature (workspace)",
                    [csapi.quantity("air_temperature_smoothed", f"Air temperature, {WINDOW} s mean", "Cel")], out)
`,
  },
  {
    id: 'category',
    title: 'Promote a Category: wind class',
    code: `${HEAD}
def wind_class(v):
    return None if v is None else "calm" if v < 1 else "light" if v < 4 else "moderate" if v < 8 else "fresh"
out = [{"time": r["time"], "wind_class": wind_class(r["apparent_wind_speed"])} for r in rows[::30]]
await csapi.promote("wind-class", "Wind class (workspace)",
                    [csapi.category("wind_class", "Wind class, bow", ["calm", "light", "moderate", "fresh"])], out)
`,
  },
  {
    id: 'count',
    title: 'Promote a Count: suspect readings per ten minutes',
    code: `${HEAD}
out = []
for i in range(0, len(rows), 600):
    block = rows[i:i + 600]
    n = sum(1 for r in block for k, v in r.items() if k.endswith("_qc") and v in ("3", "4"))
    out.append({"time": block[0]["time"], "suspect_readings": n})
await csapi.promote("suspect-readings", "Suspect readings (workspace)",
                    [csapi.count("suspect_readings", "QC-flagged readings per ten minutes, bow")], out)
`,
  },
  {
    id: 'angular',
    title: 'Promote an angular Quantity: wind direction, 1-minute median',
    code: `${HEAD}
import statistics
out = []
for i in range(0, len(rows), 60):
    vals = [r["apparent_wind_direction"] for r in rows[i:i + 60] if r["apparent_wind_direction"] is not None]
    if vals:
        out.append({"time": rows[i]["time"], "wind_direction_median": float(statistics.median(vals))})
await csapi.promote("wind-direction-median", "Wind direction median (workspace)",
                    [csapi.quantity("wind_direction_median", "Apparent wind direction, 1 min median", "deg")], out)
`,
  },
  {
    id: 'broken',
    title: 'A broken script (the server keeps answering)',
    code: `# A failing script shows its error here; the server keeps answering (FR-35, AT-13).
# An endless loop can be stopped with "Stop".
import csapi
landing = await csapi.get("")
print("server answering:", landing["title"])
raise RuntimeError("this script is deliberately broken")
`,
  },
];

let code = EXAMPLES[0].code;
export const editorText = { get: () => code, set: (c: string) => (code = c) };
