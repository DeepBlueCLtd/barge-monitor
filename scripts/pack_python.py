#!/usr/bin/env python3
"""Pack the Python backend, the contract suite and the masters into one zip.

The zip is unpacked into Pyodide's file system by both browser workers. It is
the same source the CPython tests run: nothing is transformed.

Usage: scripts/pack_python.py OUT.zip
"""
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
out = Path(sys.argv[1])
out.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for pkg in ("barge", "contract_suite"):
        for f in sorted((ROOT / "backend" / pkg).glob("*.py")):
            z.write(f, f"{pkg}/{f.name}")
    for f in sorted((ROOT / "contracts").rglob("*.json")):
        z.write(f, f"contracts/{f.relative_to(ROOT / 'contracts')}")
    for f in sorted((ROOT / "web" / "workspace-py").glob("*.py")):
        z.write(f, f"workspace/{f.name}")
print(f"wrote {out}")
