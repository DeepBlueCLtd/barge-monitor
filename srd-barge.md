# Software Requirements Document
## Canal barge weather demonstrator, Version 3.2

**Status:** Draft for review
**Author:** Doc
**Working name:** to be chosen (see §13). This document says *the demonstrator*.

**Changes from Version 3.1** (from Spike 0, `FINDING-2026-11-20-connected-systems.md`):
- System types corrected: Platform, Sensor, and System with asset type Process (FR-23).
- QC flags are separate Category fields in each record (FR-24).
- Media types, the `obsFormat` schema parameter and polling by `phenomenonTime` fixed
  (FR-25, FR-63).
- Commands are POSTed; bounds live in the control stream's schema (FR-26).
- Promotion uses standard resource creation (FR-36).
- A field toggle yields a new datastream identifier (FR-46c).
- OGC API – Features and Common prerequisites added (FR-22); the subset is declared
  (FR-22a).
- Independent Connected Systems clients must browse the server (AT-16).

**Changes from Version 3:**
- A missing essential source no longer blocks the client. The client starts in
  **degraded mode**, warns once after the handshake, and disables the controls for the
  affected views (FR-41).
- A **control panel** takes the server down and up, and adds or removes a handful of
  measured and calculated fields, applied at the next server start (§6.5).
- Calculated fields declare their inputs; a field whose inputs are off is not published
  (FR-32a).

**Changes from Version 2:**
- The real system measures **no position**, so the GPS receiver, the map and every
  position-dependent analysis are removed.
- **OGC API – Connected Systems** (Parts 1 and 2) replaces OGC API-EDR and CoverageJSON
  as the query standard (§5.2).
- The display client and the server are **decoupled**: the client discovers what the
  server offers, checks it against a **declared profile**, and configures itself (§6).
- Sources are **essential** (missing means an error) or **optional** (rendered by schema
  type, with no specific knowledge) (§6.2, §8).
- **Restart client** and **restart server** buttons; the server's waiting mode uses
  standard HTTP (§6.4).
- The simulation **starts off**, with a **play/pause** button and a **½× default**
  speed (§7.4).
- The message key is redone for the new standards (§7.2).

---

## 1. Purpose

The demonstrator is a **system and architecture demonstrator** set aboard an
**uncrewed electric cargo barge** shuttling freight between two wharves on a fictional
canal, around the clock, for weeks at a time. The barge carries a weather sensor at the
**bow** and another at the **stern**, about twenty metres apart, logging to an old data
logger in its equipment locker. It records **no position**. The demonstrator runs whole
in one browser session.

Its intention is to show that **the author's understanding of the software architecture
is complete**, and therefore that **the software need not be a risk to the project and
does not need a large contingency**. It does this by making the architecture itself the
thing on screen: every component, every interaction, and every real message, each
labelled with the standard it meets.

Its audience is **stakeholders deciding whether to adopt this architecture**. It makes
three claims:

1. **C1. A standards facade over an awkward legacy store works.** An OGC API – Connected
   Systems server can sit in front of a store it does not control, while that store
   grows, and serve a modern display and analysis code without changing the store.
2. **C2. A client can configure itself from the server.** The display discovers what is
   on offer through standard discovery, fails clearly when an essential source is
   missing, and handles sources it has never seen without new code.
3. **C3. The architecture transfers to small, old systems.** A standards seam, a clock
   and RNG as ports, scored ground truth, and Python analysis as an ordinary client are
   worth their cost at small scale.

The claims are supported by acceptance tests (§12), never asserted by the display.

- **NFR-01 (One browser session.)** Every component runs in the browser. No step of
  building, testing or demonstrating requires a server, a container or a daemon.
- **NFR-02 (Two languages, by design.)** The front end is TypeScript; the backend and all
  analysis are Python running in Pyodide.
- **NFR-03 (The backend is deployable.)** The Python backend is a standard ASGI
  application that runs unchanged under an ordinary ASGI server (AT-02).

### 1.1 What this is not

- **FR-01** The demonstrator models no real canal, boat, person or place. The canal, its
  towns, locks and tunnel are fictional. The weather is synthetic. The landing page
  states this plainly.
- It is not a mock of any real application's user interface, and not a weather or
  navigation product.

---

## 2. Architecture

One browser application in three runtimes, with one seam between them:

- **The display client**: TypeScript and React, on the main thread. It holds no
  knowledge of the server beyond a base URL and the declared profile.
