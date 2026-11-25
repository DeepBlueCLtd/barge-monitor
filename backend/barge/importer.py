"""The CSV importer (C-03, FR-20 to FR-22, FR-109, FR-110; docs/v4-interfaces.md §7).

A module of the data server: it runs inside the server, under its own service account
(``svc-importer``), and writes **in bulk** into the server's store (FR-20a). It is the only
code that understands the CSV files, through ``dialect.parse`` (a port: AT-03 swaps it).

* System ``urn:x-barge:importer`` with the ``catalogue`` datastream (one observation per file
  per change of status) and the ``import`` control stream (``action`` import or rescan,
  ``file``), to which it subscribes before it lists the folder.
* An import reads the file through the folder, maps its columns to the declared fields and
  units, computes the QARTOD flags, creates the dataset's datastreams under the sensors and the
  CO₂ analysers (CO₂ never in the weather record, FR-21c) and writes every row.
* A file whose name matches an imported one but whose size, date or hash differ is imported as
  a new dataset; the earlier one becomes ``superseded`` and stays (FR-21a). Files that overlap
  in time are kept apart, each in its own datastreams (FR-21b).

Capture (§2): ``importer → folder`` S (list, read), ``folder → importer`` L (the listing, the
first three rows and a count), ``importer → server`` I (one per 1,000 rows written, and each
catalogue observation), ``server → importer`` K (a pushed command).
"""
from __future__ import annotations

import asyncio
import re

import numpy as np

from . import clock
from . import config as C
from . import dialect
from . import qc
from . import swe
from .fields import QUANTITIES
from .store import URN
from .times import iso, parse_iso

UID = URN + "importer"
STATUSES = ("not-imported", "importing", "imported", "changed", "superseded")
SENSORS = ("bow", "stern")


def dataset_id(file: str, sha256: str) -> str:
    """``<slug>-<h8>`` (§6)."""
    stem = file[:-4] if file.lower().endswith(".csv") else file
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return f"{slug}-{sha256[:8]}"


def catalogue_schema() -> dict:
    return swe.record([
        swe.time_field("time", "Status changed at"), swe.text("file", "File"), swe.count("size", "Size, bytes"),
        swe.time_value("modified", "Modified"), swe.text("sha256", "Content hash (SHA-256)"),
        swe.text("dataset", "Dataset"), swe.time_value("start", "Start"), swe.time_value("end", "End"),
        swe.count("records", "Records"), swe.category("status", "Status", STATUSES),
        swe.count("pct", "Imported, %", 0, 100)], "Archive catalogue")


def import_schema() -> dict:
    return swe.record([swe.category("action", "Action", ["import", "rescan"]),
                       swe.text("file", "File (empty for rescan)")], "Import")


