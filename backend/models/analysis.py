"""Analysis: change detection, correlation and clustering (FR-34, FR-35a, FR-55).

Its input is a **data of interest** (§11): the display client's current selection, sent unsaved
as JSON in the ``doi`` parameter of a command on its ``clustering`` control stream, with the
algorithm, the number of clusters and the detector's sensitivity. Every bound is checked by
Analysis itself, which answers ``REJECTED`` naming it (FR-27).

It reads only Data cleanse's outputs and Summaries' (never the sensors' datastreams, AT-15),
taking each dataset's **latest run** (FR-35):

| resolution | reads                                           |
|------------|-------------------------------------------------|
| PT1S       | ``cleaned-<sensor>``, ``cleaned-co2-<sensor>``  |
| PT1M       | ``summary-1min-…``, ``derived-1min``            |
| PT1H       | ``summary-1h-…``, ``derived-1h``                |

Three clustering algorithms, unnamed on screen: A k-means (numpy), B a Gaussian mixture, C
agglomerative Ward clustering (scikit-learn). Each run is scored by the referee and **appended**
under its ``run_id`` (FR-28a): ``runs``, ``changes``, ``clusters`` and ``correlation`` (the matrix
as Text JSON, D-123), per dataset. A run whose sources include CO₂ is published only under the
restricted subsystem, its runs-log entry too (FR-112); a sender whose role lacks emissions is
refused (FR-112a), its role looked up in the delivered assignment (D-152).

Besides commands, it re-runs the current selection over the last ``span`` at every window of ten
replay minutes, aligned to the dataset's start (so the same at any rate, AT-34).
"""
from __future__ import annotations

import json

import numpy as np

import methods
from csmodel import (CO2_ROLES, URN, Model, NotReady, Rejected, boolean, category, count, dataset_id, from_iso, iso, quantity,
                     record, run_field, run_number, text, time_field)

KMEANS_SEED = 20310407  # Analysis's own named stream (FR-14)
MAX_CLUSTERS = 8
MAX_POINTS = 720  # cluster labels published per run, at most
RESOLUTIONS = {"PT1S": 1.0, "PT1M": 60.0, "PT1H": 3600.0}
DC, SUM = URN + "process:data-cleanse", URN + "process:summaries"
DERIVED = {"dew_point", "bow_minus_stern", "pressure_tendency_3h"}


def cluster(X, k, algorithm):
    if algorithm == "A":
        return methods.kmeans(X, k, seed=KMEANS_SEED), "numpy: k-means"
    if algorithm == "B":
        from sklearn.mixture import GaussianMixture

        g = GaussianMixture(n_components=k, covariance_type="full", random_state=KMEANS_SEED % (2 ** 31), n_init=1)
        return g.fit_predict(X), "scikit-learn: GaussianMixture"
    from sklearn.cluster import AgglomerativeClustering

    return AgglomerativeClustering(n_clusters=k, linkage="ward").fit_predict(X), "scikit-learn: AgglomerativeClustering(ward)"


def relabel(labels):
    order = {}
    for x in labels:
        order.setdefault(int(x), len(order) + 1)
    return [f"c{order[int(x)]}" for x in labels]


def is_co2(src: dict) -> bool:
    s, out = src.get("system", ""), src.get("output", "")
    return s.endswith(":co2") or s.endswith(":restricted") or "co2" in out or "co2" in src.get("fields", [])


def reading(src: dict, resolution: str) -> tuple[str, str]:
    """The datastream (system uid, output without dataset) a source is read from at a resolution."""
    system, out = src["system"], src["output"]
    res = {"PT1S": None, "PT1M": "1min", "PT1H": "1h"}[resolution]
    sensor = None
    if system.startswith(URN + "sensor:"):
        sensor = system.split(":")[3]
    elif out.startswith("cleaned-co2-"):
        sensor = out[len("cleaned-co2-"):]
    elif out.startswith("cleaned-"):
        sensor = out[len("cleaned-"):]
    if sensor is not None:
        co2 = is_co2(src)
        if res is None:
            return (DC + (":restricted" if co2 else ""), f"cleaned-{'co2-' if co2 else ''}{sensor}")
        return (SUM + (":restricted" if co2 else ""), f"summary-{res}-{'co2-' if co2 else ''}{sensor}")
    if out.startswith("derived-") and res is not None:
        return (system, f"derived-{res}")
    return (system, out)


DEFAULT = {"algorithm": "B", "clusters": 4, "sensitivity": 5.0, "resolution": "PT1S", "span": 3600.0,
           "sources": [{"system": URN + "sensor:bow", "output": "weather",
                        "fields": ["air_temperature", "apparent_wind_speed"]}]}