- **The backend**: Python in a Pyodide Web Worker, holding the simulated world, the
  logger store, the store adapter, the Connected Systems server and the analysis
  service.
- **The analyst's workspace**: Python in a second, separate Pyodide Web Worker, running
  code a reader edits in the browser, including promoted products.

### 2.1 The seam

- **FR-02** All traffic between the display client, the backend and the workspace crosses
  as HTTP and nowhere else. Requests are relative URLs, intercepted by a **Service
  Worker relay** and passed to the worker that serves the path. The relay contains no
  application logic.
- **FR-03** The display client and the workspace are clients of the same interface;
  neither has a private route into the backend.
- **FR-04** No client code or configuration carries an absolute URL.
- **FR-05** Every shape crossing the seam is governed by a committed master under
  `contracts/`: OpenAPI for the HTTP interface, SWE Common schemas for observation
  records, the declared profile (§6.1), and JSON Schema for anything else. Seam traffic
  is validated against the masters in tests.
- **FR-06** The server is **stateless with respect to clients**. It holds no sessions and
  does not know which clients exist. Everything a client does to connect, reconnect or
  reset is client behaviour, checked by tests.

### 2.2 Honest ports

Genuine ports, each with more than one real implementation planned: the **seam
transport**, the **clock**, the **RNG**, and the **store adapter**. Nothing else is
presented as pluggable.

---

## 3. Simulated world, time and randomness

- **FR-07** The barge shuttles **continuously, day and night**, between two wharves. It
  turns at each wharf after a declared dwell, stops at **locks**, and slows through
  **bridges and the tunnel**. Its movement is a pure function of the clock, the declared
  timetable and its seed stream. The timetable's period does not divide a day evenly, so
  the barge meets every part of the canal at every hour over a week.
- **FR-08** The timetable declares occasional **stoppages** (a lock closed, a wharf
  delay), giving long stationary periods.
- **FR-09** Two sensors, **bow** and **stern**, separated by a declared distance, each
  report seven parameters once per simulated second:

  | Parameter | Unit | Essential (§6.2) |
  |---|---|---|
  | Air temperature | °C | **Yes** |
  | Apparent wind speed | m s⁻¹ | **Yes** |
  | Relative humidity | % | Optional |
  | Barometric pressure | hPa | Optional |
  | Apparent wind direction | degrees relative to the bow | Optional |
  | Solar irradiance | W m⁻² | Optional |
  | Water temperature | °C | Optional |

- **FR-10** The barge carries **no position measurement**. Its position exists only in
  the simulated world and the manifest, for generating conditions and for scoring.
  Nothing in the logger store records it, and no analysis may use it.
- **FR-11** The canal passes through declared **reaches**, each with its own microclimate:
  open embankment, sheltered cutting, woodland, town, an aqueduct, and a **tunnel**.
- **FR-12** The weather passes through **several air masses separated by fronts**, each
  declared with a mean and covariance, arrival, duration and effect. A diurnal cycle
  drives temperature and irradiance. Readings carry declared noise and occasional spikes.
- **FR-13** Every run writes a **manifest** recording the canal, reaches, timetable, air
  masses, fronts, diurnal cycle, noise model, seeds and generator version. It is the
  ground truth that analysis is scored against.
- **FR-14** All components, including the display client's polling and every workspace
  script, read time from the **simulation clock**. No host clock is used for any
  operational purpose.
- **FR-15** All randomness comes from named, seeded streams recorded in the manifest.

### 3.1 History pre-generated at startup

- **FR-16** At startup the demonstrator **pre-generates four weeks of history** (about five
  million records per sensor) through the same sensor-to-logger path on a fast clock.
  Message capture records counts only during this phase; no icons are drawn.
- **FR-17** Pre-generation shows its progress honestly. The flowchart and panels become
  available only when it has finished.
- **FR-18** After pre-generation the simulation is **off** until the viewer presses play
  (FR-52).

---

## 4. Components

Each component is drawn as one node on the flowchart and belongs to exactly one **zone**.
The node list corresponds **one-to-one** with the real system's architecture, under
neutral names.

