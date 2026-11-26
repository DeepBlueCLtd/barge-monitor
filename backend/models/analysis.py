"""Analysis: change detection, correlation and clustering (FR-34; the split is ADR 0003).

Analysis runs on the fields and period the display client selects, which reach
it as commands on its ``clustering`` control stream (FR-55). It reads only
Data cleanse's output and Summaries' summaries of it (AT-15):

| period        | reads                                   |
|---------------|-----------------------------------------|
| PT1M          | cleaned 1 s records                     |
| PT1H          | cleaned 1 s records, every 5 s          |
| PT6H, P1D     | 1-minute means                          |
| P7D, P28D     | hourly means                            |

Three clustering algorithms, unnamed on screen (FR-55): A is k-means (numpy),
B a Gaussian mixture and C agglomerative Ward clustering (scikit-learn). Each
run is scored by the demonstrator's referee against the manifest (FR-37) and
published with its settings and data range. Nothing is replaced (FR-28a): each
run's changes, clusters and correlation are appended, keyed by ``run_id``, and a
reader takes those of the latest run.
"""
from __future__ import annotations

import json

import numpy as np

import methods
from csmodel import Model, boolean, category, count, quantity, record, text, time_field

PERIODS = {"PT1M": 60.0, "PT1H": 3600.0, "PT6H": 6 * 3600.0, "P1D": 86400.0, "P7D": 7 * 86400.0, "P28D": 28 * 86400.0}
SENSOR_FIELDS = ["air_temperature", "apparent_wind_speed", "relative_humidity", "pressure",
                 "apparent_wind_direction", "solar_irradiance", "water_temperature"]
DERIVED_FIELDS = ["dew_point", "bow_minus_stern", "pressure_tendency_3h"]
KMEANS_SEED = 20310407  # Analysis's own named stream (FR-14)
MAX_CLUSTERS = 8


def kmeans(X, k):
    return methods.kmeans(X, k, seed=KMEANS_SEED)


def cluster(X, k, algorithm):
    """Labels for the rows of X (standardised), by algorithm A, B or C."""
    if algorithm == "A":
        return kmeans(X, k), "numpy: k-means"
    if algorithm == "B":
        from sklearn.mixture import GaussianMixture

        g = GaussianMixture(n_components=k, covariance_type="full", random_state=KMEANS_SEED % (2 ** 31), n_init=1)
        return g.fit_predict(X), "scikit-learn: GaussianMixture"
    from sklearn.cluster import AgglomerativeClustering

    return AgglomerativeClustering(n_clusters=k, linkage="ward").fit_predict(X), "scikit-learn: AgglomerativeClustering(ward)"


def relabel(labels):
    """c1, c2, … in order of first appearance, so colours stay steady between runs."""
    order = {}
    for x in labels:
        order.setdefault(int(x), len(order) + 1)
    return np.array([f"c{order[int(x)]}" for x in labels], dtype=object)