class Analysis(Model):
    id = "analysis"
    label = "Analysis"
    description = "Core model: change detection, correlation and clustering on a data of interest."
    max_rate = 10.0
    window = 600.0
    uses_co2 = True
    control = ("clustering", "Clustering", [
        category("algorithm", "Algorithm", ["A", "B", "C"]),
        text("doi", "Data of interest (JSON): dataset, start, end, resolution, sources"),
        count("clusters", "Number of clusters", 2, MAX_CLUSTERS),
        quantity("sensitivity", "Change detector sensitivity", "1", lo=1, hi=10)])

    def __init__(self):
        self.selection = dict(DEFAULT)
        self.out: dict[str, dict] = {}

    # --- registration ----------------------------------------------------------------------------
    def _schemas(self):
        return {
            "runs": [time_field("time", "Time the run ended"), text("run_id", "Analysis run"), run_field(),
                     text("command_id", "Command"), text("sender", "Sent by"), text("algorithm", "Algorithm"),
                     text("fields", "Fields"), text("sources", "Sources (JSON)"), text("resolution", "Resolution"),
                     time_field("window_start", "Data range: start"), time_field("window_end", "Data range: end"),
                     count("records", "Records used"), count("clusters", "Clusters"),
                     quantity("score_changes", "Score: changes found against the manifest", "1"),
                     quantity("score_clusters", "Score: clusters against the manifest (adjusted Rand index)", "1"),
                     text("scored_against", "What the clusters were scored against"),
                     boolean("illustrative", "Illustrative result (stand-in)")],
            "changes": [time_field(), text("run_id", "Analysis run"), run_field(),
                        category("scale", "Scale of the change", ["minutes", "hours"]),
                        quantity("strength", "Strength of the change", "1")],
            "clusters": [time_field(), text("run_id", "Analysis run"), run_field(),
                         category("cluster", "Cluster", [f"c{i}" for i in range(1, MAX_CLUSTERS + 1)])],
            "correlation": [time_field(), text("run_id", "Analysis run"), run_field(),
                            text("fields", "Fields, in matrix order"), text("matrix", "Pearson correlation (JSON)")],
        }

    async def datasets(self, api, ds):
        d = ds["id"]
        out = {}
        names = {"runs": "Analysis runs", "changes": "Detected changes", "clusters": "Clusters",
                 "correlation": "Correlation"}
        for where, sysid in (("open", self.system), ("restricted", self.restricted)):
            if sysid is None:
                continue
            for o, fields in self._schemas().items():
                out[(where, o)] = await api.create_datastream(sysid, {
                    "name": f"{names[o]} · {d}" + (" (restricted)" if where == "restricted" else ""),
                    "outputName": f"{o}__{d}", "schema": record(names[o], fields)})
        self.out[d] = out
        return True

    # --- commands --------------------------------------------------------------------------------
    def validate(self, api, cmd):
        super().validate(api, cmd)
        p = cmd["parameters"]
        try:
            doi = json.loads(p["doi"]) if isinstance(p["doi"], str) else p["doi"]
        except ValueError:
            raise Rejected("doi is not JSON")
        if not isinstance(doi, dict):
            raise Rejected("doi must be a data of interest object")
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
        if any(is_co2(s) for s in srcs) and api.role_of(cmd.get("sender", "")) not in CO2_ROLES:
            raise Rejected("a requested source is not available")  # FR-112a: whatever the client sent

    async def on_command(self, api, cmd):
        p = cmd["parameters"]
        doi = json.loads(p["doi"]) if isinstance(p["doi"], str) else p["doi"]
        t0, t1 = (float(x) for x in from_iso([doi["start"], doi["end"]]))
        self.selection = {"algorithm": p["algorithm"], "clusters": int(p["clusters"]),
                          "sensitivity": float(p["sensitivity"]), "resolution": doi["resolution"],
                          "span": t1 - t0, "sources": doi["sources"]}
        ds = dataset_id(doi["dataset"]["file"], doi["dataset"]["sha256"])
        st = await api.replay_state() or {}
        run = st.get("run", "") if st.get("dataset") == ds else ""
        if ds not in self.out:
            await self.datasets(api, {"id": ds})
        r = await self.analyse(api, ds, t0, t1 + 1, run, f"cmd-{cmd['id']}", cmd["id"], cmd.get("sender", ""))
        return f"{r['run_id']} over {r['records']} records"

    # --- runs ------------------------------------------------------------------------------------
    async def process(self, api, ds, t0, t1, run):
        lo = max(ds["start"], t1 - self.selection["span"])
        try:
            await self.analyse(api, ds["id"], lo, t1, run, f"{run}/{iso(t1)}", "", "", wait=t1 <= ds["end"])
        except Rejected as e:
            api.tap("models", f"no run: {e}", {"error": str(e)})

    async def _read_latest_run(self, api, key, t0, t1, fields):
        cols = await api.read(key, t0, t1 - 0.001, list(fields) + ["run"])
        runs = cols.get("run", np.empty(0, dtype=object))
        if len(runs):
            best = max(set(runs.tolist()), key=run_number)
            keep = np.asarray([r == best for r in runs], dtype=bool)
            cols = {k: np.asarray(v)[keep] for k, v in cols.items()}
        return cols

    async def analyse(self, api, d, t0, t1, run, run_id, command_id, sender, wait=False):
        s = self.selection
        res = s["resolution"]
        series = []
        for src in s["sources"]:
            uid, out = reading(src, res)
            key = await api.find(uid, f"{out}__{d}")
            if key is None:
                continue
            cols = await self._read_latest_run(api, key, t0, t1, src["fields"])
            if wait and (not len(cols["t"]) or cols["t"][-1] < t1 - RESOLUTIONS[res] or
                         (len(cols.get("run", [])) and cols["run"][-1] != run)):
                raise NotReady(f"{out} is not published up to {iso(t1)} for {run} yet")  # tried again
            for f in src["fields"]:
                if f in cols:
                    label = f if len(s["sources"]) == 1 else f"{src['output']}.{f}"
                    series.append((label, cols["t"], np.asarray(cols[f], dtype=float)))
        if not series:
            raise Rejected("none of the requested sources is published for this dataset")
        t = series[0][1]
        for _, tt, _ in series[1:]:
            t = np.intersect1d(t, tt)
        names = [n for n, _, _ in series]
        X = np.column_stack([v[np.searchsorted(tt, t)] for _, tt, v in series]) if len(t) else np.empty((0, len(series)))
        ok = ~np.isnan(X).any(axis=1)
        t, X = t[ok], X[ok]
        k = int(s["clusters"])
        if len(X) < max(k, 3):
            raise Rejected(f"only {len(X)} records in the period: too few to cluster")
        Z = (X - X.mean(axis=0)) / (X.std(axis=0) + 1e-9)
        step = max(1, int(np.ceil(len(Z) / MAX_POINTS)))
        api.tap("scilibs", f"cluster {len(Z[::step])} records, algorithm {s['algorithm']}",
                {"algorithm": s["algorithm"], "fields": names, "records": int(len(Z[::step])), "clusters": k})
        labels, how = cluster(Z[::step], k, s["algorithm"])
        tl = t[::step]
        step_s = RESOLUTIONS[res]
        if step_s <= 1:
            det = methods.detect_changes({"t": t, **{n.split(".")[-1]: X[:, j] for j, n in enumerate(names)}},
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
        against = "air masses" if t[-1] - t[0] >= 86400 * 0.9 else "reach kinds"
        cs = await api.score("clusters", {"t": [float(x) for x in tl], "labels": [int(x) for x in labels]})
        score_clusters = cs["ari_air_mass"] if against == "air masses" else cs["ari_reach_kind"]
        score_changes = sc.get("boundary_recall") if step_s <= 1 else sc.get("front_recall")
        where = "restricted" if any(is_co2(x) for x in s["sources"]) else "open"
        out = self.out[d]
        if (where, "runs") not in out:
            raise Rejected("a requested source is not available")  # this model has no access to CO₂ (FR-113)
        end = float(t1)
        for i in range(len(det["t"])):
            await api.publish(out[(where, "changes")], {"t": float(det["t"][i]), "run_id": run_id, "run": run,
                                                        "scale": "minutes" if det["scale"][i] == 0 else "hours",
                                                        "strength": round(float(det["strength"][i]), 2)})
        for tt, lab in zip(tl.tolist(), relabel(labels)):
            await api.publish(out[(where, "clusters")], {"t": tt, "run_id": run_id, "run": run, "cluster": lab})
        matrix = [[None if not np.isfinite(x) else round(float(x), 3) for x in row] for row in np.atleast_2d(R)]
        await api.publish(out[(where, "correlation")], {"t": end, "run_id": run_id, "run": run, "fields": ",".join(names),
                                                        "matrix": json.dumps(matrix)})
        await api.publish(out[(where, "runs")], {
            "t": end, "run_id": run_id, "run": run, "command_id": command_id, "sender": sender,
            "algorithm": s["algorithm"], "fields": ",".join(names), "sources": json.dumps(s["sources"]),
            "resolution": res, "window_start": float(t[0]), "window_end": float(t[-1]), "records": int(len(t)),
            "clusters": k, "score_changes": np.nan if score_changes is None else round(score_changes, 3),
            "score_clusters": np.nan if score_clusters is None else round(score_clusters, 3),
            "scored_against": against, "illustrative": False})
        return {"run_id": run_id, "records": int(len(t))}


MODEL = Analysis
