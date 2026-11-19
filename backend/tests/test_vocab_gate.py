"""PR-03: the vocabulary gate is watched failing before it is trusted."""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GATE = ROOT / "scripts" / "vocab_gate.py"


def run(terms):
    env = {**os.environ, "VOCABULARY_TERMS": terms}
    return subprocess.run([sys.executable, str(GATE), str(ROOT)], env=env, capture_output=True, text=True)


def test_gate_fails_on_a_present_term_without_printing_it():
    r = run("Software Requirements Document")  # a term known to be committed
    assert r.returncode == 1
    assert "Software Requirements Document" not in r.stdout


def test_gate_passes_on_absent_terms():
    r = run("zq-not-a-word-xj")
    assert r.returncode == 0
