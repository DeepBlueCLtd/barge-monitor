# Software Requirements Document
## Canal barge weather demonstrator, Version 1

**Status:** Draft for review
**Author:** Doc
**Working name:** to be chosen (see §10). This document says *the demonstrator*.

---

## 1. Purpose

The demonstrator is a **system and architecture demonstrator** set aboard an
**uncrewed electric cargo barge** shuttling freight between two wharves on a fictional
canal, around the clock, for weeks at a time. The barge carries a weather sensor at the
**bow** and another at the **stern**, about twenty metres apart, logging to an old data
logger in its equipment locker. The demonstrator runs whole in one browser session and shows
a standards-based display and analysis architecture working over that data.

Its audience is **people deciding whether to adopt this architecture** for a small,
long-lived system with an old store. It exists to make two claims, in this order:

1. **C1. A standards facade over an awkward legacy store works.** An OGC API-EDR server
   can sit in front of a store it does not control, while that store grows, and serve
   a modern display and analysis code without changing the store.
2. **C2. The architecture transfers to small, old systems.** A standards seam, a clock
   and RNG as ports, scored ground truth, and Python analysis as an ordinary client are
   worth their cost at small scale.

Both claims are supported by acceptance tests (§9), never asserted by the display.

- **NFR-01 (One browser session.)** Every component runs in the browser. No step of
  building, testing or demonstrating requires a server, a container or a daemon.
- **NFR-02 (Two languages, by design.)** The front end is TypeScript; the backend and all
  analysis are Python running in Pyodide. The second language is the point: it is the
  language the backend and an analyst's code would be written in for real.
- **NFR-03 (The backend is deployable.)** The Python backend is a standard ASGI
  application. The code that runs in the demonstrator runs unchanged under an ordinary
  ASGI server, and a test proves it (AT-02).

### 1.1 What this is not

- **FR-01** The demonstrator models no real canal, boat, person or place. The canal, its
  towns, locks and tunnels are fictional and sit at a **declared fictional location**; no
  coordinate in the repository is a real place someone lives. The weather is synthetic.
  The landing page states this plainly.
- It is not a weather or navigation product. Its numbers are plausible, not accurate.

---

## 2. Architecture

One browser application in three parts, with one seam between them:

- **The display**: TypeScript and React, rendering everything a reader sees.
- **The backend**: Python in a Pyodide Web Worker, holding the simulation, the boat, the
  sensors, the logger stand-in, the store adapter, the EDR server and the analysis
  service.
- **The analyst's workspace**: Python in a second, separate Pyodide Web Worker, running
  code a reader edits in the browser.

### 2.1 The seam

- **FR-02** All traffic between the display, the backend and the workspace crosses as
  HTTP and nowhere else. Requests are relative URLs, intercepted by a **Service Worker**
  and passed to the backend worker, which calls the ASGI application directly. The
  Service Worker contains no application logic.
- **FR-03** The display and the workspace are clients of the same interface. Requests from
  the workspace worker pass through the same Service Worker as requests from the display;
  neither has a private route into the backend.
- **FR-04** No client code or configuration carries an absolute URL. Pointing the display
  at a real server is a change of base URL alone.
- **FR-05** Every shape crossing the seam is governed by a committed master: OpenAPI for
  the HTTP interface, CoverageJSON for coverage responses, JSON Schema for request
  parameters and results. Seam traffic is validated against the masters in tests.

### 2.2 Honest ports

Genuine ports, each with more than one real implementation planned: the **seam
transport** (Service Worker today, network later), the **clock**, the **RNG**, and the
**store adapter** (the stand-in today, other formats later). Nothing else is presented as
pluggable.

---

## 3. Simulated world, time and randomness

- **FR-06** The barge shuttles **continuously, day and night**, between two wharves on a
  fictional canal declared as a **centreline with chainage** (distance along the canal).
  It turns at each wharf after a declared dwell for loading. It moves at canal speed
  within a declared limit, stops at **locks** where its elevation changes, and slows
  through **bridges and the tunnel**. Its position, heading and speed are a pure function
  of the clock, the declared timetable and its seed stream. A run lasts **weeks** of
  simulated time.