| ID | Component | Zone | Responsibility |
|---|---|---|---|
| B-C01 | Simulation clock | Simulated | Single source of time; off at start; play/pause; legible rates |
| B-C02 | World generator | Simulated | Canal, reaches, air masses, fronts, noise; writes the manifest |
| B-C03 | Barge | Simulated | Moves along the canal under the timetable |
| B-C04 | Sensors | Simulated | Bow and stern; sample the world at 1 Hz |
| B-C05 | Logger store | Legacy | Deliberately awkward, append-only storage (FR-19) |
| B-C06 | Store adapter | New build | The only code that understands the logger's format |
| B-C07 | Connected Systems server | New build | Discovery, datastreams, observations, control streams; waiting mode |
| B-C08 | ASGI framework | Third-party | FastAPI and Starlette: routing, validation, OpenAPI |
| B-C09 | Analysis service | New build | A *process* system: derived values, change detection, correlation, clustering |
| B-C10 | Scientific libraries | Third-party | numpy, pandas, scipy, scikit-learn |
| B-C11 | Seam relay | New build | Service Worker passing HTTP to the right worker; no logic |
| B-C12 | Analyst's workspace | New build | CodeMirror editor and its own Pyodide worker |
| B-C13 | Promoted products | New build (scientist-authored) | Scientists' scripts registered as process systems with their own datastreams |
| B-C14 | Display client | New build | Handshake, profile check, self-configuration, panels |
| B-C15 | Demonstrator shell | New build | Flowchart, controls, key, tour; not part of the real system |
| B-C16 | Browser and Pyodide runtime | Third-party | Hosts the workers and the relay |

- **FR-19a** The **display client** (B-C14) stands for the real system's user interface and
  is restartable on its own. The **demonstrator shell** (B-C15) is the frame around
  everything, exists only to demonstrate, and is drawn outside the four zones.

---

## 5. Functional requirements: the system

### 5.1 The logger store

- **FR-19** The store is **deliberately awkward**: fixed-width text records, bow and stern
  in separate files rolling over daily, time in a non-standard unit and epoch, coded
  values for some fields, no index, and records appended while being read.
- **FR-20** The store is written only by the sensors and read only by the store adapter.
  It is **independent of the server**: it keeps receiving records while the server is
  restarting (FR-40).
- **FR-21** C1 is stated as *the facade works over an awkward store, to be confirmed
  against a real one*.

### 5.2 The Connected Systems server

The server implements an honest, declared subset of **OGC API – Connected Systems
Part 1 (Feature Resources)** and **Part 2 (Dynamic Data)**.

- **FR-22** **Discovery**, including the prerequisites Connected Systems inherits from
  OGC API – Features Part 1 (Core) and OGC API – Common Part 1: the landing page, the
  conformance declaration, the API definition, `/collections`, paging links, and the
  `limit` and `datetime` parameters; plus a link to the declared profile (§6.1).
- **FR-22a** The implemented subset is the one declared in the Spike 0 finding (§4 there)
  and recorded in an ADR: Part 1 Common, System Features, Subsystems, Property
  Definitions, Create/Replace/Delete for systems, and the SensorML encoding; Part 2
  Common, Datastreams and Observations, Control Streams and Commands, Create/Replace/
  Delete for datastreams, observations and commands, and the JSON and SWE Common JSON
  encodings. Everything else is refused by name (FR-27).
- **FR-23** **Systems** (Part 1), with the standard `systemType` values: the barge is a
  **Platform**; bow and stern are **Sensors**, as its subsystems; the analysis service
  and each promoted product are `systemType` **System** with `assetType` **Process**. No
  system carries a location.
- **FR-24** **Datastreams** (Part 2): one **record datastream per sensor**, whose SWE Common
  3.0 schema declares the seven parameters as Quantity fields with units, and, for each
  parameter, a **separate Category field carrying its QC flag** in the QARTOD vocabulary.
  Each measurement's `quality` attribute refers to its flag field, as SWE Common 3.0
  prescribes for quality that varies per value. Each analysis output and each promoted
  product is a datastream of its own process system. A datastream's schema is fetched
  from `/datastreams/{id}/schema?obsFormat=…`.
- **FR-25** **Observations** (Part 2), filtered by `phenomenonTime` (and `resultTime`,
  including `latest`) with `limit` and paging. Discovery resources are served as
  `application/json`; observations as **SWE Common JSON** (`application/swe+json`).
  There is no per-field filter: a client fetches whole records and selects fields.
