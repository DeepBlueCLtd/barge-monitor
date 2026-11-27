"""Analysis: change detection, correlation and clustering (FR-34, FR-35a, FR-55).

It reads only Data cleanse's output (AT-15), from Data cleanse's latest complete run on a dataset.

* **On import**, run 1 on each dataset: the whole dataset, the bow's air temperature, humidity, water
  temperature and pressure at the full resolution, k-means (algorithm A), four clusters.
* **A ``clustering`` command** starts one run on the dataset its ``doi`` names (§10.3): its sources, data
  range and resolution (``PT1S`` the readings; ``PT1M`` and ``PT1H`` their means, in intervals aligned to
  the dataset's start), with the command's algorithm, number of clusters and sensitivity.

Three clustering algorithms, unnamed on screen: A k-means (numpy), B a Gaussian mixture and C agglomerative
Ward clustering (scikit-learn). Each run is scored by the demonstrator's referee (FR-37) and its changes,
clusters and correlation are **appended** under its ``run_id`` (FR-28a). A run whose sources include CO₂ is
published only under the restricted subsystem, its runs-log entry too (FR-112); a command naming CO₂ from a
sender whose role lacks emissions is REJECTED (FR-112a), the role looked up in the delivered assignment.
"""
from __future__ import annotations

import json
import re

import numpy as np

import methods
from csmodel import (CO2_ROLES, SENSORS, Model, Rejected, category, dataset_id, from_iso, quantity, record, text,
                     time_field)

KMEANS_SEED = 20310407  # Analysis's own named stream (FR-14)
MAX_CLUSTERS = 8
MAX_POINTS = 720  # cluster labels published per run, at most
RESOLUTIONS = {"PT1S": 1.0, "PT1M": 60.0, "PT1H": 3600.0}
QUANTITIES = {"air_temperature", "apparent_wind_speed", "relative_humidity", "pressure", "apparent_wind_direction",
              "solar_irradiance", "water_temperature", "co2"}
DEFAULT = {"algorithm": "A", "clusters": 4, "sensitivity": 5.0, "resolution": "PT1S",
           "sources": [{"system": "urn:x-barge:sensor:bow", "output": "weather",
                        "fields": ["air_temperature", "relative_humidity", "water_temperature", "pressure"]}]}


def cluster(X, k, algorithm):
    """Labels for the rows of X (standardised), by algorithm A, B or C."""
    if algorithm == "A":
        return methods.kmeans(X, k, seed=KMEANS_SEED), "numpy: k-means"
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
    return [f"c{order[int(x)]}" for x in labels]


def reading(src: dict, field: str) -> tuple[str, str] | None:
    """Which of Data cleanse's outputs a requested field is read from (``bow``, ``co2-stern``, …), and the field;
    None for a field Data cleanse does not publish."""
    f = re.sub(r"_(min|max)$", "", field)
    if f not in QUANTITIES:
        return None
    where = f"{src.get('system', '')} {src.get('output', '')}"
    sensor = next((s for s in SENSORS if re.search(rf"(:|-|^){s}(:|$|\b)", where)), None)
    if sensor is None:
        return None
    co2 = f == "co2" or ":co2" in where or "co2" in str(src.get("output", ""))
    return (f"co2-{sensor}" if co2 else sensor), f


def names_co2(sources) -> bool:
    return any((reading(s, f) or ("", ""))[0].startswith("co2-") for s in sources for f in s.get("fields", []))


