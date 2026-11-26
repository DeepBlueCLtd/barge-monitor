#!/usr/bin/env python3
"""Write the OpenAPI document FastAPI generates to contracts/openapi.json.

The committed file is the master (FR-65): a test fails if the served
document drifts from it. Run this deliberately when the interface changes,
and review the diff.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

from barge.api import create_app  # noqa: E402
from barge.clock import ManualClock  # noqa: E402
from barge.runtime import Runtime  # noqa: E402

app = create_app(Runtime(seed=1, clock=ManualClock(0), pregen_days=0))
(ROOT / "contracts" / "openapi.json").write_text(json.dumps(app.openapi(), indent=1, sort_keys=True) + "\n")
print("wrote contracts/openapi.json")