class Analysis(Model):
    id = "analysis"
    label = "Analysis"
    description = "Core model: publishes its own datastreams."
    interval = 600.0  # re-run the latest settings every ten simulated minutes
    command_interval = 1.0  # the display client's choices arrive as commands: look every simulated second
    start_from = "now"

    def __init__(self):
        self.settings = {"algorithm": "B", "fields": "air_temperature,apparent_wind_speed", "period": "PT1M",
                         "clusters": 4, "sensitivity": 5.0}
        self.src = {}
        self.out = {}
        self.runs = 0
        self.last_command = ""

    async def setup(self, api):
        await super().setup(api)
        defs = {
            "changes": [time_field(), text("run_id", "Run"), category("scale", "Scale of the change", ["minutes", "hours"]),
                        quantity("strength", "Strength of the change", "1")],
            "clusters": [time_field(), text("run_id", "Run"),
                         category("cluster", "Cluster", [f"c{i}" for i in range(1, MAX_CLUSTERS + 1)])],
            # The matrix is Text (JSON): OpenSensorHub refused an array of implicit size (§6).
            "correlation": [time_field(), text("run_id", "Run"), text("fields", "Fields, in matrix order"),
                            text("matrix", "Pearson correlation, as JSON rows")],
            "runs": [time_field("time", "Time the run completed"), text("run_id", "Run"), text("command_id", "Command"),
                     text("algorithm", "Algorithm"), text("fields", "Fields"), text("period", "Period"),
                     time_field("window_start", "Data range: start"), time_field("window_end", "Data range: end"),
                     count("records", "Records used"), count("clusters", "Clusters"),
                     quantity("score_changes", "Score: changes found against the manifest", "1"),
                     quantity("score_clusters", "Score: clusters against the manifest (adjusted Rand index)", "1"),
                     text("scored_against", "What the clusters were scored against"),
                     boolean("illustrative", "Illustrative result (stand-in)")],
        }
        names = {"changes": "Detected changes", "clusters": "Clusters", "correlation": "Correlation", "runs": "Runs"}
        for out, fields in defs.items():
            self.out[out] = await api.create_datastream(self.system, {
                "name": names[out], "outputName": out, "schema": record(names[out], fields)})
        self.control_key = await api.create_controlstream(self.system, {
            "name": "Clustering", "inputName": "clustering", "schema": record("Clustering settings", [
                category("algorithm", "Algorithm", ["A", "B", "C"]),
                text("fields", "Fields, comma-separated", SENSOR_FIELDS + DERIVED_FIELDS),
                category("period", "Period", list(PERIODS)),
                count("clusters", "Number of clusters", 2, MAX_CLUSTERS),
                quantity("sensitivity", "Change detector sensitivity", "1", lo=1, hi=10)])})


    async def on_command(self, api, cmd):
        self.settings.update(cmd["parameters"])
        self.last_command = cmd["id"]
        r = await self.run(api)
        return f"{r['run_id']} over {r['records']} records"

    async def initial(self, api):
        try:
            await self.run(api)
            return True
        except ValueError:
            return False  # its inputs are not there yet

    async def step(self, api, t0, t1):
        try:
            await self.run(api)
        except ValueError as e:
            api.tap("models", f"no run: {e}", {"error": str(e)})
        return t1

    async def _key(self, api, system, output):
        if self.src.get((system, output)) is None:  # never cache a miss: the other model may not have registered yet
            self.src[(system, output)] = await api.find(f"urn:x-barge:process:{system}", output)
        return self.src[(system, output)]

    async def _series(self, api, t0, t1, fields):
        """Sample times and one column per field, on the source the period calls for."""
        period = self.settings["period"]
        if period == "PT1M":
            key, dkey, step = await self._key(api, "data-cleanse", "cleaned-bow"), await self._key(api, "summaries", "derived-1min"), 1
        elif period == "PT1H":
            key, dkey, step = await self._key(api, "data-cleanse", "cleaned-bow"), await self._key(api, "summaries", "derived-1min"), 5
        elif period in ("PT6H", "P1D"):
            key, dkey, step = await self._key(api, "summaries", "summary-1min-bow"), await self._key(api, "summaries", "derived-1min"), 1
        else:
            key, dkey, step = await self._key(api, "summaries", "summary-1h-bow"), await self._key(api, "summaries", "derived-1h"), 1
        sf = [f for f in fields if f in SENSOR_FIELDS]
        df = [f for f in fields if f in DERIVED_FIELDS]
        base = await api.read(key, t0, t1, sf or ["air_temperature"]) if key else {"t": np.empty(0)}
        t = np.asarray(base["t"], dtype=float)[::step]
        cols = {f: np.asarray(base[f], dtype=float)[::step] for f in sf if f in base}
        if df and dkey:
            d = await api.read(dkey, t0 - 3600, t1, df)
            dt = np.asarray(d["t"], dtype=float)
            for f in df:
                if f in d and len(dt):
                    cols[f] = np.interp(t, dt, np.asarray(d[f], dtype=float), left=np.nan, right=np.nan)
        return t, cols, (1.0 * step if period in ("PT1M", "PT1H") else (60.0 if period in ("PT6H", "P1D") else 3600.0))

    async def run(self, api):
        s = self.settings
        t1 = api.now()
        t0 = max(0.0, t1 - PERIODS[s["period"]])
        fields = [f.strip() for f in s["fields"].split(",") if f.strip()]
        t, cols, step_s = await self._series(api, t0, t1, fields)
        names = [f for f in fields if f in cols]
        if not names:
            raise ValueError(f"none of the fields {fields} is published")
        X = np.column_stack([cols[f] for f in names])
        ok = ~np.isnan(X).any(axis=1)
        t, X = t[ok], X[ok]
        k = int(s["clusters"])
        if len(X) < max(k, 3):
            raise ValueError(f"only {len(X)} records in the period: too few to cluster")
        Z = (X - X.mean(axis=0)) / (X.std(axis=0) + 1e-9)
        api.tap("scilibs", f"cluster {len(Z)} records, algorithm {s['algorithm']}",
                {"algorithm": s["algorithm"], "fields": names, "records": int(len(Z)), "clusters": k})
        labels, how = cluster(Z, k, s["algorithm"])
        if step_s <= 5:
            det = methods.detect_changes({"t": t, **{f: cols[f][ok] for f in names}}, float(s["sensitivity"]))
            if not len(det["t"]):  # the 1 s detector looks at temperature, humidity, water and dew point only
                det = methods.detect_changes_coarse(t, [Z[:, j] for j in range(Z.shape[1])], float(s["sensitivity"]), step_s)
        else:
            det = methods.detect_changes_coarse(t, [Z[:, j] for j in range(Z.shape[1])], float(s["sensitivity"]), step_s)
        R = np.corrcoef(X, rowvar=False) if X.shape[1] > 1 else np.ones((1, 1))
        api.tap("models", f"{how}: {len(set(labels.tolist()))} clusters; {len(det['t'])} changes",
                {"method": how, "changes": int(len(det["t"]))})
        sc = await api.score("changes", {"t": [float(x) for x in det["t"]], "scale": [int(x) for x in det["scale"]],
                                         "t0": float(t[0]), "t1": float(t[-1])})
        against = "air masses" if PERIODS[s["period"]] >= 86400 else "reach kinds"
        cs = await api.score("clusters", {"t": [float(x) for x in t], "labels": [int(x) for x in labels]})
        score_clusters = cs["ari_air_mass"] if against == "air masses" else cs["ari_reach_kind"]
        score_changes = sc.get("boundary_recall") if step_s <= 5 else sc.get("front_recall")
        self.runs += 1
        run_id = f"run-{self.runs}"
        n = len(det["t"])
        await api.publish_many(self.out["changes"], {"t": np.asarray(det["t"], dtype=float), "run_id": [run_id] * n,
                                                "scale": ["minutes" if x == 0 else "hours" for x in det["scale"]],
                                                "strength": np.round(np.asarray(det["strength"], dtype=float), 2)})
        await api.publish_many(self.out["clusters"], {"t": t, "run_id": [run_id] * len(t), "cluster": relabel(labels)})
        await api.publish_many(self.out["correlation"], {"t": np.array([t1]), "run_id": [run_id], "fields": [",".join(names)],
                                                    "matrix": [json.dumps([[None if not np.isfinite(x) else round(float(x), 3) for x in row] for row in np.atleast_2d(R)])]})
        rec = {"t": np.array([t1]), "run_id": [run_id], "command_id": [self.last_command], "algorithm": [s["algorithm"]],
               "fields": [",".join(names)], "period": [s["period"]], "window_start": np.array([t[0]]),
               "window_end": np.array([t[-1]]), "records": np.array([len(t)]), "clusters": np.array([k]),
               "score_changes": np.array([np.nan if score_changes is None else round(score_changes, 3)]),
               "score_clusters": np.array([np.nan if score_clusters is None else round(score_clusters, 3)]),
               "scored_against": [against], "illustrative": np.array([0.0])}
        await api.publish_many(self.out["runs"], rec)
        return {"run_id": run_id, "records": len(t)}


MODEL = Analysis