- **FR-06a** Because every place on the route is passed **many times a day, in both
  directions and at every hour**, the data contains **revisits**: the same place at
  different times and times of day, and the same weather at different places. Revisits
  are what let the analysis separate the effect of place from the effect of weather and
  of the diurnal cycle (FR-22). The timetable is declared so that every reach is passed
  in every hour of the day within the first week, and the timetable's period does not
  divide a day evenly, so passes drift through the clock rather than repeating at the
  same hours.
- **FR-06b** The timetable declares occasional **stoppages** (a lock closed for repair, a
  wharf delay), so the record contains long stationary periods at one place, as a real
  long-running vessel's would.
- **FR-07** Two sensors, **bow** and **stern**, separated by a declared distance along the
  boat, each report seven parameters once per simulated second:

  | Parameter | Unit | Note |
  |---|---|---|
  | Air temperature | °C | |
  | Relative humidity | % | |
  | Barometric pressure | hPa | Station pressure; changes with elevation at locks |
  | Apparent wind speed | m s⁻¹ | Relative to the moving boat |
  | Apparent wind direction | degrees relative to the bow | Relative to the moving boat |
  | Solar irradiance | W m⁻² | |
  | Water temperature | °C | Canal surface water |

- **FR-08** The canal passes through declared **reaches**, each with its own
  microclimate: open embankment, sheltered cutting, woodland, town (urban heat), an
  aqueduct over a valley, and a **tunnel** (dark, still, cool and damp). Each reach
  declares how it modifies the weather. These are the demonstrator's equivalent of
  crossing into a new body of water.
- **FR-09** Over the reaches, the weather passes through **several air masses separated by
  fronts**. Each air mass declares a mean and a covariance over the parameters; each front
  declares an arrival time, a passage duration and the change it brings. A diurnal cycle
  drives temperature and irradiance. Readings carry declared noise and occasional spikes.
- **FR-10** Every run writes a **manifest** recording the canal, its reaches and locks, the
  voyage plan, the air masses, fronts, diurnal cycle, noise model, seeds and generator
  version. The manifest is the ground truth that detection, clustering and correction are
  scored against.
- **FR-11** All components read time from the simulation clock; no host clock is used for
  any operational purpose. The clock runs in real time or **accelerated**, with rate
  controlled from the display within declared bounds, because a run takes weeks and a
  demonstration takes minutes. At the highest declared rate, a week of simulated time
  passes in under an hour.
- **FR-12** All randomness comes from named, seeded streams recorded in the manifest.

---

## 4. Components

| ID | Component | Responsibility |
|---|---|---|
| B-C01 | Simulation clock | Single source of time; real time or accelerated; a port for later replay |
| B-C02 | World generator | Canal, reaches, air masses, fronts, diurnal cycle, noise; writes the manifest |
| B-C03 | Boat | Moves along the canal under the voyage plan; locks, tunnels, moorings |
| B-C04 | Sensors | Bow and stern; sample the world at the boat's positions at 1 Hz |
| B-C05 | Logger stand-in | Deliberately awkward, append-only storage (FR-13) |
| B-C06 | Store adapter | The only code that understands the logger's format |
| B-C07 | EDR server | OGC API-EDR over the adapter, as an ASGI application |
| B-C08 | Analysis service | Derived values, correlation, detection and clustering, served in EDR shape |
| B-C09 | Analyst's workspace | In-browser Python editor and its own Pyodide worker |
| B-C10 | Display | Linked charts, the canal map, analysis views and their controls |

---

## 5. Functional requirements

### 5.1 The logger stand-in

- **FR-13** The stand-in shall be **deliberately awkward**, the way an old logger's archive
  is: fixed-width text records, bow and stern in separate files rolling over daily,
  position held as a GPS sentence string rather than numbers, time in a non-standard unit
  and epoch, coded values for some fields, no index, and records appended while they are
  being read. It is not a tidy modern store wearing an old label.
- **FR-14** The stand-in is written only by the sensors and read only by the store adapter.
  Nothing else knows its format.
- **FR-15** The claim C1 is stated as *the facade works over an awkward store, to be
  confirmed against a real one*. The landing page and the documentation say so.

### 5.2 The EDR server

- **FR-16** The EDR server shall serve the sensor data as an honest subset of OGC API-EDR:
  collection discovery, **trajectory** queries along the boat's track carrying a time at
  each vertex, and **corridor** queries along a stretch of canal, both returning
  CoverageJSON.