- **FR-26** **Control streams and commands** (Part 2) on the analysis service, carrying
  the reader's analysis settings (window, parameters, number of clusters, detector
  sensitivity). Commands are **POSTed** to `/controlstreams/{id}/commands`. The **bounds
  live in the control stream's schema** as SWE Common constraints; a command outside
  them is rejected with **HTTP 400** naming the bound. Each accepted command carries a
  status (pending through completed or failed).
- **FR-27** Every unsupported resource, query parameter or encoding is refused with the
  thing refused named. The served conformance declaration matches the code, held by a
  test.
- **FR-28** Responses reflect the store at the moment of the request.
- **FR-29** Declared queries (the last hour from each sensor; one parameter across a
  week) answer within a declared time budget over four weeks of history. The server may
  build **its own index**; the store is never altered, and the index is rebuilt from the
  store when lost, including on every server restart.
- **FR-30** A query whose result would exceed a declared size is refused with the limit
  named and how to narrow it. Nothing is silently truncated.
- **FR-31** QC flags are computed by the server and carried in the quality fields, never
  by altering stored records.

### 5.3 The analysis service

- **FR-32** The analysis service is a **process system** publishing these datastreams:
  - **Derived values**: dew point, air-minus-water temperature difference, and the
    bow-minus-stern difference for each parameter (unaligned; no lag correction is
    possible without speed).
  - **Change detector**: flags a sustained change of regime, never a single spike.
  - **Correlation matrix** over the commanded window and parameter set.
  - **Clustering** of readings into regimes.
- **FR-32a** Every calculated field **declares its inputs** (dew point needs air temperature
  and humidity; air-minus-water needs air and water temperature; and so on). The server
  does not publish a calculated field whose inputs are not all published, so switching
  off an input also removes everything calculated from it.
- **FR-33** Every result carries the settings and data range it was computed from.
- **FR-34** Results are **scored against the manifest** (fronts, air masses, reach
  boundaries) and the score is published with them. The analysis itself never sees the
  manifest or the position.

### 5.4 The analyst's workspace and promoted products

- **FR-35** Code written in the workspace runs in its own Pyodide worker and reaches the
  backend only through the seam, as an ordinary Connected Systems client. A broken or
  slow script never affects the backend.
- **FR-36** A script may **promote** its output using standard resource creation only: it
  POSTs a **System** (`assetType` Process), then a **datastream** under it with a SWE
  Common schema, then its **observations**. No promotion-specific endpoint exists. From
  then on the product appears in discovery like any other source.
- **FR-37** A promoted product reaches the display client only at its **next handshake**
  (FR-41). The viewer triggers this with **restart client** (FR-42).

---

## 6. Functional requirements: client and server lifecycle

### 6.1 The declared profile

- **FR-38** A **declared profile** is a committed document, validated by JSON Schema,
  listing the **essential sources**: for each, the system, the datastream, the field, its
  SWE Common type and its unit. In Version 3 the essentials are:
  - bow and stern **air temperature** (°C);
  - bow and stern **apparent wind speed** (m s⁻¹);
  - the analysis service's **derived values**, **change detector**, **correlation matrix**
    and **clustering** datastreams.
- **FR-39** The server publishes the profile and links it from its landing page. The
  client checks **both** that the server claims the profile **and** that discovery
  actually satisfies it. A claim that discovery contradicts is an error, never a pass.

### 6.2 The handshake

- **FR-40** On starting, the display client performs a **handshake** made only of standard
  discovery: landing page, conformance, profile, systems, datastreams and their schemas.
  No bespoke handshake message exists.
- **FR-41** From the handshake the client **configures itself**:
  - each **essential** source is bound to its specific view (§8.1);
  - every **other** datastream field, whether a raw optional parameter or a promoted
    product, is treated as an **abstract measurement** and given a generic view chosen
    from its schema (§8.2);
  - if any essential source is **missing, or has the wrong type or unit**, the client
    still starts, in **degraded mode**:
    - immediately after the handshake it shows **one warning popup listing every
      unavailable essential source** and why (missing, wrong type, wrong unit);
    - each view that depends on an unavailable source is shown as **unavailable**,
      never as an empty chart;
    - the **control that opens that view is disabled**, and hovering over it names the
      missing source;
    - every view whose sources are present works normally.
  - a missing **optional** source produces no warning; it simply does not appear.
- **FR-41a** Discovery happens **only at handshake**. A client never adds or removes
  sources while running.

### 6.3 Restart client

