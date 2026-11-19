// Worked examples for the analyst's workspace (FR-30). Each is an ordinary
// EDR client: it reads through the seam and may promote a result.
export const EXAMPLES: { id: string; title: string; code: string }[] = [
  {
    id: 'promote',
    title: 'Smoothed air temperature, promoted to the display',
    code: `# A minimal promotion (FR-29): compute a series and serve it at ws/collections/<name>.
# Change WINDOW and run again: the display updates without a page reload.
import edr

WINDOW = 300  # seconds

cov = await edr.get("collections/bow/trajectory", coords=await edr.route(),
                    datetime=await edr.recent(2), parameter_name="air_temperature")
df = edr.to_frame(cov)
smooth = df["air_temperature"].rolling(f"{WINDOW}s").mean()
edr.promote("smoothed-air-temperature",
            edr.trajectory(df.index, df.lon, df.lat, {f"air_temperature_mean_{WINDOW}s": smooth}, {f"air_temperature_mean_{WINDOW}s": "Cel"},
                           title=f"Air temperature, {WINDOW} s running mean"))
print(len(df), "records; last value", round(smooth.iloc[-1], 2))
`,
  },
  {
    id: 'tunnel',
    title: 'Tunnel detector (pandas)',
    code: `# Find the tunnel from the data alone: the GPS has no fix, the wind drops and
# it is dark even by day. Scored against nothing but common sense: compare
# with the chart on the map.
import edr
import numpy as np

cov = await edr.get("collections/bow/trajectory", coords=await edr.route(), datetime=await edr.recent(6),
                    parameter_name="apparent_wind_speed,solar_irradiance,air_temperature")
df = edr.to_frame(cov)
no_fix = df["position_qc"] > 0
calm = df["apparent_wind_speed"].rolling("60s").mean() < 1.0
in_tunnel = (no_fix & calm).astype(float)
runs = (in_tunnel.diff() == 1).sum()
print(f"{len(df)} records, {int(in_tunnel.sum())} s inside, {runs} tunnel passes")
edr.promote("tunnel-detector", edr.trajectory(df.index, df.lon, df.lat, {"in_tunnel": in_tunnel},
            title="Tunnel detector (workspace)", notes={"passes": int(runs)}))
`,
  },
  {
    id: 'lag',
    title: 'Bow and stern, before and after lag correction (numpy)',
    code: `# The stern reaches the bow's position L/v seconds later. Without correcting
# for that, every change looks like a gradient along the boat.
import edr
import numpy as np

route, when = await edr.route(), await edr.recent(3)
b = edr.to_frame(await edr.get("collections/bow/trajectory", coords=route, datetime=when, parameter_name="air_temperature"))
s = edr.to_frame(await edr.get("collections/stern/trajectory", coords=route, datetime=when, parameter_name="air_temperature"))
j = b.join(s, lsuffix="_b", rsuffix="_s", how="inner")
k = np.cos(np.radians(j.lat_b.mean()))
dx = (j.lon_b - j.lon_s) * 111320 * k
dy = (j.lat_b - j.lat_s) * 110540
L = float(np.nanmedian(np.hypot(dx, dy)))
mx = ((j.lon_b + j.lon_s) / 2 * 111320 * k).rolling(15, center=True).mean()
my = ((j.lat_b + j.lat_s) / 2 * 110540).rolling(15, center=True).mean()
v = np.hypot(mx.diff(), my.diff()).fillna(0).to_numpy()
t = (j.index - j.index[0]).total_seconds().to_numpy()
lag = np.where(v > 0.3, L / np.maximum(v, 0.3), 0.0)
stern_at = np.interp(t + lag, t, j.air_temperature_s.to_numpy())
raw = j.air_temperature_b - j.air_temperature_s
cor = j.air_temperature_b - stern_at
moving = v > 0.5
print(f"separation from GPS: {L:.1f} m")
print(f"RMS bow-stern, raw: {np.sqrt(np.nanmean(raw[moving]**2)):.3f} °C; lag corrected: {np.sqrt(np.nanmean(cor[moving]**2)):.3f} °C")
edr.promote("bow-minus-stern", edr.trajectory(j.index, j.lon_b, j.lat_b, {"raw": raw, "lag_corrected": cor}, {"raw": "Cel", "lag_corrected": "Cel"},
            title="Bow minus stern air temperature (workspace)"))
`,
  },
  {
    id: 'kmeans',
    title: 'Regimes with scikit-learn',
    code: `# Cluster readings into regimes with scikit-learn, from the derived
# coverage the analysis service serves. Compare with the service's own
# clustering and its score against the manifest on the Analysis tab.
import edr
import numpy as np
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

cov = await edr.get("collections/analysis-derived/trajectory", coords=await edr.route(), window_hours=12)
df = edr.to_frame(cov)
bow = edr.to_frame(await edr.get("collections/bow/trajectory", coords=await edr.route(), datetime=await edr.recent(12),
                                 parameter_name="air_temperature,relative_humidity,solar_irradiance,water_temperature"))
X = df[["pressure_reduced", "dew_point", "true_wind_speed", "air_minus_water"]].join(bow[["air_temperature", "solar_irradiance"]], how="inner").dropna()
labels = KMeans(n_clusters=4, n_init=4, random_state=0).fit_predict(StandardScaler().fit_transform(X))
print("cluster sizes:", np.bincount(labels))
edr.promote("sklearn-regimes", edr.trajectory(X.index, df.loc[X.index].lon, df.loc[X.index].lat, {"regime": labels},
            title="Regimes by k-means (workspace)"))
`,
  },
  {
    id: 'broken',
    title: 'A broken script (the backend keeps running)',
    code: `# FR-28: a failing script shows its error here; the display and the EDR
# server carry on. (An endless loop can be stopped with "Stop".)
import edr
clock = await edr.get("sim/clock")
print("backend answering at", clock["now"])
raise RuntimeError("this script is deliberately broken")
`,
  },
];