- **FR-17** Every unsupported query type, option or parameter is refused with the thing
  refused named. The served conformance statement matches the code, held by a test.
- **FR-18** Responses reflect the store as it stands at the moment of the request, including
  records appended during the run.
- **FR-18a** The facade shall stay responsive as the store grows over a **multi-week run**:
  two sensors at 1 Hz write about 1.2 million records a week. A declared query, such as
  the last hour along the route or one reach across all passes, shall answer within a
  declared time budget at any point in the run, and the facade may build **its own
  index** over the store to meet it. The store itself is never altered, and the index is
  rebuilt from the store if lost, never the other way round.
- **FR-18b** A query whose result would exceed a declared size is refused with the limit
  named, and the refusal states how to narrow it. The facade never times out silently or
  returns a truncated result as though it were complete.
- **FR-19** Quality control (spike and range flagging, and GPS dropout inside the tunnel) is
  applied in the facade as **flags**, never by altering stored records. Raw values remain
  retrievable.

### 5.3 The analysis service

- **FR-20** The analysis service computes **derived values**:
  - **true wind** from apparent wind, the boat's heading and its speed;
  - **pressure reduced to a common datum**, removing the steps the locks introduce;
  - **dew point** and the air-minus-water temperature difference;
  - the **bow-minus-stern difference**, after **lag correction**: the stern's reading
    aligned to the moment it reached the bow's position, using the boat's speed. Without
    this, every change looks like a gradient along the boat.
- **FR-21** It also computes a **correlation matrix** over a chosen window, sensor and
  parameter set; a **reach detector** flagging a sustained change of conditions, never a
  single spike; and a **clustering** of readings into regimes.
- **FR-22** The analysis must separate **where the boat is** (its reach) from **what the
  weather is doing** (fronts and the diurnal cycle). The detector reports which of the two
  it believes caused each change. The service also estimates each reach's **standing
  offset** from the revisits: what that reach does to each parameter, after the weather
  common to all passes is removed. Each offset carries the number of passes it rests on.
- **FR-23** Analysis parameters (window, sensor, parameters included, number of clusters,
  detector sensitivity) come from the reader through the display. The service owns the
  bounds and refuses an out-of-range value by naming the bound.
- **FR-24** Every analysis result carries the parameters and data range it was computed
  from.
- **FR-25** Results are served in the **same EDR and CoverageJSON shape as the sensor
  data**, so the display renders them with no code specific to the analysis. This is the
  *promotion contract*, and the analysis service is its first user.
- **FR-26** Results are **scored against the manifest**: each detected change against the
  reach boundaries and fronts that caused it, each cluster against the reaches and air
  masses, true wind against the declared wind, the lag correction against the declared
  sensor separation. A result is never presented as correct merely because it looks
  plausible.

### 5.4 The analyst's workspace

- **FR-27** The display offers an **in-browser Python editor**. Code written there runs in its
  own Pyodide worker, separate from the backend, and reaches the backend only through the
  seam, as an ordinary EDR client.
- **FR-28** A broken, slow or failing script shall never affect the backend. Errors are
  shown in the workspace; the display and the EDR server keep running.
- **FR-29** A script may **promote** its output by serving it in the promotion contract's
  shape (FR-25) at a configured path prefix. The display then renders it as it renders
  any other series, with no new display code.
- **FR-30** The workspace ships with worked examples using the libraries available in
  Pyodide (numpy, pandas, scipy, scikit-learn), among them a tunnel detector and a
  comparison of bow and stern before and after lag correction.

### 5.5 The display

- **FR-31** The display shows the seven parameters as **linked time-series charts**, bow and
  stern overlaid, with a shared cursor and zoom across all seven. Wind direction is drawn
  as a direction, never as a line jumping between 359 and 0 degrees.
- **FR-32** The display shows a **map of the canal** with its reaches, locks and tunnel, the
  boat's track so far coloured by any parameter or by cluster, and the boat's current
  position and heading. Moving the shared cursor on the charts moves a marker on the map.
- **FR-33** The display shows the analysis outputs: derived series, the correlation matrix,
  a scatter of any two parameters, detected changes as marks on the time axis and the
  map, and cluster assignments, each with its score against the manifest (FR-26).
