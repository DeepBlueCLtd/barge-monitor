# Finding: Version 4 start-up with models in their own workers (NFR-10)

**Date:** 2026-11-20 · **Back end:** Python (Pyodide 0.29.5) · **Where:** local static
server, headless Chromium, development machine (not the target display or network).

| History | Back end ready (flowchart may show) | All three models live (display client may handshake) |
|---|---|---|
| 1 week | ≈ 7 s | 18 s, before the changes below |
| 4 weeks | ≈ 7–10 s | 42 s, before the changes below |
| 4 weeks | ≈ 7 s | **23 s**, after them |

What changed between the rows:

- A model catching up on history now steps back to back instead of every 250 ms.
- Data cleanse and Model A take one day of history per step instead of six hours.
- Model-published text columns are numpy object arrays instead of Python lists.
- Data cleanse's output is no longer pruned before any reader has registered (a bug that
  also lost Model A's first day of hourly summaries).

Where the time goes now: streaming four weeks (2.4 M records per sensor) through Data
cleanse and then Model A, each in its own worker, with every chunk crossing the back-end
worker. Download sizes: history 38.7 MB per seed (gzipped logger files), Pyodide and
packages 34.7 MB (scikit-learn and scipy only for Model B).

**Declared budget:** 30 s from navigation to all models live, four weeks, on the published
site. **To confirm** on the presentation machine and network (NFR-08, NFR-09), and memory
with four Pyodide instances is unmeasured (SRD §15).

**Note on the SRD:** FR-15 says four weeks is "about five million records per sensor";
at 1 Hz it is 2.42 million.
