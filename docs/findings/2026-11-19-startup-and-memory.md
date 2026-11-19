# FINDING: start-up time and memory, Version 1

**Date:** 2026-11-19 · **Answers:** SRD §10 "Startup budget", "Browser memory" (partly)

## Start-up (NFR-08)

Declared budget: **60 s** from navigation to the backend answering, on a first
visit (`STARTUP_BUDGET_MS` in `web/src/config.ts`, asserted by the e2e test).

Measured, headless Chromium against a local static server (no network latency,
cold cache): **4.4 s**. The first visit downloads Pyodide (≈9 MB) and numpy
(≈3 MB). The workspace loads lazily, with pandas, on first use (not yet timed
separately); scipy and scikit-learn load only when a script imports them.

To do: measure against the GitHub Pages preview over a typical connection, and
tighten the budget.

## Memory

The stand-in lives in memory (decision 11). Per simulated week:

| Item | Size per week |
|---|---|
| Logger text, two sensors, 117 B/record at 1 Hz | 141 MB |
| Facade index, 12 float64 columns | 116 MB (plus growth headroom) |

A four-week run would hold about 1 GB in one Pyodide heap, which is beyond what
a browser tab should carry. Version 1 therefore supports runs of days, and AT-07
is met at one week in CPython only. Next step: keep the stand-in's files in the
Origin Private File System and the index as float32 or memory-mapped chunks.
