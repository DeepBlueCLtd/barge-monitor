"""The CSV importer (FR-20 to FR-22, FR-109, FR-110; docs/v4-interfaces.md §7).

A **module of the data server**: it runs inside the server, under its own service account
(``svc-importer``), and writes **in bulk** into the server's store (FR-20a). It is the only code that
understands the CSV files, through its parser (``dialect.parse``; a port: AT-03 swaps it).

* At each server start it registers the system ``urn:x-barge:importer`` with the ``catalogue``
  datastream (one observation per file per change of status) and the ``import`` control stream
  (``action`` import or rescan, ``file``), and lists the folder. Once the server answers, it
  subscribes to its control stream on the internal endpoint (``/api-internal``, D-223), like any
  receiver, and validates each pushed command: ``REJECTED``, or ``ACCEPTED``, ``EXECUTING`` with the
  percentage every 10 %, then ``COMPLETED`` (or ``FAILED``).
* An import reads the file through the folder, maps its columns to the declared fields and units,
  computes the QARTOD flags (``qc.py``), creates the dataset's datastreams under the sensors and the
  CO₂ analysers (CO₂ never in the weather record, FR-21c) and writes every row in bulk.
* A file whose name matches an imported one but whose size, date or hash differ is imported as a new
  dataset; the earlier one becomes ``superseded`` and stays (FR-21a). Files that overlap in time are
  kept apart, each in its own datastreams (FR-21b).

Capture (§2): ``importer → folder`` S (list, read), ``folder → importer`` L (the listing; the first
three rows and a count), ``importer → server`` I (one per 1,000 rows written, and each catalogue
observation), ``server → importer`` K (a pushed command). Registering and listing at a server start,
and the silent import of Mission A (FR-15), are counted, not drawn (``quiet``).

Times in the store are seconds since the simulation epoch, as everywhere in this server; the files'
times are absolute UTC, and so is what is served.
"""
from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

import numpy as np

from . import clock
from . import config as C
from . import dialect
from . import qc
from .accounts import service_header
from .fields import QUANTITIES
from .server import contracts_dir, iso, parse_iso
from .store import URN

UID = URN + "importer"
ACCOUNT = "svc-importer"
STATUSES = ("not-imported", "importing", "imported", "changed", "superseded")
SENSORS = ("bow", "stern")
SILENT_PREFIX = "MISSION_A_"  # imported silently at the first server start of a page load (FR-15)


def dataset_id(file: str, sha256: str) -> str:
    """``<slug>-<h8>`` (§6)."""
    stem = file[:-4] if file.lower().endswith(".csv") else file
    slug = re.sub(r"[^a-z0-9]+", "-", stem.lower()).strip("-")
    return f"{slug}-{sha256[:8]}"


def master(name: str) -> dict:
    """A SWE Common master from contracts/swe (plan Phase 1): the schemas the importer declares."""
    rec = json.loads((contracts_dir() / "swe" / name).read_text())
    return {k: v for k, v in rec.items() if k != "description"}


def weather_schema(names: list[str], sensor: str) -> dict:
    """The weather record master, with the fields this file has (FR-21: a missing column is absent)."""
    rec = master("weather-record.json")
    keep = {"time", *names, *(f"{n}_qc" for n in names)}
    return dict(rec, label=f"{sensor.capitalize()} weather record", fields=[f for f in rec["fields"] if f["name"] in keep])