- **FR-42** A **restart client** button discards the display client's entire state and
  starts it afresh, beginning with a new handshake. The backend, its history and the
  workspace carry on undisturbed. This stands for reloading the real user interface.

### 6.4 Restart server and waiting mode

- **FR-43** A **restart server** button restarts the Connected Systems server. The logger
  store and sensors carry on (FR-20).
- **FR-44** On starting, the server enters **waiting mode** while it rebuilds its index:
  every request is answered with **HTTP 503 Service Unavailable and a `Retry-After`
  header** (RFC 9110). It leaves waiting mode when ready.
- **FR-45** Each server start creates a fresh **instance identifier**, sent as the `ETag`
  of the landing page and as a response header on every reply.
- **FR-46** A client that receives 503 waits for the period given in `Retry-After` and
  retries. A client that sees the **instance identifier change** clears its state and
  repeats the handshake. These are client behaviours; the server enforces nothing.

### 6.5 Control panel

The control panel belongs to the demonstrator shell (B-C15), not to the real system. It
stands in for the things that happen to a real deployment: a server taken down, a sensor
not fitted, a product withdrawn or added.

- **FR-46a** **Take server down / bring server up.** While down, the server does not answer
  at all: the seam relay returns a **network failure**, not an HTTP status, as a real
  unreachable server would. On the flowchart the request icon stops at the relay and is
  marked as failed. The client shows a **server unreachable** banner, keeps its last data
  on screen marked as stale, and retries on the simulation clock. Bringing the server up
  is an ordinary server start (FR-44, FR-45). The logger store and sensors carry on
  throughout (FR-20).
- **FR-46b** **Field toggles.** A short list of fields can be switched on or off:
  - every **raw parameter** (applied to both sensors together), including the essential
    air temperature and wind speed, so degraded mode can be shown;
  - every **calculated field** of the analysis service;
  - three **extra fields** that are off by default and that the display client has never
    seen, one for each generic view (FR-61): **precipitation type** (measured, a
    Category), **pressure tendency over three hours** (calculated, a Quantity), and
    **spikes flagged in the last hour** (calculated, a Count).
- **FR-46c** A toggle changes **what the server publishes**, never what the sensors measure
  or what the logger stores. Stored history is unchanged, so switching a field back on
  restores its full history. Because changing a datastream's schema is a breaking change
  in Connected Systems, a datastream whose schema changes is published under a **new
  identifier**, never the old identifier with a new schema.
- **FR-46d** A toggle takes effect **only at the next server start**. Until then it is shown
  as a **pending change**, with a prompt to restart the server. The restart gives a new
  instance identifier, so every client repeats its handshake and sees the new offering.
  The server's offering never changes while it is running.
- **FR-46e** The control panel shows, for each field, whether it is **published now** and
  whether a change is **pending**, and states each calculated field's inputs (FR-32a), so
  the viewer can predict what a toggle will remove.

---

## 7. Functional requirements: the architecture view

The flowchart is the **main view**. Everything else is docked around it (§8).

### 7.1 Message capture

- **FR-47** Messages on the flowchart are **real messages captured at every component
  boundary** in §4, including in-process calls. Nothing is scripted. Capture uses one
  tap mechanism, never alters a message or the behaviour of either side, and is tested
  by running the system with capture on and off and comparing results.
- **FR-48** **Every** message is shown. None is sampled or merged.

### 7.2 The letter key