- **FR-34** Analysis controls (FR-23) and clock controls (FR-11) are drawn from the backend's
  own statement of what it accepts. The display holds no bounds of its own.
- **FR-35** Live data reaches the display by **polling the EDR server at 1 Hz**. This is a
  recorded placeholder, not a tested design for live delivery, and the documentation says
  so (see §11).
- **FR-36** While Pyodide loads, the display shows its progress honestly. It never shows an
  empty chart as though the logger were empty.

---

## 6. Interfaces and shared types

- **NFR-04** Masters under `contracts/` are the single authority for seam shapes. TypeScript
  types are generated from them for the display; the Python backend validates against the
  same masters.

## 7. Delivery

- **NFR-05** The demonstrator builds to static assets and is published as a public site on
  gh-pages. Each visit starts a fresh seeded run; nothing persists between visits.
- **NFR-06** Pyodide and every Python package are served from the site itself, never from a
  third-party CDN, so every request is same-origin.
- **NFR-07** The site is served over HTTPS, which the Service Worker requires.
- **NFR-08** A startup time budget is declared and measured (see §10).

## 8. Development process

- **PR-01** The repository is public. It contains no material about any other project,
  customer or system, and no real place. A vocabulary gate enforces a list of forbidden
  terms, which is held privately rather than committed.
- **PR-02** Spec-kit carries: constitution, specify, plan, tasks, analyze, implement. ADRs
  record contested or hard-to-reverse decisions; spikes write a dated `FINDING.md`.
- **PR-03** Every gate and every refusal test is watched failing before it is trusted.
- **PR-04 (Persistent previews.)** Every pull request publishes a rendered preview of its
  documents and site to gh-pages under `pr/<number>/`, refreshed on each push and left in
  place after the pull request closes, so that review links stay live. The published
  root always reflects `main`. A preview from a fork is built but not published.

## 9. Acceptance criteria

| ID | Test | Supports |
|---|---|---|
| AT-01 | A trajectory query through the seam returns values matching the manifest's ground truth at the boat's positions and times, while the logger is growing | C1 |
| AT-02 | The same ASGI application passes the same contract test suite in Pyodide behind the Service Worker and in CPython under an ordinary ASGI server | C2 |
| AT-03 | Replacing the logger stand-in with a second, differently awkward format requires changes to the store adapter only, and AT-01 still passes | C1 |
| AT-04 | The reach detector and the clustering recover the manifest's reach boundaries, fronts and air masses with known and reported scores, and the detector attributes each change to place or weather correctly at a reported rate | C2 |
| AT-05 | Lag correction reduces the bow-minus-stern difference across a reach boundary to within a bound derived from the declared noise, never typed into the test | C2 |
| AT-06 | The reach offsets estimated from revisits recover the manifest's declared reach effects within a bound derived from the declared noise and the number of passes, and the bound tightens as passes accumulate | C2 |
| AT-07 | After four simulated weeks, the declared queries of FR-18a still meet their time budget in the browser, and deleting the facade's index and rebuilding it from the store reproduces identical query results | C1 |
| AT-08 | An edit to a workspace script changes what the display shows without a page reload; a deliberately broken script leaves the EDR server answering | C2 |

## 10. Open questions

- **Name.** A coined working name with no association.
- **Collection layout.** One collection per sensor, or one collection with bow and stern as
  parameter groups (FR-16). Decided by the first spike.
- **Browser memory.** Weeks of records, a facade index and two Pyodide workers in one
  tab may press on browser memory limits. Whether the stand-in lives in memory or in the
  browser's Origin Private File System is decided by measurement, and the answer is
  itself a finding worth recording.
- **Startup budget.** Two Pyodide workers with scientific packages is a large first load.
  The budget, and whether the workspace worker loads lazily, are decided by measurement.
- **Second stand-in format.** What the second format for AT-03 looks like.

## 11. Deliberate exclusions from Version 1

- **Replay of recorded trips.** The clock is a port so that replay can follow without a
  second code path.
- **Push delivery.** Polling stands in (FR-35), deliberately.
- **Real weather, real waterways and real places.**
- **Persistence, authentication and a release boundary.**
