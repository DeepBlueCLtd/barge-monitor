"""Check through the Connected Systems API that an imported CSV is all there (S-IMPORT).

    python verify_import.py API_ROOT CSV_FILE OUTPUT_NAME_PREFIX

Prints one JSON object: systems found, the datastream's time span, the number of
observations in sampled windows against the number of CSV rows in them, and every
sampled value compared with the CSV (-9999 must come back as NaN).
"""
import csv, datetime as dt, json, math, sys, urllib.request

api, path, prefix = sys.argv[1:4]
get = lambda u: json.load(urllib.request.urlopen(api + u, timeout=120))

def get_all(u, page=10000):
    """The server caps a page at 10,000 whatever limit asks for: page by offset."""
    items, off = [], 0
    while True:
        got = get(f"{u}&limit={page}&offset={off}")["items"]
        items += got; off += len(got)
        if len(got) < page:
            return items

def parse(s):
    return dt.datetime.strptime(s, "%d/%m/%Y %H:%M:%S").replace(tzinfo=dt.timezone.utc)

rows = {}
with open(path) as f:
    r = csv.reader(f, delimiter=";"); header = next(r)
    for line in r:
        rows[parse(line[0])] = [float("nan") if v == "-9999" else float(v) for v in line[1:]]
times = sorted(rows)

out = {"systems": [s["properties"]["uid"] for s in get("/systems")["items"]]}
ds = [d for d in get("/datastreams?limit=100")["items"] if d["outputName"].startswith(prefix)]
out["datastreams"] = [d["outputName"] for d in ds]
d = ds[-1]
out["datastreamID"] = d["id"]; out["phenomenonTime"] = d.get("phenomenonTime")
fields = ["airTemp", "relHumidity", "airPressure", "windSpeed", "windDir", "waterTemp", "salinity", "co2"]

windows = []
for start, secs in [(times[0], 3600), (times[len(times) // 2], 86400), (times[-1] - dt.timedelta(seconds=599), 600)]:
    end = start + dt.timedelta(seconds=secs - 1)
    iso = lambda t: t.strftime("%Y-%m-%dT%H:%M:%SZ")
    t0 = dt.datetime.now()
    obs = get_all(f"/datastreams/{d['id']}/observations?phenomenonTime={iso(start)}/{iso(end)}")
    took = (dt.datetime.now() - t0).total_seconds()
    expected = [t for t in times if start <= t <= end]
    mismatches = 0
    for o in obs:
        t = dt.datetime.fromisoformat(o["phenomenonTime"].replace("Z", "+00:00"))
        ref = rows.get(t)
        got = [o["result"][k] for k in fields]
        got = [float("nan") if v in ("NaN", None) else float(v) for v in got]
        if ref is None or any(not (math.isnan(a) and math.isnan(b)) and abs(a - b) > 1e-9 for a, b in zip(got, ref)):
            mismatches += 1
    windows.append({"from": iso(start), "to": iso(end), "csvRows": len(expected), "returned": len(obs),
                    "valueMismatches": mismatches, "httpSeconds": round(took, 2)})
out["windows"] = windows
t0 = dt.datetime.now()
allobs = get_all(f"/datastreams/{d['id']}/observations?phenomenonTime=../..")
out["fullCount"] = {"csvRows": len(times), "returned": len(allobs),
                    "distinctTimes": len({o["phenomenonTime"] for o in allobs}),
                    "httpSeconds": round((dt.datetime.now() - t0).total_seconds(), 1)}
del allobs
cat = [x for x in get("/datastreams?limit=100")["items"] if x["outputName"] == "catalogue"]
if cat:
    latest = get(f"/datastreams/{cat[0]['id']}/observations?limit=1000")["items"]
    out["catalogueObservations"] = len(latest)
    out["catalogueLatest"] = latest[-1]["result"] if latest else None
print(json.dumps(out, indent=1))
