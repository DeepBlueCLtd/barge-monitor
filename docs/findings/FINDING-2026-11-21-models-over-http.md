# Finding: start-up with models on the HTTP interface (NFR-10)

**Date:** 2026-11-21 · **Where:** local static server, headless Chromium, development
machine (not the target display or network) · **History:** 24 hours, seed 1.

| Back end | To the flowchart | To the first charts |
|---|---|---|
| JavaScript stand-in, internal interface (before) | 1.0 s | not measured the same way |
| JavaScript stand-in, HTTP | 3.4 s | 5.9 s |
| Python (Pyodide), internal interface (before) | 4.5 s | at most 17.5 s |
| Python (Pyodide), HTTP | 4.4 s | 29.0 s |

The stand-in works through history before the flowchart appears; the Python back end shows
the flowchart first and its model workers then catch up. "To the first charts" is with Play
pressed at once, and includes the display client's handshake. The earlier Python figure was
taken with a six-second pause before the display client was opened, so it is an upper
bound, not a like-for-like figure.

Where the time goes: each model reads a day of 1 Hz records as SWE Common JSON (about 34 MB
for one sensor's raw records) and Data cleanse publishes as much again. Two changes kept it
to the figures above: history is read four hours at a request, so the Python back-end
worker keeps answering between requests; and the stand-in writes observation responses a
record at a time instead of through its general JSON writer.

**Not measured:** more than 24 hours of history; memory with four Pyodide instances; the
published site over a real network. The 30 s budget for the flowchart (NFR-10) is met by
both back ends; the Python back end's first charts are at the edge of it.

**Conformance identifiers (SRD §15, decision D-26).** Checked on 2026-11-21 against the
published OGC API – Connected Systems Part 1 (23-001) and Part 2 (23-002): the classes this
server claims exist there under `…/ogcapi-connectedsystems-1/1.0/conf/` (api-common, system,
subsystem, property, sensorml) and `…/ogcapi-connectedsystems-2/1.0/conf/` (api-common,
datastream, controlstream, json, swecommon-json). Part 2 also defines the `statusCode`
filter on commands that models use.