class Analysis(Model):
    id = "analysis"
    label = "Analysis"
    description = "Core model: change detection, correlation and clustering on a data of interest."
    window = None  # a run's whole data range at once: changes and clusters are not split into windows
    uses_co2 = True
    restricted_runs = True  # a run whose selection includes CO₂ is logged under the restricted subsystem (FR-112)
    control = ("clustering", "controlstreams/analysis-clustering.json")
    defaults = DEFAULT
    runs_master = "runs-analysis.json"

    def __init__(self):
        super().__init__()
        self.out: dict = {}  # dataset -> {(where, output): key}

    # --- declaring ------------------------------------------------------------------------------------
    def _schemas(self):
        return {
            "changes": record("Detected changes", [time_field(), text("run_id", "Analysis run"),
                                                   category("scale", "Scale of the change", ["minutes", "hours"]),
                                                   quantity("strength", "Strength of the change", "1")]),
            "clusters": record("Clusters", [time_field(), text("run_id", "Analysis run"),
                                            category("cluster", "Cluster", [f"c{i}" for i in range(1, MAX_CLUSTERS + 1)])]),
            "correlation": record("Correlation", [time_field(), text("run_id", "Analysis run"),
                                                  text("fields", "Fields, in matrix order"),
                                                  text("matrix", "Pearson correlation (JSON)")]),
        }

    async def outputs(self, api, ds):
        d = ds["id"]
        names = {"changes": "Detected changes", "clusters": "Clusters", "correlation": "Correlation"}
        out = {}
        for where, sysid in (("open", self.system), ("restricted", self.restricted)):
            for o, rec in self._schemas().items():
                out[(where, o)] = await api.create_datastream(sysid, {
                    "name": f"{names[o]} · {d}" + (" (restricted)" if where == "restricted" else ""),
                    "outputName": f"{o}__{d}", "schema": rec})
        self.out[d] = out
        return True

    # --- runs ---------------------------------------------------------------------------------------------
    def wanted(self, ds, complete):
        return None if complete else dict(DEFAULT)  # run 1 on import; later runs only on command

    def entry(self, run):
        s = run.settings
        return {"start": run.start, "end": run.end - 1.0, "algorithm": s["algorithm"], "resolution": s["resolution"],
                "sensitivity": float(s["sensitivity"]), "clusters": int(s["clusters"]), "records": 0,
                "score_changes": np.nan, "score_clusters": np.nan}

    # --- commands -----------------------------------------------------------------------------------------
    def validate(self, api, cmd):
        super().validate(api, cmd)
        p = cmd["parameters"]
        try:
            doi = json.loads(p["doi"]) if isinstance(p["doi"], str) else p["doi"]
        except ValueError:
            raise Rejected("doi is not a data of interest (JSON)")
        if not isinstance(doi, dict):
            raise Rejected("doi is not a data of interest (JSON)")
        dsr = doi.get("dataset") or {}
        if not isinstance(dsr, dict) or not dsr.get("file") or not dsr.get("sha256"):
            raise Rejected("doi.dataset must name the file and its sha256")
        try:
            t0, t1 = from_iso([doi["start"], doi["end"]])
        except (KeyError, ValueError, TypeError):
            raise Rejected("doi.start and doi.end must be ISO 8601 times")
        if t1 <= t0:
            raise Rejected("doi.end must be after doi.start")
        if doi.get("resolution") not in RESOLUTIONS:
            raise Rejected(f"doi.resolution {doi.get('resolution')!r} has no datastream; available: PT1S, PT1M, PT1H")
        srcs = doi.get("sources")
        if not isinstance(srcs, list) or not srcs or not all(
                isinstance(s, dict) and s.get("system") and s.get("output") and isinstance(s.get("fields"), list)
                and s["fields"] for s in srcs):
            raise Rejected("doi.sources must name at least one source with its system, output and fields")
        if names_co2(srcs) and api.role_of(cmd.get("sender") or "") not in CO2_ROLES:
            raise Rejected("a requested source is not available")  # FR-112a: whatever the client sent
        if any(reading(s, f) is None for s in srcs for f in s["fields"]):
            raise Rejected("a requested source is not available")

    async def on_command(self, api, cmd):
        p = cmd["parameters"]
        doi = json.loads(p["doi"]) if isinstance(p["doi"], str) else p["doi"]
        t0, t1 = (float(x) for x in from_iso([doi["start"], doi["end"]]))
        settings = {"algorithm": p["algorithm"], "clusters": int(p["clusters"]), "sensitivity": float(p["sensitivity"]),
                    "resolution": doi["resolution"], "sources": doi["sources"]}
        return {"dataset": dataset_id(doi["dataset"]["file"], doi["dataset"]["sha256"]), "settings": settings,
                "restricted": names_co2(doi["sources"]), "start": t0, "end": t1 + 1.0}

    # --- one run ------------------------------------------------------------------------------------------
    async def _series(self, api, ds, t0, t1, run):
        """The selection's fields from Data cleanse's output, at the run's resolution, on common times."""
        s = run.settings
        step = RESOLUTIONS[s["resolution"]]
        need: dict = {}
        for src in s["sources"]:
            for f in src["fields"]:
                where, name = reading(src, f)
                need.setdefault(where, [])
                if name not in need[where]:
                    need[where].append(name)
        series = []
        for where, names in need.items():
            cols = await self.read_cleaned(api, ds["id"], where, t0, t1, run.source, names)
            t = cols["t"]
            for n in names:
                v = np.asarray(cols.get(n, np.full(len(t), np.nan)), dtype=float)
                if step > 1:  # means in intervals aligned to the dataset's start
                    b = ds["start"] + np.floor((t - ds["start"]) / step) * step
                    ok = np.isfinite(v)
                    keys, inv = np.unique(b[ok], return_inverse=True)
                    sums = np.bincount(inv, weights=v[ok], minlength=len(keys))
                    cnt = np.bincount(inv, minlength=len(keys))
                    tt, vv = keys, sums / np.maximum(cnt, 1)
                else:
                    tt, vv = t, v
                label = n if len(need) == 1 else f"{where}.{n}"
                series.append((label, n, np.asarray(tt, dtype=float), vv))
        if not series:
            return [], np.empty(0), np.empty((0, 0))
        t = series[0][2]
        for _, _, tt, _ in series[1:]:
            t = np.intersect1d(t, tt)
        X = np.column_stack([v[np.searchsorted(tt, t)] for _, _, tt, v in series]) if len(t) else np.empty((0, len(series)))
        ok = ~np.isnan(X).any(axis=1)
        return series, t[ok], X[ok]

    async def process(self, api, ds, t0, t1, run):
        s = run.settings
        series, t, X = await self._series(api, ds, t0, t1, run)
        names = [label for label, _, _, _ in series]
        k = int(s["clusters"])
        if len(X) < max(k, 3):
            run.result = {"records": int(len(X))}
            api.tap("models", f"too few records to analyse: {len(X)}", {"records": int(len(X))})
            return
        Z = (X - X.mean(axis=0)) / (X.std(axis=0) + 1e-9)
        stride = max(1, int(np.ceil(len(Z) / MAX_POINTS)))
        api.tap("scilibs", f"cluster {len(Z[::stride])} records, algorithm {s['algorithm']}",
                {"algorithm": s["algorithm"], "fields": names, "records": int(len(Z[::stride])), "clusters": k})
        labels, how = cluster(Z[::stride], k, s["algorithm"])
        tl = t[::stride]
        step_s = RESOLUTIONS[s["resolution"]]
        if step_s <= 1:
            det = methods.detect_changes({"t": t, **{n: X[:, j] for j, (_, n, _, _) in enumerate(series)}},
                                         float(s["sensitivity"]))
            if not len(det["t"]):
                det = methods.detect_changes_coarse(t[::5], [Z[::5, j] for j in range(Z.shape[1])],
                                                    float(s["sensitivity"]), 5.0)
        else:
            det = methods.detect_changes_coarse(t, [Z[:, j] for j in range(Z.shape[1])], float(s["sensitivity"]), step_s)
        R = np.corrcoef(X, rowvar=False) if X.shape[1] > 1 else np.ones((1, 1))
        api.tap("models", f"{how}: {len(set(np.asarray(labels).tolist()))} clusters; {len(det['t'])} changes",
                {"method": how, "changes": int(len(det["t"]))})
        sc = await api.score("changes", {"t": [float(x) for x in det["t"]], "scale": [int(x) for x in det["scale"]],
                                         "t0": float(t[0]), "t1": float(t[-1])})
        cs = await api.score("clusters", {"t": [float(x) for x in tl], "labels": [int(x) for x in labels]})
        against_air_masses = t[-1] - t[0] >= 0.9 * 86400
        score_clusters = cs.get("ari_air_mass") if against_air_masses else cs.get("ari_reach_kind")
        score_changes = sc.get("boundary_recall") if step_s <= 1 else sc.get("front_recall")
        where = "restricted" if run.restricted else "open"
        out = self.out[ds["id"]]
        rid = run.id
        await api.publish_many(out[(where, "changes")], {
            "t": np.asarray(det["t"], dtype=float), "run_id": np.array([rid] * len(det["t"]), dtype=object),
            "scale": np.array(["minutes" if x == 0 else "hours" for x in det["scale"]], dtype=object),
            "strength": np.round(np.asarray(det["strength"], dtype=float), 2)})
        await api.publish_many(out[(where, "clusters")], {
            "t": tl, "run_id": np.array([rid] * len(tl), dtype=object), "cluster": np.array(relabel(labels), dtype=object)})
        matrix = [[None if not np.isfinite(x) else round(float(x), 3) for x in row] for row in np.atleast_2d(R)]
        await api.publish(out[(where, "correlation")], {"t": float(t[-1]), "run_id": rid, "fields": ",".join(names),
                                                        "matrix": json.dumps(matrix)})
        run.result = {"records": int(len(t)),
                      "score_changes": np.nan if score_changes is None else round(float(score_changes), 3),
                      "score_clusters": np.nan if score_clusters is None else round(float(score_clusters), 3)}


MODEL = Analysis
