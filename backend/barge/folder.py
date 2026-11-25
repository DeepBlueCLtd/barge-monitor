"""The data folder (C-02) as a read-only port (FR-17a, SRD §2.2).

The importer reaches the folder only through this interface. Nothing here writes,
renames or deletes anything.

* ``DirFolder``: a directory on disk (CPython). It holds the CSV files, plain (``*.csv``)
  or gzipped for delivery (``*.csv.gz``), and optionally ``index.json``, whose modified
  dates are used for the files it lists (fixed at build time, so they are reproducible).
  A file copied in later is listed with its own modification time (AT-40).
* ``FetchFolder``: the folder as the browser sees it (Pyodide): ``index.json`` and each
  ``<file>.gz`` fetched on demand by the worker, which also decompresses them.

Both answer ``list()`` with ``[{file, size, modified, sha256}]`` (size and sha256 of the
CSV itself) and ``read(name)`` with the CSV's bytes. Both are async.
"""
from __future__ import annotations

import gzip
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def iso_utc(unix: float) -> str:
    return datetime.fromtimestamp(int(unix), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Folder:
    async def list(self) -> list[dict]:
        raise NotImplementedError

    async def read(self, name: str) -> bytes:
        raise NotImplementedError

    async def manifest(self) -> dict:
        """The ground truth beside the files, read only by the referee (FR-12)."""
        raise NotImplementedError


class DirFolder(Folder):
    def __init__(self, path):
        self.path = Path(path)
        self._cache: dict[str, tuple] = {}  # file on disk -> ((mtime, size), entry)

    def _files(self) -> dict[str, Path]:
        out = {}
        for p in sorted(self.path.iterdir()):
            if p.name.endswith(".csv.gz"):
                out[p.name[:-3]] = p
            elif p.name.endswith(".csv"):
                out[p.name] = p
        return out

    def _index(self) -> dict:
        p = self.path / "index.json"
        if not p.exists():
            return {}
        return {f["file"]: f for f in json.loads(p.read_text()).get("files", [])}

    @staticmethod
    def _bytes(p: Path) -> bytes:
        b = p.read_bytes()
        return gzip.decompress(b) if p.name.endswith(".gz") else b

    async def list(self) -> list[dict]:
        index = self._index()
        out = []
        for name, p in self._files().items():
            st = p.stat()
            key = (st.st_mtime_ns, st.st_size)
            hit = self._cache.get(str(p))
            if hit and hit[0] == key:
                out.append(hit[1])
                continue
            b = self._bytes(p)
            sha = hashlib.sha256(b).hexdigest()
            ix = index.get(name)
            # The listed date is fixed at build time for the files the index names, when they are unchanged.
            modified = ix["modified"] if ix and ix.get("sha256") == sha else iso_utc(st.st_mtime)
            entry = {"file": name, "size": len(b), "modified": modified, "sha256": sha}
            self._cache[str(p)] = (key, entry)
            out.append(entry)
        return out

    async def read(self, name: str) -> bytes:
        p = self._files().get(name)
        if p is None:
            raise FileNotFoundError(name)
        return self._bytes(p)

    async def manifest(self) -> dict:
        for name in ("manifest.json.gz", "manifest.json"):
            p = self.path / name
            if p.exists():
                return json.loads(self._bytes(p))
        raise FileNotFoundError("manifest.json")


class FetchFolder(Folder):
    """In Pyodide: ``fetch_index()`` resolves to index.json's text; ``fetch_file(name)`` to the CSV's bytes."""

    def __init__(self, fetch_index, fetch_file, fetch_manifest=None):
        self._index = fetch_index
        self._file = fetch_file
        self._manifest = fetch_manifest

    async def list(self) -> list[dict]:
        text = await self._index()
        return [{k: f[k] for k in ("file", "size", "modified", "sha256")} for f in json.loads(str(text))["files"]]

    async def read(self, name: str) -> bytes:
        b = await self._file(name)
        return b.to_bytes() if hasattr(b, "to_bytes") else bytes(b)

    async def manifest(self) -> dict:
        return json.loads(str(await self._manifest()))
