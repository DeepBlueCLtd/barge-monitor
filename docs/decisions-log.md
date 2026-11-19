# Decisions log: Version 1 implementation

Questions that came up while building the first working version, the options
considered, and the decision taken. Each is open for review; none is hard to
reverse unless marked **(ADR)**.

| # | Question | Options | Decision | Why |
|---|---|---|---|---|
| 1 | Working name (SRD §10) | coined names | **Narrowlog** | Coined, descriptive (narrowboat + logger), no association found. Easy to change: display title only. |
| 2 | Collection layout (SRD §10) **(ADR 0002)** | (a) one collection per sensor; (b) one collection, bow/stern as parameter groups | **(a) `bow` and `stern`** | Bow and stern are 20 m apart, so their trajectories differ; one CoverageJSON trajectory domain cannot hold both honestly. |
| 3 | Backend framework | Starlette/FastAPI (in Pyodide lock) vs hand-written ASGI | **Plain ASGI callable, no framework** | Zero extra packages to load in the browser; it is still a standard ASGI app and runs under uvicorn (test_contract_uvicorn). Revisit if routing grows. |
| 4 | Pyodide version | 0.27.x, 0.29.5, 314.0.x (newest, Python 3.14) | **0.29.5** (Python 3.13) | Released two months ago; matches the CPython 3.13 used in CI; 314.0.8 was days old. |
| 5 | Where Pyodide lives on Pages (NFR-06) | per-preview copy (~42 MB each) vs one shared versioned folder | **Shared `pyodide/0.29.5/` at the site root**, referenced by a relative path set at build | Same origin either way; avoids every PR preview adding 42 MB to the Pages site (1 GB limit). Each deploy (PR or main) republishes it, so a preview never depends on main. |
| 6 | Where the demonstrator lives on the site | demo at root (move SRD) vs SRD at root, demo under `demo/` | **`demo/`**, with a link from the SRD page | Keeps the existing SRD URLs stable. |
| 7 | Canal size | 12 km (first draft) vs 9 km | **9 km, 10 reaches, 5 locks, 6 bridges, 600 m tunnel** | At 12 km FR-06a (every reach in every hour within week 1) failed; 9 km with a timetable gives full coverage for every seed tested. |
| 8 | How to guarantee FR-06a | random dwell; timetabled departures | **Timetabled departures every 5 h 45 m / 2**, dwell absorbs speed variation | Deterministic drift through the clock; a test checks 240/240 reach-hours for five seeds. |
| 9 | Declared fictional location (FR-01) | — | **1.25° S, 24.75° W**, open equatorial Atlantic | No land within hundreds of km. Diurnal cycle uses local solar time there. |
| 10 | Logger format details (FR-13) | — | 117-byte fixed-width records; half-seconds since 1994-01-01; raw `$GPGGA`; METAR `M` minus; `VRB` wind; `/` missing; daily files `BOW_`/`STN_`; flushes hold back 41 bytes so readers see partial records | Every awkwardness the SRD lists, each exercised by a test. See `backend/barge/logger.py`. |
| 11 | Stand-in in memory or OPFS (SRD §10) | memory, OPFS | **Memory for V1** | Simplest; measured cost recorded in the finding below. OPFS is the likely answer for multi-week runs. |
| 12 | Warm start | empty logger vs pre-generated history | **3 simulated hours** generated at start (~1 s) | So the first view is not empty (FR-36 forbids pretending). The logger still holds everything from t=0 and grows. |
| 13 | Clock rates (FR-11) | — | **0 (pause), 1, 10, 60 (default), 180, 600** | 600× runs a week in 17 minutes (< 1 hour). |
| 14 | Trajectory query semantics (FR-16) | — | `LINESTRING` + `datetime`: readings within 75 m of the path; `LINESTRINGM`: readings within 75 m of the path's position *at their own time* | The second is what AT-01 uses; the first serves "the last hour along the route". Tolerance is declared in collection metadata. |
| 15 | `corridor-height` (EDR requires it) | require and ignore; refuse | **Refused by name** | The sensors are at the surface; accepting and ignoring would be dishonest. Recorded as a deviation from the EDR corridor definition. |
| 16 | Conformance classes claimed (FR-17) | — | Common core/collections, EDR core/collections/json/covjson | Only what the code does; a contract test checks no HTML/GeoJSON/OAS30 claim. |
| 17 | Response size limit (FR-18b) | — | **200 000 points**, 413 naming limit, matched count and how to narrow | The browser contract suite skips this test until the store exceeds the limit (it reports "skipped", with the reason). The CPython suite exercises it. |
| 18 | The facade's index (FR-18a) | — | Columnar arrays per sensor built incrementally by the adapter; time-sorted so time slices are binary searches | Dropping it and rebuilding reproduces identical results (tested, and a button on the Seam tab). |
| 19 | Analysis parameters (FR-23) | — | `window-hours` 0.25–168, `sensor`, `parameter-name`, `clusters` 2–8, `sensitivity` 1–10 (default 5) | Served as a JSON Schema in each analysis collection's metadata; the display draws its controls from it. |
| 20 | How analysis results fit EDR (FR-25) | — | Each analysis is a collection answering `trajectory`; time series → Trajectory coverages; matrix/offsets → a custom `barge:Categorical` domain with named string axes | The display has one generic renderer per domain shape, nothing per analysis. The categorical domain is an extension of CoverageJSON, namespaced. |
| 21 | Separating place from weather (FR-22) | — | Backfitting: reading = smooth weather(t, 2 h) + offset(reach); offsets relative to open reaches. Short-scale changes are attributed to place when the fitted offsets explain them; hour-scale changes in diurnal-free quantities (reduced pressure, dew point, true wind vector) are weather | Scores today (seeds 3, 7, 11; 72 h, default sensitivity): boundary recall ≈0.86–0.99, precision ≥0.98, attribution ≥0.99, front recall 0–1 (one seed's front is missed, reported as such). |
| 22 | Heading for true wind | track direction vs bow–stern GPS baseline | **Bow–stern baseline** | Works when stationary; GPS noise 1.5 m over 20 m gives ~6°. |
| 23 | Pressure datum | use manifest elevations vs GPS altitude | **GPS altitude** from the `$GPGGA` sentence, 0.12 hPa/m | The analysis never reads the manifest; only scoring does. |
| 24 | AT-05 bound | — | lag-corrected RMS ≤ 1.15 × √(2σ² + 2q²/12), σ declared noise, q = 0.1 logger resolution | Derived from declared noise, not typed. |
| 25 | AT-06 bound | — | \|error\| ≤ 4 × (standard error from per-pass means) + 3σ | SE ∝ 1/√passes, so the bound tightens as passes accumulate (tested 12 h vs 96 h). Uses the reported SE rather than a purely declared figure: weather mismatch between passes is not a declared quantity. **Review**. |
| 26 | AT-07 scale | 4 weeks in browser vs reduced | **1 week in CPython in V1**; 4 weeks deferred | See the memory finding: four weeks in memory (~1 GB) is beyond what a tab should hold. Needs OPFS. |
| 27 | AT-03 (second store format) | in V1 or later | **Deferred** | The adapter is the only module that knows the format; the second format is still an open SRD question. |
| 28 | Workspace loading | eager vs lazy | **Lazy**, on first use of the Workspace or Seam tab | Keeps first-load to Pyodide + numpy (~12 MB). |
| 29 | Workspace promotion (FR-29) | POST results to the backend vs workspace serves them | **The workspace worker serves them** at `ws/collections/<name>`, routed by the Service Worker | A broken workspace can never write into the backend; promotion is "serving", as the SRD says. |
| 30 | Runaway scripts (FR-28) | timeout vs manual stop | **Stop button** terminates and restarts the workspace worker only | Tested end to end. |
| 31 | Editor | CodeMirror vs textarea | **Textarea** with tab support | Fewer dependencies for V1. |
| 32 | Chart library | uPlot, Plotly, D3 | **uPlot** | Fast with 100k+ points, built-in cursor sync. |
| 33 | Multiple tabs | — | **One tab per origin assumed** | The Service Worker keeps one port per route; a second tab takes over. Recorded limitation. |
| 34 | Spec-kit (PR-02) | full constitution/specify/plan/tasks now vs later | **Not in this PR** | This PR is the first working version; ADRs and a finding are included. |
| 35 | Vocabulary gate (PR-01) | — | `scripts/vocab_gate.py` reads terms from the `VOCABULARY_TERMS` secret; prints locations only; passes with a notice when unset | Watched failing in a test (PR-03). **Action for you:** add the secret. |
| 36 | ntfy progress notifications | — | **Not sent** | The session's permission policy blocked the outbound call. |
