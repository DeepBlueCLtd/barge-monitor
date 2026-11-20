# ADR 0001: OGC API – Connected Systems, written directly on FastAPI

**Status:** accepted, 2026-11-20 (SRD 3.2 FR-22, FR-22a, FR-65; Spike 0)

**Context.** The SRD replaces EDR with Connected Systems Parts 1 and 2. No
off-the-shelf Python server runs in Pyodide (Spike 0 §6).

**Decision.** Implement the declared subset of Spike 0 §4 directly on FastAPI
0.116 (which Pyodide 0.29.5 ships). Everything else is refused by name. The
committed `contracts/openapi.json` is generated from the application and a
test fails when they differ. Endpoints are `async def`, because Starlette
runs plain functions in a thread pool and Pyodide has no threads.

**Consequences.** The subset is ours to keep honest: the contract suite runs
under uvicorn and in the browser, and an independent client (OSHConnect)
browses it in CI. Fallback if Connected Systems proves unworkable:
SensorThings, as the spike recorded.
