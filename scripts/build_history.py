#!/usr/bin/env python3
"""Build the pre-calculated history: logger files per seed (FR-15).

Writes OUT/<code hash>/days-<d>/seed-<n>/manifest.json and one gzipped file per logger
file, and web/public/py/history.json pointing the demonstrator at them.

Usage: scripts/build_history.py [--days D] OUT SEED [SEED ...]

D is 1 (24 hours, decision D-79) for the published demonstrator and the tests
"""
import gzip
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from barge import config as C  # noqa: E402
from barge.clock import ManualClock  # noqa: E402
from barge.history import code_hash  # noqa: E402
from barge.runtime import Runtime  # noqa: E402


def build(out: Path, seed: int, days: float) -> dict:
    rt = Runtime(seed=seed, clock=ManualClock(days * 86400.0), pregen_days=days)
    for name, _ in rt.logger.list_files():
        rt.logger.close(name)  # write out the bytes held back: the files are complete
    d = out / code_hash() / f"days-{days:g}" / f"seed-{seed}"
    d.mkdir(parents=True, exist_ok=True)
    files = []
    for name, size in rt.logger.list_files():
        (d / f"{name}.gz").write_bytes(gzip.compress(rt.logger.read(name), compresslevel=6, mtime=0))
        files.append({"name": name, "bytes": size, "gz": (d / f"{name}.gz").stat().st_size})
    manifest = {"seed": seed, "code_hash": code_hash(), "generator_version": C.GENERATOR_VERSION, "days": days,
                "end_t": rt.sensors.next_t, "files": files, "capture_counts": rt.tap.counts}
    (d / "manifest.json").write_text(json.dumps(manifest))
    print(f"seed {seed}: {len(files)} files, {sum(f['gz'] for f in files) / 1e6:.1f} MB compressed")
    return manifest


def main():
    args = sys.argv[1:]
    days = float(C.PREGEN_DAYS)
    if args[0] == "--days":
        days = float(args[1])
        args = args[2:]
    out = Path(args[0])
    seeds = [int(s) for s in args[1:]]
    h = code_hash()
    for s in seeds:
        if (out / h / f"days-{days:g}" / f"seed-{s}" / "manifest.json").exists():
            print(f"seed {s}: already built for code {h}, {days:g} days")
        else:
            build(out, s, days)
    ptr = ROOT / "web" / "public" / "py" / "history.json"
    ptr.parent.mkdir(parents=True, exist_ok=True)
    ptr.write_text(json.dumps({"code_hash": h, "days": days, "seeds": seeds}))
    print(f"wrote {ptr.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