class Importer:
    def __init__(self, rt, folder, parser=None):
        self.rt = rt
        self.folder = folder
        self.parse = parser or dialect.parse
        self.rate: dict | None = None  # the last import's speed (FR-110)
        self.app = None
        self.reset()

    def reset(self) -> None:
        """Forget everything imported: Reset instance deletes the whole store (FR-50a)."""
        self.generation = getattr(self, "generation", 0) + 1
        self.datasets: dict[str, dict] = {}
        self.listing: list[dict] = []
        self.current: dict[str, dict] = {}  # file -> its latest catalogue entry
        self.published: dict[tuple, str] = {}  # (file, sha256) -> the status last published
        self.importing: set[str] = set()
        self.system = self.catalogue = self.cs = None
        self.subscribed = False
        self._listener = None

    # --- at each server start ---------------------------------------------------------------------
    async def start(self) -> None:
        """Register inside the server, under the importer's service account, and list the folder (quiet)."""
        st = self.rt.store
        self.system, _ = st.add_system(UID, "CSV importer",
                                       "Lists the data folder and imports its CSV files in bulk, inside the server "
                                       "(a module of the data server, FR-20a).",
                                       "http://www.w3.org/ns/sosa/System", "Equipment", owner=ACCOUNT)
        self.catalogue, _ = st.add_datastream(self.system["id"], "catalogue", "Archive catalogue",
                                              master("catalogue-record.json"), owner=ACCOUNT)
        self.cs, _ = st.add_controlstream(self.system["id"], "import", "Import a file",
                                          master("controlstreams/import.json"), owner=ACCOUNT)
        self.rt.tap.emit("importer", "server", "I", "register: catalogue datastream, import control stream",
                         {"system": UID, "datastreams": ["catalogue"], "controlstreams": ["import"]}, quiet=True)
        await self.rescan(quiet=True)

    async def silent_import(self) -> None:
        """Mission A, imported silently before the server takes requests, once per page load (FR-15)."""
        entry = next((f for f in self.listing if f["file"].startswith(SILENT_PREFIX)), None)
        if entry is not None:
            await self.import_file(entry, quiet=True)

    async def listen(self, server) -> None:
        """Hold a push subscription to ``import`` on the internal endpoint (§9.2, D-223) until the server stops.
        The importer is a module inside the server: the request is made of the server's own application,
        with no network in between (FR-65: "inside the server")."""
        from . import asgi
        from .api import INTERNAL, create_app

        if self.app is None:
            self.app = create_app(self.rt)
        buf = b""
        me = self._listener = object()  # an earlier subscription may end after this one has opened

        def mark(on: bool) -> None:
            if self._listener is me:
                self.subscribed = on

        def on_stream(kind, *a):
            nonlocal buf
            if kind == "start":
                mark(a[0] == 200)
            elif kind == "chunk":
                buf += a[0]
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if line.strip():
                        self.rt.spawn(self._handle(json.loads(line)))
            else:
                mark(False)

        headers = [("authorization", service_header(ACCOUNT)), ("x-tap-quiet", "1")]  # part of registering (D-258)
        cs = self.cs["id"]
        try:
            await asgi.call(self.app, "GET", f"{INTERNAL}/controlstreams/{cs}/commands", "subscribe=1", None, "",
                            headers, "http://importer", on_stream=on_stream)
        finally:
            mark(False)

    # --- the folder (FR-20c) ----------------------------------------------------------------------
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
            elif self._same(ds, f):
                self._publish(f, "imported", ds, quiet=quiet)
            else:
                self._publish(f, "changed", ds, quiet=quiet)
        return self.listing

    @staticmethod
    def _same(ds: dict, f: dict) -> bool:
        return all(ds[k] == f[k] for k in ("sha256", "size", "modified"))

    def _latest_dataset(self, file: str) -> dict | None:
        return next((d for d in reversed(list(self.datasets.values())) if d["file"] == file and not d["superseded"]),
                    None)

    def _publish(self, f: dict, status: str, ds: dict | None = None, pct: int | None = None, quiet=False,
                 force=False) -> None:
        """One catalogue observation (§7). ``records`` is 0 until the file is imported: a Count has no missing
        value in OpenSensorHub, and the status says whether it counts (D-197)."""
        key = (f["file"], f["sha256"])
        if not force and self.published.get(key) == status:
            return
        self.published[key] = status
        named = ds is not None and status in ("imported", "changed", "superseded")
        row = {"file": f["file"], "size": f["size"], "modified": parse_iso(f["modified"]), "sha256": f["sha256"],
               "dataset": ds["id"] if named else "", "start": ds["start"] if named else np.nan,
               "end": ds["end"] if named else np.nan, "records": ds["records"] if named else 0, "status": status,
               "pct": pct if pct is not None else (100 if named else 0)}
        now = self.rt.real() - C.SIM_EPOCH_UNIX  # the catalogue is stamped in real time
        self.rt.store.append_row(self.catalogue, now, row)
        if status != "superseded":
            self.current[f["file"]] = {"file": f["file"], "size": f["size"], "modified": f["modified"],
                                       "status": status, "dataset": row["dataset"], "pct": row["pct"]}
        shown = dict(row, time=iso(now), modified=f["modified"], start=iso(row["start"]) if named else None,
                     end=iso(row["end"]) if named else None)
        tail = f" {pct}%" if pct is not None and status == "importing" else ""
        self.rt.tap.emit("importer", "server", "I", f"catalogue: {f['file']} {status}{tail}", shown, quiet=quiet)

    # --- commands (FR-27) -------------------------------------------------------------------------
    def _status(self, cid: str, code: str, message: str = "") -> None:
        if cid not in self.rt.store.commands:
            return  # gone with Reset instance
        self.rt.command_status(cid, code, message)
        self.rt.tap.emit("importer", "server", "I", f"command status: {code}" + (f" ({message})" if message else ""),
                         {"command@id": cid, "statusCode": code, "message": message})

    async def _handle(self, cmd: dict) -> None:
        await self.rt.wait_released()  # held (D-362): the command waits
        p = cmd.get("parameters") or {}
        cid = cmd["id"]
        action, file = p.get("action"), str(p.get("file") or "").strip()
        if action == "rescan":
            self._status(cid, "ACCEPTED")
            try:
                await self.rescan()
            except Exception as e:  # noqa: BLE001 - reported as the command's status
                self._status(cid, "FAILED", f"{type(e).__name__}: {e}")
                return
            self._status(cid, "COMPLETED", f"{len(self.listing)} files listed")
            return
        if action != "import":
            self._status(cid, "REJECTED", f"action {action!r} is not import or rescan")
            return
        entry = next((f for f in self.listing if f["file"] == file), None)
        if entry is None:
            self._status(cid, "REJECTED", f"unknown file {file!r}: not in the data folder")
            return
        if file in self.importing:
            self._status(cid, "REJECTED", f"{file} is already importing")
            return
        self._status(cid, "ACCEPTED")
        try:
            ds = await self.import_file(entry, report=lambda pct: self._status(cid, "EXECUTING", f"{pct}%"))
        except Exception as e:  # noqa: BLE001 - reported as the command's status
            self._status(cid, "FAILED", f"{type(e).__name__}: {e}")
            return
        self._status(cid, "COMPLETED", f"imported as {ds['id']}")

    # --- an import (FR-21, FR-21a, FR-21c) --------------------------------------------------------
    async def import_file(self, entry: dict, quiet: bool = False, report=None) -> dict:
        tap, st = self.rt.tap, self.rt.store
        file = entry["file"]
        prior = self._latest_dataset(file)
        if prior is not None and self._same(prior, entry):
            for pct in range(10, 101, 10):
                report and report(pct)
            return prior  # already imported, unchanged
        gen = self.generation
        self.importing.add(file)
        try:
            t_start = clock.perf()
            self._publish(entry, "importing", pct=0, quiet=quiet)
            tap.emit("importer", "folder", "S", f"read {file}", f"read {file}", quiet=quiet)
            parsed = self.parse(await self.folder.read(file))
            n = len(parsed.t)
            tap.emit("folder", "importer", "L", f"{file}: {n} rows",
                     "\n".join(parsed.first_rows) + f"\n… {n} rows in all", quiet=quiet)
            if not n:
                raise ValueError(f"{file} has no rows")
            dsid = dataset_id(file, entry["sha256"])
            t = parsed.t - C.SIM_EPOCH_UNIX
            outs = self._datastreams(dsid, parsed)
            if any(len(d["series"]) for d, _ in outs):
                raise ValueError(f"{dsid} already holds observations")
            bounds = np.linspace(0, n, 11).astype(int)
            written = 0
            for k in range(10):
                a, b = int(bounds[k]), int(bounds[k + 1])
                await self.rt.wait_released()  # held (D-362): the import stops here, and carries on from this block
                if gen != self.generation:
                    raise RuntimeError("the store was reset during the import")
                for d, cols in outs:
                    st.append_cols(d, t[a:b], {name: v[a:b] for name, v in cols.items()})
                while written < b:  # one captured message per 1,000 rows (FR-67)
                    upto = min(b, written + C.ROWS_PER_MESSAGE)
                    tap.emit("importer", "server", "I", f"bulk write {dsid}: rows written {upto}/{n}",
                             {"dataset": dsid, "rows": [written + 1, upto], "of": n,
                              "datastreams": [d["outputName"] for d, _ in outs]}, quiet=quiet)
                    written = upto
                pct = (k + 1) * 10
                if report:
                    report(pct)
                if pct < 100:
                    self._publish(entry, "importing", pct=pct, quiet=quiet, force=True)
                await asyncio.sleep(0)  # the server keeps answering while it imports
            ds = {"id": dsid, "file": file, "size": entry["size"], "modified": entry["modified"],
                  "sha256": entry["sha256"], "start": float(t[0]), "end": float(t[-1]), "records": n,
                  "superseded": False, "label": parsed.mission,
                  "fields": {s: [f for f in QUANTITIES if (s, f) in parsed.values] for s in SENSORS}}
            self.datasets[dsid] = ds
            if prior is not None:  # FR-21a: the earlier version is kept, and marked
                prior["superseded"] = True
                self._publish({k: prior[k] for k in ("file", "size", "modified", "sha256")}, "superseded", prior,
                              quiet=quiet)
            self._publish(entry, "imported", ds, quiet=quiet)
            elapsed = max(clock.perf() - t_start, 1e-6)
            self.rate = {"file": file, "rows": n, "seconds": round(elapsed, 3), "rows_per_s": round(n / elapsed),
                         "silent": quiet}
            return ds
        except BaseException:
            if gen == self.generation and self.catalogue is not None:
                again = self._latest_dataset(file)
                self._publish(entry, "changed" if again else "not-imported", again, quiet=quiet, force=True)
            raise
        finally:
            self.importing.discard(file)

    def _datastreams(self, dsid: str, p) -> list[tuple[dict, dict]]:
        """The dataset's datastreams and their columns: weather per sensor, CO₂ per analyser (§6). Created inside
        the server, under the importer's service account; this order is the stand-in's too (same identifiers)."""
        st = self.rt.store
        out = []
        for s in SENSORS:
            names = [f for f in QUANTITIES if (s, f) in p.values]
            if names:
                sysm = st.system_by_uid(f"{URN}sensor:{s}")
                d, _ = st.add_datastream(sysm["id"], f"weather__{dsid}", f"{s.capitalize()} weather · {dsid}",
                                         weather_schema(names, s), owner=ACCOUNT)
                out.append((d, self._columns(p, s, names)))
            if (s, "co2") in p.values:
                sysm = st.system_by_uid(f"{URN}sensor:{s}:co2")
                d, _ = st.add_datastream(sysm["id"], f"co2__{dsid}", f"{s.capitalize()} CO₂ · {dsid}",
                                         dict(master("co2-record.json"), label=f"{s.capitalize()} CO₂ record"),
                                         owner=ACCOUNT)
                out.append((d, self._columns(p, s, ["co2"])))
        return out

    @staticmethod
    def _columns(p, sensor: str, names: list[str]) -> dict:
        """Readings in declared units, and their QC flags, computed on import (FR-32)."""
        cols = {}
        for f in names:
            v = np.round(p.values[(sensor, f)], 6)
            cols[f] = v
            cols[f"{f}_qc"] = qc.flags(f, v, p.variable.get((sensor, f)))
        return cols

    # --- for the shell (§13.4) --------------------------------------------------------------------
    def folder_state(self) -> list[dict]:
        return list(self.current.values())

    def datasets_state(self) -> list[dict]:
        return [{"id": d["id"], "file": d["file"], "start": iso(d["start"]), "end": iso(d["end"]),
                 "records": d["records"], "superseded": d["superseded"]} for d in self.datasets.values()]


class EmptyFolder:
    """No data folder (tests that do not need one): the importer lists nothing."""

    async def list(self) -> list[dict]:
        return []

    async def read(self, name: str) -> bytes:
        raise FileNotFoundError(name)


def default_folder() -> Path | None:
    """The data folder the site build ships (``web/public/data/folder``), when it has been built."""
    p = Path(__file__).resolve().parents[2] / "web" / "public" / "data" / "folder"
    return p if (p / "index.json").exists() else None
