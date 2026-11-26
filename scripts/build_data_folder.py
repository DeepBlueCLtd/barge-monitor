#!/usr/bin/env python3
"""Build the data folder (FR-15): four CSV recordings, their manifest and the listing.

Writes into OUT (default web/public/data/folder):
  <file>.csv.gz      each recording, gzipped for delivery (the folder serves the CSV)
  index.json         the folder listing the browser reads: name, size, modified, sha256
  manifest.json.gz   the ground truth, read only by the referee (FR-12)

With --check, regenerates and fails unless the files in OUT are byte-identical (FR-15a, AT-28).

Usage: scripts/build_data_folder.py [--check] [OUT]
"""
import gzip
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from barge.datafolder import build, gz  # noqa: E402


def main(argv):
    check = "--check" in argv
    args = [a for a in argv if not a.startswith("--")]
    out = Path(args[0]) if args else ROOT / "web" / "public" / "data" / "folder"
    files = build()
    if check:
        bad = []
        for name, data in files.items():
            p = out / (name if name == "index.json" else name + ".gz")
            if not p.exists():
                bad.append(f"{p}: missing")
                continue
            have = p.read_bytes() if name == "index.json" else gzip.decompress(p.read_bytes())
            if have != data:
                bad.append(f"{p}: differs from what the seeds generate")
        if bad:
            print("data folder NOT reproducible:\n  " + "\n  ".join(bad))
            return 1
        print(f"data folder reproduces exactly: {len(files)} files")
        return 0
    out.mkdir(parents=True, exist_ok=True)
    for name, data in files.items():
        if name == "index.json":
            (out / name).write_bytes(data)
        else:
            (out / (name + ".gz")).write_bytes(gz(data))
        print(f"{name}: {len(data) / 1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
