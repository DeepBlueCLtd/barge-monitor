#!/usr/bin/env python3
"""Vocabulary gate (PR-01): fail if any forbidden term appears in the repository.

The list of terms is held privately, never committed: it is read from the
VOCABULARY_TERMS environment variable (one term per line, case-insensitive),
supplied in CI from a repository secret. Without it the gate says so and
passes, so forks and local runs are not blocked.

Usage: scripts/vocab_gate.py [ROOT]
"""
import os
import re
import subprocess
import sys
from pathlib import Path


def scan(root: Path, terms: list[str]) -> list[str]:
    files = subprocess.run(["git", "ls-files"], cwd=root, capture_output=True, text=True, check=True).stdout.split()
    pat = re.compile("|".join(re.escape(t) for t in terms), re.I)
    hits = []
    for f in files:
        p = root / f
        try:
            text = p.read_text(errors="ignore")
        except (OSError, IsADirectoryError):
            continue
        for i, line in enumerate(text.splitlines(), 1):
            if pat.search(line):
                hits.append(f"{f}:{i}")
    return hits


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    terms = [t.strip() for t in os.environ.get("VOCABULARY_TERMS", "").splitlines() if t.strip()]
    if not terms:
        print("vocabulary gate: VOCABULARY_TERMS not set; nothing checked")
        return 0
    hits = scan(root, terms)
    if hits:
        # Locations only: printing the matched term would publish the private list.
        print("vocabulary gate: forbidden terms found at:\n  " + "\n  ".join(hits))
        return 1
    print(f"vocabulary gate: {len(terms)} terms, none found")
    return 0


if __name__ == "__main__":
    sys.exit(main())
