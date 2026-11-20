# ADR 0002: Ship the four-week history pre-built

**Status:** accepted, 2026-11-20 (SRD §13 fallback; decisions D-34, D-37)

**Context.** Generating four weeks (2.4 M records per sensor) in Pyodide took
29 s, too long a start.

**Decision.** Build time runs the same sensors-to-logger path for seeds 1–3
and publishes each day's logger file gzipped, in the logger's own format. The
backend loads them into the logger store. Files are tied to a hash of the
generating code. Tests and CI use one week; the published site four.

**Consequences.** Start-up is dominated by the download. Visits share three
seeds instead of a fresh one each (NFR-07), unless `?seed=N` asks for another,
which generates in the browser. The site grows by ~120 MB each time the
generating code changes.
