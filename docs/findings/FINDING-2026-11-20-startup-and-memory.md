# FINDING: start-up time and memory, SRD 3.2

**Date:** 2026-11-20 · **Answers:** SRD §13 "Startup and memory"

## Measured (headless Chromium, local static server)

| History | How | To flowchart | To first charts |
|---|---|---|---|
| Four weeks | generated in the browser | 29.3 s | — |
| One week | pre-built, 9.7 MB gzipped | 5.6 s | 9.7 s |
| Four weeks | pre-built, 38.7 MB gzipped | 5.7 s | 11.7 s |

Most of the gap between flowchart and charts is the server's waiting mode
while it indexes the store, then the first analysis run.

## Memory

The logger store is 48 bytes per record: 232 MB for four weeks, 58 MB for one.
The server's index adds 8 bytes per record. Pre-built files are copied once,
into the store, as they arrive.

## Still to measure

Four weeks pre-built over the real network from GitHub Pages: locally the
39 MB arrive in under a second, so the published figure depends on the
connection. Also the
fastest legible speed on the target presentation display (D-12).