- **FR-49** Each message is drawn as an icon with a **colour-coded letter** for the standard
  it meets. A key on screen lists every letter:

  | Letter | Standard |
  |---|---|
  | Q | OGC API – Connected Systems request |
  | D | Discovery resource: landing page, conformance, SensorML or GeoJSON system and datastream descriptions, SWE Common schema |
  | O | Observations, SWE Common JSON |
  | K | Command on a Connected Systems control stream |
  | P | Declared profile, validated by JSON Schema |
  | H | Plain HTTP status: 503 with `Retry-After` (RFC 9110) |
  | L | Legacy fixed-width record (the logger's own format) |
  | I | Internal typed object, no public standard |

  Messages that meet no public standard are named honestly as **L** or **I**.
- **FR-50** Clicking a message icon opens a **popup showing the message contents and the
  standard it meets**. Nothing else is shown.

### 7.3 Layout, zones and nodes

- **FR-51** The flowchart is drawn with **React Flow (xyflow)** from a **fixed,
  hand-designed layout** held in a committed file. The four **zones** (simulated,
  legacy, new build, third-party) are drawn as labelled, shaded regions. Clicking a node
  shows its **responsibility and interfaces**: what it does, and which letters it
  accepts and emits on which flows.

### 7.4 Time controls

- **FR-52** The simulation **starts off**. A single **play/pause** button starts and stops
  the **simulation clock**, which starts and stops the whole system. When paused, icons
  freeze in place and remain clickable.
- **FR-53** A **speed control** runs from 0.1× up to the **fastest rate at which every icon
  remains legible**, verified on the target display. The **default is ½×**.
- **FR-54** Restart client, restart server and the control panel (FR-42, FR-43, §6.5) work
  whether the simulation is playing or paused. While paused, their messages are drawn and frozen, so a handshake can
  be inspected step by step.

---

## 8. Functional requirements: docked panels

Three panels dock around the flowchart: **time-series charts**, the **Python workspace**,
and **analysis views**. Every panel is built by the display client from its handshake.

### 8.1 Specific views for essential sources

- **FR-55** **Air temperature** and **apparent wind speed**, bow and stern overlaid, as
  linked time-series charts with a shared cursor and zoom.
- **FR-56** **Derived values** as linked time series alongside them.
- **FR-57** The **change detector**'s flags as marks on the shared time axis, with its score.
- **FR-58** The **correlation matrix** as a heatmap, with its window and parameter set.
- **FR-59** **Clustering** as a regime band along the time axis, with its score.
- **FR-60** Analysis settings are sent as **commands** (FR-26). The controls are drawn
  from the control stream's own schema; the client holds no bounds of its own.

### 8.2 Generic views for abstract measurements

- **FR-61** Any other field is rendered **by its SWE Common type alone**, with no knowledge
  of what it measures:

  | Schema type | Generic view |
  |---|---|
  | Quantity | Line chart labelled with the field's name and unit |
  | Quantity with an angular unit | Points, not joined lines, so a value wrapping past 360° never draws a false jump |
  | Category | Coloured band along the time axis, with a legend from the schema's allowed values |
  | Count | Step chart |
  | Anything else | A table of recent values |

- **FR-62** A generic view never carries code specific to one measurement. A new promoted
  product appears through these rules alone.

### 8.3 Polling

- **FR-63** Live data reaches the panels by **polling observations once per simulated
  second**, asking for `phenomenonTime` from the last reading received onwards. This is a recorded placeholder, not a tested design for live delivery.

---

## 9. Implementation direction

- **FR-64** Front end: **TypeScript and React**. Flowchart: **React Flow (xyflow)**.
  Charts: **ECharts**. Editor: **CodeMirror 6** with Python mode.
- **FR-65** Backend: **FastAPI** on Pyodide, implementing the Connected Systems subset
  directly. The **committed OpenAPI master is the source of truth**; a test asserts that
  the OpenAPI FastAPI serves matches it.
- **NFR-04** TypeScript types are generated from the masters; the Python backend validates
  against the same masters.

---

## 10. Guided tour

- **FR-66** A built-in **guided tour** walks through, in order:
  1. **The zones**: simulated, legacy, new build, third-party.
  2. **One reading end to end**: from a sensor as **L** into the logger store, through the
     store adapter and server, out as **O** to the display client.
  3. **The handshake**: restart client, then follow the **D** and **P** messages as the
     client configures itself.
  4. **A scientist's product promoted**: written in the workspace, registered as a process
     system, then picked up at the next client restart and drawn by a generic view.
  5. **A server restart**: the **H** answers in waiting mode, the changed instance
     identifier, and the client starting afresh.
  6. **Degraded mode**: switch off an essential field, restart the server, and see the
     warning popup and the disabled view control.
- **FR-67** The tour **highlights only**. Its text tells the viewer when to pause or press
  a restart button to follow a message.

---

## 11. Presentation, delivery and process

- **NFR-05** Designed for a **large presentation display** viewed from a distance.
- **NFR-06** **Light and document-like** style.
- **NFR-07** Builds to static assets on a public gh-pages site. Each visit starts a fresh
  seeded run; nothing persists between visits.
- **NFR-08** Pyodide and every Python package are served from the site itself, over HTTPS.
- **NFR-09** A startup time budget, including four-week pre-generation, is declared and
  measured.
- **PR-01** The repository is public and contains no material about any other project,
  customer or system, and no real place. A vocabulary gate enforces a privately held list
  of forbidden terms.
- **PR-02** Spec-kit carries: constitution, specify, plan, tasks, analyze, implement. ADRs
  record contested decisions, including the choice of Connected Systems; spikes write a
  dated `FINDING.md`.
- **PR-03** Every gate and every refusal test is watched failing before it is trusted.

---

## 12. Acceptance criteria

| ID | Test | Supports |
|---|---|---|
| AT-01 | Observations fetched through the seam match the manifest's ground truth at each time, while the store is growing | C1 |
| AT-02 | The same ASGI application passes the same contract suite in Pyodide behind the relay and in CPython under an ordinary ASGI server | C3 |
| AT-03 | Replacing the logger store with a second, differently awkward format changes the store adapter only, and AT-01 still passes | C1 |
| AT-04 | The change detector and clustering recover the manifest's fronts, air masses and reach boundaries with reported scores, without access to position | C3 |
| AT-05 | With four weeks of history, in the demonstrator and in CI, the declared queries of FR-29 meet their time budget, and rebuilding the index reproduces identical results | C1 |
| AT-06 | Removing any one essential source, or changing its type or unit, makes the client start in degraded mode: one warning popup naming exactly the unavailable sources, those views shown as unavailable with their controls disabled, all other views working. Removing an optional source produces no warning | C2 |
| AT-07 | A server whose profile claim is contradicted by its discovery is rejected by the client | C2 |
| AT-08 | A newly promoted product, of each schema type in FR-61, appears after restart client with its generic view and no new display code | C2 |
| AT-09 | Restart server: requests during waiting mode receive 503 with `Retry-After`; the instance identifier changes; every client clears its state and repeats the handshake; no records written during the restart are lost | C1, C2 |
| AT-10 | Every boundary in §4 that carries traffic produces captured messages, each with a letter from the key; system outputs are identical with capture on and off | Architecture view |
| AT-11 | Before play is pressed, and while paused, no component sends a message and the clock does not advance; on play, the run continues as if never paused | Architecture view |
| AT-12 | The OpenAPI served by FastAPI matches the committed master, and the conformance declaration matches the implemented subset | C1 |
| AT-13 | A broken workspace script leaves the server answering | C3 |
| AT-14 | A field toggle changes nothing until the next server start; after it, discovery offers exactly the configured fields, calculated fields whose inputs are off are absent, and switching a field back on restores its full history | C1, C2 |
| AT-16 | The CPython build of the server (AT-02) is browsed successfully by at least two independent Connected Systems clients, the OGC CSAPI Explorer and OSHConnect-Python: systems, datastreams, schemas and observations are all listed and read | C1 |
| AT-15 | With the server down, requests fail as network failures, the client shows the unreachable banner with stale data marked, and no sensor record is lost; on bringing it up, the client re-handshakes | C1, C2 |

---

## 13. Open questions

- **Name.** A coined working name with no association.
- **Connected Systems subset.** Spike 0 is done (`FINDING-2026-11-20-connected-systems.md`)
  and its corrections are applied. Still open: the exact conformance class URIs for the
  ADR, and whether an OGC executable test suite exists for Connected Systems.
- **Pub/sub.** Connected Systems Part 3 (MQTT and AMQP bindings) is unpublished. Polling
  stays; revisit when Part 3 is published.
- **System events.** Whether server starts and field changes are also published as
  ConfigurationChange system events.
- **Startup and memory.** Four weeks per sensor in Pyodide, plus an index and two
  workers, may exceed a reasonable startup time or a tab's memory. Fallback: ship the
  history as a pre-built file in the logger's own format.
- **Legible rate.** The fastest legible speed is set by measurement on the target display.
- **Promoted products' zone.** New build, or a zone of their own.
- **Second store format** for AT-03.

## 14. Deliberate exclusions from Version 3

- **Position, the map, and every analysis that needs position**: true wind, lag
  correction, pressure correction across locks, per-reach offsets, and attributing a
  change to place or weather.
- **OGC API-EDR and CoverageJSON.**
- **Evidence of low risk** (risk register on nodes, live test results, size of new-build
  code, share of off-the-shelf code). Deferred, not rejected.
- **Message popup extras, a message log, and a tour that drives the system.**
- **Discovery while running.** Sources change only at handshake.
- **Server-side sessions.** The server never tracks clients (FR-06).
- **Replay of recorded trips, push delivery, persistence and authentication.**