class Importer:
    def __init__(self, rt, folder, parser=None):
        self.rt = rt
        self.folder = folder
        self.parse = parser or dialect.parse
        self.rate = None  # rows per second of the last import (FR-110)
        self.reset()

    def reset(self) -> None:
        self.datasets: dict[str, dict] = {}
        self.listing: list[dict] = []
        self.current: dict[str, dict] = {}  # file -> latest catalogue entry
        self.published: dict[tuple, str] = {}  # (file, sha256) -> status last published
        self.importing: set[str] = set()
        self.system = self.catalogue = self.cs = None
        self.sub = None

    def stopped(self) -> None:
        self.sub = None

    # --- registration (at server start) -----------------------------------------------------
    async def start(self, quiet: bool) -> None:
        st = self.rt.store
        self.system, _ = st.add_system(UID, "CSV importer", "Lists the data folder and imports its CSV files in bulk "
                                       "(a module of the data server).", "http://www.w3.org/ns/sosa/System",
                                       "Equipment", owner="svc-importer")
        self.catalogue, _ = st.add_datastream(self.system["id"], "catalogue", "Archive catalogue", catalogue_schema(),
                                              owner="svc-importer")
        self.cs, _ = st.add_controlstream(self.system["id"], "import", "Import a file", import_schema(),
                                          owner="svc-importer")
        self.sub = self.rt.subscribe_internal(self.cs, "svc-importer")  # subscribed before it is ready (FR-27)
        asyncio.ensure_future(self._listen(self.sub))
        await self.rescan(quiet=quiet)

    async def _listen(self, sub) -> None:
        while True:
            cmd = await self.rt.next_push(sub)
            if cmd is None:
                return
            asyncio.ensure_future(self._handle(cmd))

    # --- the folder (FR-20c) -------------------------------------------------------------------
    async def rescan(self, quiet: bool = False) -> list[dict]:
        tap = self.rt.tap
        tap.emit("importer", "folder", "S", "list", "list the data folder", quiet=quiet)
        self.listing = await self.folder.list()
        tap.emit("folder", "importer", "L", f"listing: {len(self.listing)} files",
                 "\n".join(f"{f['file']}  {f['size']}  {f['modified']}" for f in self.listing), quiet=quiet)
        for f in self.listing:
            if f["file"] in self.importing:
                continue
            ds = self._latest_dataset(f["file"])
            if ds is None:
                self._publish(f, "not-imported", quiet=quiet)
            elif all(ds[k] == f[k] for k in ("sha256", "size", "modified")):
                self._publish(f, "imported", ds, quiet=quiet)
            else:
                self._publish(f, "changed", ds, quiet=quiet)
        return self.listing

    def _latest_dataset(self, file: str) -> dict | None:
        return next((d for d in reversed(list(self.datasets.values())) if d["file"] == file and not d["superseded"]), None)

    def _publish(self, f: dict, status: str, ds: dict | None = None, pct: int | None = None, quiet=False,
                 force=False) -> None:
        key = (f["file"], f["sha256"])
        if not force and self.published.get(key) == status:
            return
        self.published[key] = status
        row = {"file": f["file"], "size": f["size"], "modified": parse_iso(f["modified"]), "sha256": f["sha256"],
               "dataset": ds["id"] if ds else "", "start": ds["start"] if ds else np.nan,
               "end": ds["end"] if ds else np.nan, "records": ds["records"] if ds else np.nan, "status": status,
               "pct": pct if pct is not None else (100 if status in ("imported", "superseded") else 0)}
        now = round(self.rt.real(), 3)
        self.rt.store.append_row(self.catalogue, now, now, row)
        if not (ds and status == "superseded"):
            self.current[f["file"]] = {"file": f["file"], "size": f["size"], "modified": f["modified"],
                                       "sha256": f["sha256"], "status": status, "dataset": row["dataset"], "pct": row["pct"]}
        shown = dict(row, time=iso(now), modified=f["modified"], start=iso(row["start"]) if ds else None,
                     end=iso(row["end"]) if ds else None)
        self.rt.tap.emit("importer", "server", "I", f"catalogue: {f['file']} {status}" + (f" {pct}%" if pct is not None and status == "importing" else ""),
                         shown, quiet=quiet)

    # --- commands (FR-27) ------------------------------------------------------------------------
    async def _handle(self, cmd: dict) -> None:
        p = cmd.get("parameters", {})
        cid = cmd["id"]
        action, file = p.get("action"), (p.get("file") or "").strip()
        status = lambda code, msg="": self.rt.command_status(cid, code, msg, src="importer")  # noqa: E731
        if action == "rescan":
            status("ACCEPTED")
            await self.rescan()
            status("COMPLETED", f"{len(self.listing)} files")
            return
        if action != "import":
            status("REJECTED", f"action {action!r} is not import or rescan")
            return
        entry = next((f for f in self.listing if f["file"] == file), None)
        if entry is None:
            await self.rescan()
            entry = next((f for f in self.listing if f["file"] == file), None)
        if entry is None:
            status("REJECTED", f"unknown file {file!r}: not in the data folder")
            return
        if file in self.importing:
            status("REJECTED", f"{file} is already importing")
            return
        status("ACCEPTED")
        try:
            ds = await self.import_file(entry, report=lambda pct: status("EXECUTING", f"{pct}%"))
        except Exception as e:  # noqa: BLE001 - reported as the command's status
            status("FAILED", f"{type(e).__name__}: {e}")
            return
        status("COMPLETED", f"imported as {ds['id']}")

    async def silent_import(self) -> None:
        """Mission A, imported silently at startup, once per page load (FR-15)."""
        entry = next((f for f in self.listing if f["file"].startswith("MISSION_A_")), None)
        if entry is not None and self._latest_dataset(entry["file"]) is None:
            await self.import_file(entry, quiet=True)
            self.silent = entry["file"]

    # --- an import (FR-21, FR-21a, FR-21c) ----------------------------------------------------------
    async def import_file(self, entry: dict, quiet: bool = False, report=None) -> dict:
        rt, tap, st = self.rt, self.rt.tap, self.rt.store
        file = entry["file"]
        prior = self._latest_dataset(file)
        if prior is not None and all(prior[k] == entry[k] for k in ("sha256", "size", "modified")):
            return prior  # already imported, unchanged
        self.importing.add(file)
        try:
            t_start = clock.perf()
            self._publish(entry, "importing", pct=0, quiet=quiet)
            tap.emit("importer", "folder", "S", f"read {file}", f"read {file}", quiet=quiet)
            raw = await self.folder.read(file)
            parsed = self.parse(raw)
            n = len(parsed.t)
            tap.emit("folder", "importer", "L", f"{file}: {n} rows",
                     "\n".join(parsed.first_rows) + f"\n… {n} rows in all", quiet=quiet)
            dsid = dataset_id(file, entry["sha256"])
            outs = self._datastreams(dsid, parsed)
            t = parsed.t
            chunks = np.linspace(0, n, 11).astype(int)
            written = 0
            for k in range(10):
                a, b = int(chunks[k]), int(chunks[k + 1])
                if b <= a:
                    continue
                for d, cols in outs:
                    st.append_cols(d, {name: v[a:b] for name, v in cols.items()})
                while written + C.ROWS_PER_MESSAGE <= b or (b == n and written < n):
                    upto = min(n, written + C.ROWS_PER_MESSAGE)
                    tap.emit("importer", "server", "I", f"bulk write: rows written {upto}/{n}",
                             {"dataset": dsid, "rows": [written + 1, upto], "of": n,
                              "datastreams": [d["outputName"] for d, _ in outs]}, quiet=quiet)
                    written = upto
                pct = int(round(100 * b / n))
                if report:
                    report(pct)
                if pct < 100:
                    self._publish(entry, "importing", pct=pct, quiet=quiet, force=True)
                await asyncio.sleep(0)  # the server keeps answering while it imports
            ds = {"id": dsid, "file": file, "size": entry["size"], "modified": entry["modified"],
                  "sha256": entry["sha256"], "start": float(t[0]) if n else np.nan, "end": float(t[-1]) if n else np.nan,
                  "records": n, "superseded": False, "label": parsed.mission}
            self.datasets[dsid] = ds
            if prior is not None:  # FR-21a: the earlier version is kept, and marked
                prior["superseded"] = True
                self._publish({k: prior[k] for k in ("file", "size", "modified", "sha256")}, "superseded", prior,
                              quiet=quiet)
            self._publish(entry, "imported", ds, quiet=quiet)
            elapsed = max(clock.perf() - t_start, 1e-6)
            self.rate = round(n / elapsed)
            return ds
        finally:
            self.importing.discard(file)

    def _datastreams(self, dsid: str, p) -> list[tuple[dict, dict]]:
        """The dataset's datastreams and their columns: weather per sensor, CO₂ per analyser (§6)."""
        st = self.rt.store
        out = []
        for s in SENSORS:
            names = [f for f in QUANTITIES if (s, f) in p.values]
            if names:
                sysm = st.system_by_uid(f"{URN}sensor:{s}")
                d, _ = st.add_datastream(sysm["id"], f"weather__{dsid}", f"{s.capitalize()} sensor record · {dsid}",
                                         swe.measurement_record(names, f"{s.capitalize()} sensor record"),
                                         owner="svc-importer")
                out.append((d, self._columns(p, s, names)))
            if (s, "co2") in p.values:
                sysm = st.system_by_uid(f"{URN}sensor:{s}:co2")
                d, _ = st.add_datastream(sysm["id"], f"co2__{dsid}", f"{s.capitalize()} CO₂ · {dsid}",
                                         swe.measurement_record(["co2"], f"{s.capitalize()} CO₂"), owner="svc-importer")
                out.append((d, self._columns(p, s, ["co2"])))
        return out

    @staticmethod
    def _columns(p, sensor: str, names: list[str]) -> dict:
        cols = {"t": p.t, "rt": p.t}
        for f in names:
            v = np.round(p.values[(sensor, f)], 4)
            cols[f] = v
            cols[f"{f}_qc"] = qc.flags(f, v, p.variable.get((sensor, f)))
        return cols

    # --- for the shell (§13.4) ------------------------------------------------------------------------
    def folder_state(self) -> list[dict]:
        return [{k: v for k, v in e.items() if k != "sha256"} for e in self.current.values()]

    def datasets_state(self) -> list[dict]:
        return [{"id": d["id"], "file": d["file"], "start": iso(d["start"]), "end": iso(d["end"]),
                 "superseded": d["superseded"]} for d in self.datasets.values()]

