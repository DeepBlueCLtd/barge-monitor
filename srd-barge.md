# Software Requirements Document
## Canal barge weather demonstrator, Version 4.2 (draft)

**Status:** Draft. 4.2 changes the design the demonstrator stands for: OpenSensorHub as
the data server (ADR 0005). The **architecture view shows it** (seven components, the data
server among the third-party libraries, a stand-in in its place). A **spike against a
stock OpenSensorHub** (finding of 2026-11-23) confirmed sensing, discovery and reading,
and found that **commands, restart recognition and replacing a result need redesign**; the
requirements below do not yet reflect that, and the store adapter as its module is untried
**Author:** Doc
**Working name:** to be chosen (§15). This document says *the demonstrator*.
**Supersedes:** SRD Version 3.3 and Annex A (Visual style). Both are folded in here;
nothing in them applies unless restated.

**Companion mockups (non-normative):** three static frames, one for each detail panel
(§9.4), plus one interactive frame:

| Mockup | Shows |
|---|---|
| SRD v4 mockup 1 | Display client selected: monitor, graphs, clusters, message strip |
| SRD v4 mockup 2 | Models selected: the reveal, core models and empty slots |
| SRD v4 mockup 3 | Data server selected: Connected Systems diagram and why it fits |
| Interactive display, store queries | All of the above, clickable |

The mockups fixed **layout, components and labels** for Version 4.0. They are drawn in a
plain style; the visual style is §11. They predate Version 4.1 (they show Model A and Model
B, a 1-hour default period, and no overview or failure demos). Where a mockup and this
document disagree, this document wins.

### Changes from Version 4.1

Shown on the architecture view; to be confirmed by a spike against a stock OpenSensorHub
(ADR 0005).

- The **data server is OpenSensorHub, off the shelf**. It moves to the **Third-party libraries** zone;
  the demonstrator's own server becomes a stand-in for it (§3, §6.3, FR-38a).
- **FastAPI is no longer a component.** The display client and the models talk to the
  data server directly (§3.1). Components fall from 8 to **7**.
- The **store adapter** becomes a module of the data server (FR-20a).
- Requirements that asked for behaviour beyond the standard are **relaxed** to what a
  stock server gives, each with a fallback: the profile link (FR-41), the instance
  identifier and waiting mode (FR-47, FR-48), 409 on creating what exists (FR-28), and
  the plain PUT (FR-28a).
- Already built in 4.2: the handshake is paced by its drawing (FR-42a), and a message
  selected while paused travels on at Play (VS-14).

### Changes from Version 4.0

- **Models use the Connected Systems HTTP interface**, like the display client: each
  creates its own process system, datastreams and control stream, publishes observations,
  reads its commands and reports their status with ordinary requests (§3.1, §6.3, §6.4).
  The internal interface between models and the data server is gone.
- **Models are named by function**: Data cleanse, **Summaries**, **Analysis**; the empty
  slots are **New model 1** and **New model 2** (FR-34).
- The detail panel opens on an **overview**: what is adopted rather than designed, what is
  written for this system, and what is **not in the demonstrator** (§9.4).
- **Failure demos** in the top bar run the control panel's scenarios in one click, each
  with what to watch for (§9.7).
- The Data server panel **no longer claims system events** (the server refuses them) and
  says what is not used (FR-72).
- **24 hours of history** are pre-loaded, not four weeks; the **stand-in is the default
  back end**; the default period is **1 minute** (FR-06b, FR-15, FR-54).
- Text meets the declared minimum sizes at 1920 × 1080; no requirement number appears on
  screen (VS-05).

### Changes from Version 3.3

- Components cut from 15 to **8**, in five zones: **World**, **Legacy**, **New build ·
  back end**, **Third-party libraries**, **New build · front end** (§3).
- The scientists' workspace and the analysis service become one component, **Models**:
  core models (Data cleanse, Summaries, Analysis) and empty slots, each model in its own
  worker (§6.4).
- **Store queries** become visible: a new message letter **S**, and the index moves to
  the store adapter (§6.2, §10.2).
- The seam relay is no longer drawn; it is an invisible transport (§2.1).
- The layout becomes a **stacked flowchart on the left** and a **detail panel on the
  right** that shows the selected component or message (§9).
- The display client becomes an **interactive monitor**: field chips, period presets, a
  clustering choice, three graphs and a cluster view (§8).
- **Summary datastreams** serve long periods (§6.3).
- **Value-add marking**: the display client and Models are revealed in gold with a
  glinting diamond when first clicked (§9.5, §11.6).
- The guided tour, docked panels and canal map are removed (§16).
- **Two back ends**: the Python back end, and a **JavaScript stand-in** for sites where
  WebAssembly is blocked. Both serve the same interface; the stand-in says what it does not
  prove (§2.3).
- **History is pre-calculated** at build time and shipped in the store's own format,
  replacing generation at startup (FR-15).

---

## 1. Purpose

The demonstrator is a **system and architecture demonstrator** set aboard an
**uncrewed electric cargo barge** (the **collection platform**) shuttling between two
wharves on a fictional canal, around the clock, for weeks at a time. It carries a
weather sensor at the **bow** and another at the **stern**, about twenty metres apart,
logging to an old data logger. It records **no position**. The demonstrator runs whole
in one browser session.

Its intention is to show that **the author's understanding of the software architecture
is complete**, and therefore that **the software need not be a risk to the project and
does not need a large contingency**. It does this by putting the architecture itself on
screen: every component, every interaction, every real message, each labelled with the
standard it meets, and by marking clearly **where the company adds value** and where it
relies on standards and off-the-shelf parts.

Its audience is **stakeholders deciding whether to adopt this architecture**. It makes
three claims:

1. **C1. A standards facade over an awkward legacy store works.** An OGC API – Connected
   Systems server can sit in front of a store it does not control, while that store
   grows, and serve a modern display and models without changing the store.
2. **C2. A client can configure itself from the server.** The display client discovers
   what is on offer through standard discovery, degrades clearly when an essential source
   is missing, and shows sources it has never seen without new code.
3. **C3. The value-add is isolated and extensible.** The company's own work (the display
   client and the models) sits on standards and third-party parts, and a new model can be
   added without touching anything else.

The claims are supported by acceptance tests (§14), never asserted by the display.

- **NFR-01 (One browser session.)** Every component runs in the browser. No step of
  building, testing or demonstrating requires a server, a container or a daemon.
- **NFR-02 (Two languages, by design.)** The front end is TypeScript; the back end and
  all models are Python running in Pyodide. (The stand-in of §2.3 is TypeScript: it is
  scaffolding, and the default only because it starts in seconds.)
- **NFR-03 (The back end is deployable.)** The Python back end is a standard ASGI
  application that runs unchanged under an ordinary ASGI server (AT-02).

### 1.1 What this is not

- **FR-01** The demonstrator models no real canal, boat, person or place. The canal, its
  towns, locks and tunnel are fictional. The weather is synthetic. The landing page says
  so plainly.
- It is not a mock of any real application's user interface. The display client's screen
  is deliberately small and generic (§8).

---

## 2. Runtime architecture

The browser holds four kinds of runtime:

| Runtime | Holds |
|---|---|
| Main thread | The display client and the demonstrator shell (TypeScript, React) |
| Back-end worker | World, logger store, store adapter, the data server's stand-in (Python, Pyodide) |
| One worker per model | Each model in Models (Python, Pyodide) |
| Service Worker | The seam relay |

### 2.1 The seam

- **FR-02** All traffic between the display client, the data server and the models
  crosses as **HTTP** and nowhere else. Requests use relative URLs, are intercepted by a
  **Service Worker relay**, and are passed to the worker that serves them. A model in its
  own worker makes its requests with `fetch`, exactly as the display client does.
- **FR-03** The relay is an **invisible transport**. It contains no application logic, is
  not a component, and is not drawn on the flowchart. Messages that pass through it are
  drawn as travelling directly between their real endpoints (for example, display client
  to data server).
- **FR-04** No client code or configuration carries an absolute URL. Pointing the
  display client at a real server is a change of base URL alone.
- **FR-05** Every shape crossing the seam is governed by a committed master under
  `contracts/`: OpenAPI for the HTTP interface, SWE Common 3.0 schemas for observation
  records, the declared profile (§7.1), and JSON Schema for anything else. Seam traffic
  is validated against the masters in tests.
- **FR-06** The data server is **stateless with respect to clients**. It holds no
  sessions, does not know which clients or models exist, and keeps no account of who has
  read what.

### 2.2 Honest ports

Genuine ports, each with more than one implementation planned: the **seam transport**,
the **clock**, the **RNG** and the **store adapter**. Nothing else is presented as
pluggable. (The stand-in back end of §2.3 swaps in behind the seam, but is demonstrator
scaffolding, not an architectural port.)

### 2.3 Two back ends

Some sites block WebAssembly, so Pyodide cannot run there. Those audiences still need to
see the architecture work.

The stand-in is **demonstrator scaffolding only**, like the simulated world. It is not
part of the architecture being demonstrated, has no counterpart in a developed system,
and says nothing about a developed system's effort or contingency.

- **FR-06a** The demonstrator has two back ends behind the same seam:
  - the **Python back end** (Pyodide): the real implementation, described throughout
    this document;
  - the **JavaScript stand-in**: a TypeScript implementation of the same back-end
    components (store adapter, the data server's stand-in, the core models) running in a
    Web Worker.
- **FR-06b** The **stand-in is the default**, because it starts in a few seconds. The URL
  parameter `?backend=python` runs the Python back end, and `?backend=standin` names the
  stand-in explicitly, so either can be rehearsed on any machine. Without WebAssembly only
  the stand-in can run.
- **FR-06j** In **both** back ends the data server is a **stand-in for OpenSensorHub**,
  which cannot run in a browser (FR-38a). Its card says so. What the demonstrator shows of
  the data server is its interface, not an implementation a developed system would keep.
- **FR-06c** The stand-in serves **exactly the same interface**: the same Connected Systems
  subset, the same discovery documents, profile, schemas, encodings, refusals, waiting
  mode and instance identifiers, validated against the **same committed masters** (FR-05).
  The display client cannot tell which back end it is talking to, and has no code that
  depends on it.
- **FR-06d** The stand-in reads the **same pre-calculated history** (FR-15) through its own
  store adapter, in the store's own format, and its world continues the run from the end
  of history on the same simulation clock.
- **FR-06e** The stand-in's core models produce the same kinds of output (cleaned values,
  derived values, change flags, correlation, clusters, summaries) by simpler methods. Their
  results are **marked as illustrative**, and their scores are labelled "stand-in" rather
  than presented as the real models' performance.
- **FR-06f** In stand-in mode the **empty-slot model editor is unavailable** (it needs
  Python). The Models panel says so, shows the steps for adding a model, and offers a link
  that reloads with the Python back end where WebAssembly is available.
- **FR-06g** Message capture, the flowchart, every letter, the detail panel, restarts,
  waiting mode, the control panel and degraded mode **all work identically** in stand-in
  mode. The architecture view is the point, and it is complete in both modes.
- **FR-06h** Stand-in mode is **visible, never hidden**:
  - the status box shows **Back end: JavaScript stand-in** (or **Python**);
  - the back-end components on the flowchart carry a small **"stand-in"** tag;
  - a one-line notice under the title says what the stand-in does and does not show:
    *"Running the JavaScript stand-in: the architecture, interface and messages are
    the real design; the models' results are illustrative."*
- **FR-06i** The claims hold differently in each mode, and the documentation says so:

  | Claim | Python back end | Stand-in |
  |---|---|---|
  | C1, facade over an awkward store | Shown and tested | Shown; tested only in Python |
  | C2, self-configuring client | Shown and tested | **Shown and tested**: the client is identical |
  | C3, value-add isolated and extensible | Shown and tested | Shown; live model editing only in Python |

---

## 3. Components and zones

Each component is one node on the flowchart and belongs to exactly one zone. The list
corresponds **one-to-one** with the real system's architecture, under neutral names.

| ID | Component | Zone | Value-add | Responsibility |
|---|---|---|---|---|
| C-01 | Collection platform | World | | The barge and its bow and stern sensors; stands in for the physical world |
| C-02 | Logger store | Legacy | | Deliberately awkward, append-only files (§6.1) |
| C-03 | Store adapter | New build · back end | | A module of the data server: the only reader of the store; holds the index; answers store queries |
| C-04 | Data server | Third-party libraries | | **OpenSensorHub**, off the shelf. OGC API – Connected Systems: discovery, datastreams, observations, commands |
| C-05 | Models | New build · back end | **★** | Core models and empty slots, each an OGC process system in its own worker, registered over the data server's HTTP interface |
| C-06 | *(withdrawn in 4.2: FastAPI)* | | | Not a component: the data server serves HTTP itself (ADR 0005) |
| C-07 | Scientific libraries | Third-party libraries | | numpy, scikit-learn |
| C-08 | Display client | New build · front end | **★** | The real system's screen: handshake, self-configuration, graphs and clusters |

The **demonstrator shell** (flowchart, controls, key, status, detail panel) frames
everything and is not a component.

### 3.1 Flows

| From | To | Messages |
|---|---|---|
| Collection platform | Logger store | L |
| Store adapter | Logger store | S (file read through the index) |
| Logger store | Store adapter | L |
| Data server | Store adapter | S (store query) |
| Store adapter | Data server | I |
| Models | Data server | Q, O, I (over HTTP: register, read, publish, look for commands; I is the referee) |
| Data server | Models | D, O, H, I (over HTTP) |
| Models | Scientific libraries | I (calls and results) |
| Display client | Data server | Q, K (over HTTP) |
| Data server | Display client | D, P, O, H (over HTTP) |

Models reach the data server **as the display client does**: with
ordinary HTTP requests to the Connected Systems interface. There is no other interface
between a model and the data server.

---

## 4. World: simulated platform, time and randomness

- **FR-07** The collection platform shuttles **continuously, day and night**, between
  two wharves on a canal declared as a **centreline with chainage**. It turns at each
  wharf after a declared dwell, stops at **locks**, and slows through **bridges and the
  tunnel**. Its movement is a pure function of the clock, the declared timetable and its
  seed stream. The timetable's period does not divide a day evenly, so the platform
  meets every part of the canal at every hour over a week.
- **FR-08** The timetable declares occasional **stoppages**.
- **FR-09** Two sensors, **bow** and **stern**, separated by a declared distance, each
  report seven parameters once per simulated second:

  | Parameter | Unit | Essential (§7.1) |
  |---|---|---|
  | Air temperature | °C | **Yes** |
  | Apparent wind speed | m s⁻¹ | **Yes** |
  | Relative humidity | % | Optional |
  | Barometric pressure | hPa | Optional |
  | Apparent wind direction | degrees relative to the bow | Optional |
  | Solar irradiance | W m⁻² | Optional |
  | Water temperature | °C | Optional |

- **FR-10** The platform carries **no position measurement**. Its position exists only
  in the simulated world and the manifest; nothing in the store records it and no model
  may use it.
- **FR-11** The canal passes through declared **reaches** with their own microclimates
  (open embankment, cutting, woodland, town, aqueduct, tunnel). The weather passes
  through **several air masses separated by fronts**, with a diurnal cycle. Readings
  carry declared noise and occasional spikes.
- **FR-12** Every run writes a **manifest** recording the canal, reaches, timetable, air
  masses, fronts, diurnal cycle, noise model, seeds and generator version. It is the
  ground truth that models are scored against.
- **FR-13** Every component, including the display client's polling and every model,
  reads time from the **simulation clock**. No host clock is used for any operational
  purpose.
- **FR-14** All randomness comes from named, seeded streams recorded in the manifest.
- **FR-15** **24 hours of history** (86 400 records per sensor) are **pre-calculated at
  build time** by the Python world generator, running the same sensor-to-store path under
  CPython with the run's seeds, and shipped as static files **in the store's own awkward
  format**, with the manifest. At startup either back end loads them as the store's
  contents, the models work through them over HTTP, and the live run continues from their
  end. Loading progress is shown honestly; the flowchart becomes available when it
  finishes. (Version 4.0 asked for four weeks. With models reading and publishing as JSON
  over HTTP, a day of history costs seconds to work through in a browser, so four weeks
  is not loaded; see §15.)
- **FR-15a** The build fails if regenerating the history from the recorded seeds does not
  reproduce the shipped files exactly. The live world (in either back end) continues from
  the recorded end state, so live readings join the history without a seam.

---

## 5. Message letters

| Letter | Meaning | Standard |
|---|---|---|
| Q | Connected Systems request | OGC API – Connected Systems |
| D | Discovery resource: landing page, conformance, system and datastream descriptions, schemas | OGC API – Connected Systems, Features, Common; SensorML; SWE Common 3.0 |
| O | Observations, read or published | SWE Common JSON (`application/swe+json`) |
| K | Command on a control stream | OGC API – Connected Systems Part 2 |
| P | Declared profile | JSON Schema |
| H | Plain HTTP status: 503 with `Retry-After` | RFC 9110 |
| S | Store query | Internal; no public standard |
| L | Legacy fixed-width record | The logger's own format |
| I | Internal typed object; also the demonstrator's referee (§6.4), which is scaffolding | Internal; no public standard |

- **FR-16** Messages that meet no public standard are named honestly as **S**, **L** or
  **I**, never presented as standards.

---

## 6. Functional requirements: the back end

### 6.1 Logger store

- **FR-17** The store is **deliberately awkward**: fixed-width text records, bow and stern
  in separate files rolling over daily, time in a non-standard unit and epoch, coded
  values for some fields, no index, and records appended while being read.
- **FR-18** The store is written only by the collection platform and read only by the
  store adapter. It is **independent of the data server** and keeps receiving records
  while the server is down or restarting.
- **FR-19** C1 is stated as *the facade works over an awkward store, to be confirmed
  against a real one*.

### 6.2 Store adapter

- **FR-20** The store adapter is the **only code that understands the store's format**.
- **FR-21** It **holds its own index** over the store (time to file and offset) and
  answers **store queries** (S) from the data server: which sensors, which fields, which
  period. It finds the records through the index and reads them from the files (an S
  message to the store, L records back).
- **FR-20a** The store adapter is a **module of the data server**, written against
  OpenSensorHub's extension interface. That interface, and so the adapter's language, is
  to be confirmed (ADR 0005). In the demonstrator it remains the Python and TypeScript
  adapter of Version 4.1.
- **FR-22** The store is never altered. The index is rebuilt from the store when lost,
  including on every restart, and a rebuilt index gives identical results.

### 6.3 Data server

The data server is **OpenSensorHub, used as shipped** (ADR 0005, superseding ADR 0001).
This section lists what the system **needs** of it: a subset of **OGC API – Connected
Systems Part 1 (Feature Resources)** and **Part 2 (Dynamic Data)**, from the Spike 0
finding (`FINDING-2026-11-20-connected-systems.md`). Nothing here is to be written; each
item is to be confirmed against a stock OpenSensorHub. The demonstrator's stand-in serves
exactly this subset.

- **FR-23** **Discovery**, including the prerequisites inherited from OGC API – Features
  Part 1 (Core) and OGC API – Common Part 1: landing page, conformance declaration, API
  definition, `/collections`, paging links, `limit` and `datetime`; and a link to the
  declared profile.
- **FR-24** **Systems**: the collection platform is a **Platform**; bow and stern are
  **Sensors**, as its subsystems; each model is `systemType` **System** with `assetType`
  **Process**. No system carries a location.
- **FR-25** **Datastreams**: one **record datastream per sensor**, whose SWE Common 3.0
  schema declares the seven parameters as Quantity fields with units and, for each, a
  **separate Category field carrying its QC flag** in the QARTOD vocabulary. Each model's
  outputs are datastreams of its own process system. Schemas are fetched from
  `/datastreams/{id}/schema?obsFormat=…`.
- **FR-26** **Observations**, filtered by `phenomenonTime` (and `resultTime`, including
  `latest`) with `limit` and paging; discovery as `application/json`, observations as
  `application/swe+json`. There is no per-field filter: a client fetches whole records
  and selects fields.
- **FR-27** **Control streams and commands** on each model, carrying its settings. Commands
  are POSTed to `/controlstreams/{id}/commands`; the bounds live in the control stream's
  schema; a command outside them is rejected (the stand-in answers **HTTP 400** naming the
  bound; what OpenSensorHub answers is to be confirmed). A model
  **polls** its control stream for pending commands (`statusCode=PENDING`) on the
  simulation clock, and reports each command's progress by POSTing to
  `/commands/{id}/status`. Polling is a recorded placeholder, as FR-63.
- **FR-28** **Registration**: a model registers itself over HTTP by creating a System
  under the Models system (`POST /systems/models/subsystems`), then its datastreams and
  control stream under that system, then publishing observations
  (`POST /datastreams/{id}/observations`), using ordinary resource creation. There is no
  registration-specific endpoint. A restarted model must find what it made: the stand-in answers
  **409** with its `Location` to creating what is already there; if OpenSensorHub does
  not, a model looks its resources up before creating them. A datastream whose
  schema changes is a new datastream under a new identifier (FR-51).
- **FR-28a** Nothing is replaced or deleted, with one declared exception that is **not
  Connected Systems**: a result that holds the latest run only is replaced with a plain
  HTTP `PUT` on the datastream's observations. If OpenSensorHub does not accept it, a run
  becomes one observation carrying arrays (§15). The stand-in refuses every other `PUT`,
  `PATCH` and `DELETE` by name; the system does not use them, whatever the server offers.
- **FR-29** **Summary datastreams**: for each sensor field, models publish **1-minute
  means** and **hourly means** as ordinary datastreams. Clients read raw records for
  periods of an hour or less, 1-minute means for 6 hours and a day, and hourly means for
  a week or more. Connected Systems has no standard aggregation; this is the declared
  workaround.
- **FR-30** Every unsupported resource, parameter or encoding is refused with the thing
  refused named. A query whose result would exceed a declared size is refused with the
  limit and how to narrow it. Nothing is silently truncated. The served conformance
  declaration matches the code.
- **FR-31** Declared queries (the last hour from each sensor; one field over the whole
  history from a summary datastream) meet a declared time budget, tested over one week of
  history.
- **FR-32** QC flags are computed on the way out and carried in the flag fields, never by
  altering stored records.

### 6.4 Models

- **FR-33** **Models** is a set of models, each an OGC **process system** running in **its
  own worker**. A failing, slow or broken model never stops the data server, the other
  models or the display client.
- **FR-34** The core models are named by what they do:
  - **Data cleanse**, which runs first: it flags and removes noise and publishes cleaned
    datastreams. **Every other model reads Data cleanse's output**, not the raw
    datastreams.
  - **Summaries**: the 1-minute and hourly summary datastreams (FR-29) and the derived
    values.
  - **Analysis**: change detection, correlation and clustering (with three selectable
    algorithms) on the fields and period the display client chooses.

  The split between Summaries and Analysis is recorded in ADR 0003.
- **FR-35** Each model reads observations from the data server, registers its own
  datastreams there (FR-28), and takes its settings as commands (FR-27), all through the
  HTTP interface. A model is written against a small library that makes these requests
  (`backend/models/csmodel.py`).
- **FR-36** **Empty slots** (New model 1, New model 2) show where new models go. Selecting
  an empty slot in the Models panel opens an **in-browser Python editor** (CodeMirror 6).
  Code written there runs in a new worker as a new model, using the scientific libraries,
  and registers over HTTP like any other. It appears in the display client at the
  client's next handshake.
- **FR-37** Every model result carries the settings and data range it was computed from.
  Change detection and clustering are **scored against the manifest**, and the score is
  published with them. Models never see the manifest or the position: a model asks the
  demonstrator's **referee** (`/demonstrator/referee`, the only code that reads the
  manifest) for a score. The referee is scaffolding and is named so in the interface
  definition.

### 6.5 Third-party libraries

- **FR-38** *(Replaced in 4.2.)* The **data server is OpenSensorHub**, adopted as shipped
  and not modified. The **committed OpenAPI master** states what this system needs of a
  Connected Systems server; the contract suite is the test that a server provides it.
- **FR-38a** In the demonstrator a **stand-in** takes OpenSensorHub's place: the subset of
  §6.3, on FastAPI in the Python back end and in TypeScript in the JavaScript stand-in.
  FastAPI is an internal detail of the stand-in and is not drawn. A test asserts that the
  stand-in serves the master.
- **FR-39** **Scientific libraries** (numpy and scikit-learn) are used by the models only.

---

## 7. Functional requirements: client and server lifecycle

### 7.1 Declared profile

- **FR-40** A committed **declared profile**, validated by JSON Schema, lists the
  **essential sources**: for each, the system, datastream, field, SWE Common type and
  unit. The essentials are bow and stern **air temperature** and **apparent wind speed**,
  and the core models' datastreams that the display client's views depend on.
- **FR-41** The profile is published with the data server: linked from its landing page
  if OpenSensorHub allows a link to be added, otherwise at a fixed path relative to the
  base URL (to be confirmed; the stand-in links it).
  The client checks both that the server **claims** the profile and that discovery
  **satisfies** it; a contradicted claim is an error.

### 7.2 Handshake and self-configuration

- **FR-42** The display client's **handshake** is standard discovery only: landing page,
  conformance, profile, systems, datastreams and schemas.
- **FR-42a** The handshake is made **one request at a time, at the pace it is drawn**: the
  client sends each handshake request only when the reply to the one before has been
  drawn arriving at it on the flowchart, so the architecture view shows the exchange in
  its true order. Handshake messages travel at 0.3 simulated seconds a hop. With capture
  off nothing is drawn and the client does not wait. Only the handshake is paced: polling
  (FR-63) and commands are not.
- **FR-43** From the handshake the client builds its **field list** (§8.2): every field of
  every datastream, essential and optional, including any new model's outputs.
- **FR-44** Discovery happens **only at handshake**. A client never adds or removes sources
  while running.
- **FR-45** If an essential source is **missing, or has the wrong type or unit**, the
  client starts in **degraded mode**: one warning after the handshake listing every
  unavailable essential source and why; each view that depends on it shown as
  **unavailable** (never an empty chart); the control for it disabled, naming the missing
  source on hover. A missing optional source produces no warning.

### 7.3 Restarts and waiting mode

- **FR-46** **Restart client** discards all display client state and repeats the
  handshake. The back end, history and models carry on.
- **FR-47** **Restart server** restarts the data server. While the store adapter rebuilds
  its index the server is **not ready**. The stand-in answers every request **HTTP 503
  with `Retry-After`** (waiting mode) and gives each start a fresh **instance identifier**,
  sent as the landing page's `ETag` and on every response. Neither is required by the
  standard: how a starting OpenSensorHub answers, and how its restart can be recognised,
  are to be confirmed (ADR 0005).
- **FR-48** A client receiving 503 waits for `Retry-After` and retries; a server that does
  not answer at all is treated as unreachable (FR-49). A client that **recognises a
  restart** clears its state and repeats the handshake: by the instance identifier where
  the server gives one, otherwise by the means the spike settles on. The server
  enforces nothing.

### 7.4 Control panel

The control panel belongs to the demonstrator shell.

- **FR-49** **Take server down / bring server up.** While down, the server does not answer:
  the relay returns a **network failure**. The client shows a "server unreachable" banner,
  keeps its last data marked as stale, and retries on the simulation clock.
- **FR-50** **Field toggles** switch fields on or off in **what the server publishes**:
  every raw parameter (both sensors together, essentials included), every model output,
  and three **extra fields**, off by default, that the client has never seen, one per
  generic view type: a Category, a Quantity and a Count. Stored history is unchanged.
- **FR-51** A toggle takes effect **only at the next server start**, shown as pending until
  then. A datastream whose schema changes is published under a **new identifier**.
- **FR-52** A model output whose inputs are switched off is not published.

---

## 8. Functional requirements: the display client

The display client is the real system's screen. In the demonstrator it appears inside a
**monitor frame** in the detail panel (§9.4). Everything inside the frame is the
delivered system; everything outside it is the demonstrator. The screen is deliberately
**small and generic**, so stakeholders judge the architecture, not a UI proposal.

### 8.1 Layout

From top to bottom inside the monitor: a status strip; the **field chips**; the **period
presets** and the **clustering** control; a row of **three graph components**; the
**cluster view** (mockup 1).

### 8.2 Controls

- **FR-53** **Fields**: chips built from the handshake (FR-43), **several selectable at
  once**. Optional fields are drawn dashed. Selecting or deselecting a field issues new
  observation requests (Q), which cause store queries (S) where raw records are needed.
- **FR-54** **Period presets**: 1 minute (the default, so each new second moves the
  views), 1 hour, 6 hours, a day, a week, 4 weeks. Each preset is one set of requests,
  reading raw records or a summary datastream as FR-29 sets out. A preset longer than the
  history shows what history there is.
- **FR-55** **Clustering**: a drop-down of three **unnamed algorithms** (Algorithm A, B
  and C). The clustering runs on the **selected fields**. Changing either sends a command
  (K) to the model that does the clustering.
- **FR-56** With no field selected, the graphs and cluster view say so and ask for a
  field; they are never shown empty without explanation.

### 8.3 Views

Each view is a framed component with a value-add diamond (§11.6).

- **FR-57** **Line plot**: the selected fields overlaid on a **normalised scale** (each
  field scaled to its range over the period), real values on hover, detected changes
  marked on the time axis.
- **FR-58** **Line plot with error bars**: the first selected field as means with ± 1
  standard deviation over intervals suited to the period.
- **FR-59** **Heat map**: the selected fields (rows) against time (columns), each row
  normalised.
- **FR-60** **Cluster view**: cluster assignments as a band along the time axis, a legend,
  the algorithm and fields used, and the score against ground truth.
- **FR-61** All three graphs and the cluster view **follow the current field and period
  selection**.
- **FR-62** A field the client has no specific knowledge of (an optional field or a new
  model's output) is shown **by its SWE Common type alone**: a Quantity as a line, an
  angular Quantity as points (never a false jump past 360°), a Category as a coloured
  band, a Count as steps. No measurement-specific code exists.

### 8.4 Live data

- **FR-63** Live data reaches the client by **polling**: raw records once per simulated
  second from the last reading received, and each summary datastream as often as it can
  change. This is a recorded placeholder: Connected Systems publish/subscribe (Part 3) is
  unpublished.

---

## 9. Functional requirements: the architecture view (demonstrator shell)

### 9.1 Layout

Mockups 1 to 3 show the arrangement:

- **Top bar**: title, a one-line subtitle explaining that components and messages can
  be clicked, and the controls (play/pause, speed, restart client, restart server,
  failure demos, control panel, overview). Nothing says which components are the
  value-add before the reveal (§9.5).
- **Left**: the **stacked flowchart**, layered top to bottom: front end, third-party
  libraries, back end, legacy, world. Data rises from the collection platform at the
  bottom to the display client at the top.
- **Below the flowchart**: **status** (simulation, speed, history, server state and
  instance, client state, essentials, optional sources) and the **message key**.
- **Right**: the **detail panel** (§9.4).

On the 1920 × 1080 target the flowchart is drawn at its designed size (840 px wide), so
its labels meet VS-05; the detail panel takes the rest.

### 9.2 Flowchart

- **FR-64** Drawn with **React Flow (xyflow)** from a **fixed layout** in a committed file.
  Zones are labelled, shaded bands. Third-party libraries form their **own band**,
  outside the back end.
- **FR-65** Every flow in §3.1 is drawn. A two-way exchange is two arrows on the thirds of
  the facing edges. Both HTTP flows (display client and data server; Models and data server) are
  labelled "HTTP".

### 9.3 Messages

- **FR-66** Messages are **real messages captured at every component boundary** in §3.1,
  including in-process calls. Capture uses one tap mechanism, never alters a message or
  either side's behaviour, and is tested with capture on and off.
- **FR-67** **Every** message is drawn as an icon bearing its letter, moving along its
  flow. None is sampled or merged.
- **FR-68** Clicking a message shows it in the detail panel's **message strip** (§9.4):
  its letter and name, whether it meets a public standard, its sender and receiver, and
  its contents in monospace.

### 9.4 Detail panel

- **FR-69** Clicking a component shows it in the detail panel; the selected component is
  ringed on the flowchart. The panel's × and the top bar's **Overview** button return it
  to its **opening state**, the overview.
- **FR-69a** The **overview** invites the viewer to click a component and shows three
  lists: **sensible defaults** (each decision the system did not have to make, the
  standard or off-the-shelf part adopted instead, and where it is seen); **written for
  this system** (store adapter, display client, models; the data server is among the
  defaults); and **not in this
  demonstrator** (what a developed system needs that is deliberately absent, by name,
  without estimates). It marks nothing as value-add (FR-74).
- **FR-70** **Display client** (mockup 1): the monitor frame holding the display client
  (§8), short notes beside it on the handshake, fields, period and clustering, and the
  **message strip** beneath it. Until a message is clicked, the strip shows the store
  query (S) built from the current selection, with the chain of messages that selection
  sends.
- **FR-71** **Models** (mockup 2): the Models component in gold with its description;
  beneath it, joined by lines, the models as cards in one row: **Data cleanse**,
  **Summaries**, **Analysis** (gold, registered) and **New model 1**, **New model 2**
  (dashed, empty slots). Each card has a diamond; each registered model shows a small
  view of what it does, labelled illustrative. Below, three steps for adding a model
  (write it, register it, see it) and a line stating that each model runs in its own
  worker and reaches the data server only over HTTP.
- **FR-72** **Data server** (mockup 3): that it is OpenSensorHub, off the shelf, with a
  stand-in in its place here; a diagram of the Connected Systems resources that
  describe this system: the collection platform (Platform) with bow and stern sensors
  (Sensor), each with its record datastream and observations; Models (Process) with each
  model's output datastreams and observations; and a row of the other things used
  (property definitions, control streams and commands, resource creation). Below it,
  **why it fits** in six points, the **gaps** (no standard aggregation; publish/subscribe
  unpublished; a plain HTTP PUT for latest-run results), and what is **not used** and
  refused by name (deployments, procedures, sampling features, system events and history,
  command feasibility, replacing and deleting). The panel claims nothing the server
  refuses.
- **FR-73** **Every other component** (collection platform, logger store, store adapter,
  scientific libraries) shows an explanation panel: what it does, which zone it
  belongs to and why, which letters it sends and receives, and live counters.

### 9.5 Value-add reveal

- **FR-74** At startup **every component looks the same**, the value-add ones included,
  and the detail panel is empty.
- **FR-75** The first time the **display client** or **Models** is clicked, it is
  **revealed**. Models is revealed by the click. The display client is revealed only when
  it is **showing its views and its detail panel is on screen**, both at once: never in
  the background, and not while it waits for Play, the models or its handshake, nor when
  it has rejected the server. So the presenter can show Models first and the display
  client later: its card turns gold, gains a ★ in its title, "our value-add" in its
  subtitle, and a glinting diamond in its top-right corner. It stays revealed until the
  page is reloaded or the client restarts.
- **FR-76** Inside the revealed panels, every value-add part carries its own diamond: the
  three graphs and the cluster view in the monitor; Models and each model card in the
  Models panel.

### 9.6 Time controls

- **FR-77** The simulation **starts off**. A single **play/pause** button starts and stops
  the **simulation clock**, which starts and stops the whole system. When paused, message
  icons freeze in place and remain clickable.
- **FR-78** A **speed control** offers ¼×, ½× and 1×, with **½× the default**. The fastest
  rate is the fastest at which every icon stays legible on the target display, verified
  by measurement; there is no faster mode.
- **FR-79** Restart client, restart server, the failure demos and the control panel work
  whether the simulation is playing or paused. A viewer's click is answered at once: the
  messages it causes wear a gold ring and set off ahead of any queue, and while the clock
  stands still the shell lets a pending command through to its model.

### 9.7 Failure demos

The failure demos belong to the demonstrator shell, like the control panel whose switches
they set.

- **FR-79a** A **Failure demos** menu in the top bar offers: the server goes down (then
  comes up); the server restarts; an essential source is missing; fields the client has
  never seen; a misconfigured server.
- **FR-79b** Choosing one sets the switches, starts the clock if it is stopped, shows the
  display client, and puts a **banner** under the title saying **what to watch for**, with
  the next step where there is one and **Put everything back**.
- **FR-79c** Put everything back restores every field to its default, an honest server and
  a running server.

---

## 10. Implementation direction

- **FR-80** Front end: **TypeScript and React**. Flowchart: **React Flow (xyflow)**.
  Charts: **ECharts**. The display client's panel layout: **react-grid-layout**. Model editor: **CodeMirror 6** with Python mode.
- **FR-81** Back end, in a developed system: **OpenSensorHub** with the store adapter as
  its module, and the models as separate processes. In the demonstrator: the stand-in of
  FR-38a on Pyodide. The committed OpenAPI master states what is needed of either.
- **NFR-04** TypeScript types are generated from the masters; the Python back end validates
  against the same masters.
- **NFR-05** Every model's worker loads Pyodide and the scientific libraries it needs; the
  startup budget (NFR-10) includes this.

---

## 11. Visual style

The style is a **light, hand-drawn architecture explainer**: ink on paper,
hand-lettered labels, sketch-edged boxes, coloured zones, with crisp, exact message
contents. The mockups are plain; they fix layout only.

### 11.1 Typography

- **VS-01** A legible, openly licensed **hand-lettered face** for component names, zone
  labels, panel titles, buttons and the key.
- **VS-02** A **monospace face** for message contents and code. Message contents are
  never shown in the hand-lettered face.
- **VS-03** Inside the monitor, the display client uses a **plain sans-serif**, so the real
  system's screen is visibly distinct from the demonstrator around it.
- **VS-04** All fonts are served from the site itself.
- **VS-05** Minimum sizes on the target display at native resolution: component names
  20 px, other labels 16 px, message letters 17 px, message contents 13 px. Sizes scale up
  together for the viewing distance; they never shrink to fit. Inside the monitor, the
  display client's own text (VS-03) is 13 px or larger. **No requirement number appears
  on screen.**

### 11.2 Palette

- **VS-06** **Paper and ink**: a warm off-white ground and a near-black ink.
- **VS-07** **Zones**, each a pale fill with a stronger outline of one hue:

  | Zone | Hue | Outline |
  |---|---|---|
  | World | warm grey | dashed |
  | Legacy | burnt orange | solid |
  | New build · back end | blue | solid |
  | Third-party libraries | violet | solid |
  | New build · front end | green | solid |

- **VS-08** **Message letters**: Q blue, D teal, O green, K purple, P navy, H red, S amber,
  L brown, I grey. One colour per letter, shared by icon, key and message strip.
- **VS-09** **Value-add gold**: a warm gold fill and a darker gold outline, used only for
  revealed value-add components and their parts.
- **VS-10** Colour never carries meaning alone: every message shows its letter, every zone
  its label, every value-add item its ★ and "our value-add".
- **VS-11** Every text and icon colour meets **4.5:1 contrast** (3:1 at 24 px and above).

### 11.3 Components and flows

- **VS-12** Each component is a card: white fill, ink outline with slightly uneven
  corners, its name and a one-line role. **Text labels only**; no illustrations.
- **VS-13** Flows are ink arrows with filled heads, horizontal or vertical segments only,
  never crossing a card. Protocol labels are used sparingly.
- **VS-14** A message is a circle bearing its letter. A **selected** message gains a tinted
  fill and a halo. One selected while playing stays where it was clicked, so it can be read;
  one selected while paused travels on at Play and is deselected when it arrives. A **failed** request (server down) stops at the boundary with its ring
  broken and a cross.

### 11.4 Sketch rendering

- **VS-15** Cards, zones and arrows are drawn with a **sketch renderer** (Rough.js, served
  from the site), **gently**: low roughness, single stroke, no hatching.
- **VS-16** **Every sketched shape is seeded** from its stable name, so it draws identically
  on every render, pause and restart.
- **VS-17** Without the renderer, the same shapes fall back to plain CSS outlines. The
  demonstrator never depends on the effect.

### 11.5 Detail panel

- **VS-18** The detail panel and message strip are **crisp, not sketched**: they carry the
  evidence.
- **VS-19** The **monitor frame** is a dark bezel with a stand, drawn plainly.
- **VS-20** Charts inside the monitor are drawn plainly by ECharts, with no sketch effect.

### 11.6 Motion and the diamond

- **VS-21** Only two things move: **messages travelling along flows**, at the speed the
  clock sets; and the **value-add diamonds**.
- **VS-22** The **diamond** is a small cut gem in the top-right corner of each value-add
  item. Every two seconds it **glints**: a four-pointed sparkle swells and turns, the top
  facet flashes, and a gold glow pulses. Diamonds on screen together are **staggered** so
  they twinkle in turn.
- **VS-23** Under the operating system's **reduced-motion** setting, diamonds show a still
  sparkle and messages move without easing. When the simulation is paused, messages stop
  but diamonds continue: they belong to the frame, not the system.

---

## 12. Delivery

- **NFR-06** Static assets on a public gh-pages site. Each visit starts a fresh seeded run;
  nothing persists between visits.
- **NFR-07** Pyodide and every Python package are served from the site itself, over HTTPS.
- **NFR-08** The target is a **large presentation display**; layout and sizes are verified
  on it.
- **NFR-09** The demonstrator runs on machines **with or without WebAssembly** (§2.3).
  Before a demonstration, the presentation machine is checked so the presenter knows which
  back end will run.
- **NFR-10** A startup time budget is declared and measured for **each back end**,
  including loading the pre-calculated history and, for the Python back end, the model
  workers. The history files' download size is declared and measured too.

## 13. Development process

- **PR-01** The repository is public and contains no material about any other project,
  customer or system, and no real place. A vocabulary gate enforces a privately held list
  of forbidden terms.
- **PR-02** Spec-kit carries: constitution, specify, plan, tasks, analyze, implement. ADRs
  record contested decisions, including the choice of data server, the split of work
  between Summaries and Analysis, and how models reach the data server.
- **PR-03** Every gate and every refusal test is watched failing before it is trusted.

### 13.1 Keeping the two back ends honest

- **PR-04** One **contract test suite** runs against both back ends through the seam. A
  change to the interface that passes in one and fails in the other fails the build.
- **PR-05** The stand-in has **no capability the Python back end lacks**. Anything shown
  only in the stand-in would misrepresent the real system.
- **PR-06** The Python back end is the reference. When the two disagree on anything other
  than the models' methods, the stand-in is wrong.

---

## 14. Acceptance criteria

| ID | Test | Supports |
|---|---|---|
| AT-01 | Observations fetched through the seam match the manifest at each time, while the store is growing | C1 |
| AT-02 | The same ASGI application passes the same contract suite in Pyodide behind the relay and in CPython under an ordinary ASGI server | C1 |
| AT-03 | Replacing the logger store with a second, differently awkward format changes the store adapter only: AT-01 still passes, and every response is identical to the first store's | C1 |
| AT-04 | With one week of history, the declared queries of FR-31 meet their time budget, and rebuilding the index gives identical results | C1 |
| AT-05 | The CPython build of the server is browsed by two independent Connected Systems clients (the OGC CSAPI Explorer and OSHConnect-Python): systems, datastreams, schemas and observations listed and read | C1 |
| AT-06 | The served OpenAPI matches the committed master, and the conformance declaration matches the implemented subset | C1 |
| AT-07 | Removing any essential source, or changing its type or unit, starts the client in degraded mode with one warning naming exactly those sources and their views disabled; removing an optional source gives no warning | C2 |
| AT-08 | A server whose profile claim is contradicted by discovery is rejected | C2 |
| AT-09 | Each extra field (Category, Quantity, Count) appears after restart client with its generic view and no new display code | C2 |
| AT-10 | Restart server: 503 with `Retry-After` while waiting; new instance identifier; every client resets and repeats the handshake; no records lost | C1, C2 |
| AT-11 | Server down: network failures, unreachable banner, stale data marked, no records lost; on bringing it up, the client re-handshakes | C1, C2 |
| AT-12 | A field toggle changes nothing until the next server start; afterwards discovery offers exactly the configured fields, and switching a field back on restores its full history | C1, C2 |
| AT-13 | A model written in an empty slot registers over HTTP, appears in the display client after restart client, and is drawn by its schema type | C3 |
| AT-14 | A model that raises errors or never returns leaves the data server, the other models and the display client running | C3 |
| AT-15 | Every model other than Data cleanse reads only Data cleanse's output datastreams | C3 |
| AT-16 | Change detection and clustering recover the manifest's fronts, air masses and reach boundaries with reported scores, without access to position | C3 |
| AT-17 | Each period preset reads the source FR-29 specifies; the S messages on the flowchart and in the message strip match the queries actually made | Architecture view |
| AT-18 | Every boundary in §3.1 that carries traffic produces captured messages with a letter from §5; outputs are identical with capture on and off | Architecture view |
| AT-19 | Before play is pressed, and while paused, no component sends a message and the clock does not advance | Architecture view |
| AT-20 | At startup no component is gold; clicking the display client or Models reveals it as FR-75 describes; no other component can be revealed | Architecture view |
| AT-21 | Rendering the flowchart twice, and after a client restart, gives identical sketched outlines | Visual style |
| AT-22 | An automated contrast check passes for every text and icon colour | Visual style |
| AT-23 | All fonts, the sketch renderer and Pyodide are fetched from the site's own origin | Delivery |
| AT-24 | The same contract suite passes against the Python back end and the stand-in: discovery, profile, schemas, encodings, refusals, waiting mode and instance identifiers | C2 |
| AT-25 | With WebAssembly disabled, the demonstrator starts the stand-in, shows "Back end: JavaScript stand-in", tags the back-end components, shows the notice, and marks model results as illustrative | Honesty |
| AT-26 | With WebAssembly disabled, every architecture-view test (AT-07 to AT-12, AT-17 to AT-20) passes unchanged | C2, architecture view |
| AT-27 | Both back ends read the same pre-calculated history files, and an observation query over the history returns identical values from each | C1 |
| AT-28 | Regenerating the history from the recorded seeds reproduces the shipped files exactly | Delivery |
| AT-29 | In both back ends, a system, a datastream and observations are created with ordinary HTTP requests and then served; creation outside a model's own system, and every replace or delete but the declared PUT, is refused by name | C3 |
| AT-30 | The detail panel opens on the overview (adopted, written, not here); the Data server panel claims nothing the server refuses; no requirement number appears on screen | Honesty |
| AT-32 | *(Run once as a spike, 2026-11-23: not passed.)* The contract suite, pointed at a stock OpenSensorHub, passes; each difference is recorded with the fallback taken (ADR 0005). The suite passed 0 of 15 unchanged and must first find resources by unique id, not by the stand-in's identifiers | C1 |
| AT-31 | Each failure demo shows what its banner says: unreachable and stale then a fresh handshake; degraded with the sources named; unseen fields drawn by type; a contradicted claim rejected; and Put everything back restores a configured client | C1, C2 |

Where each is tested: AT-01, AT-03, AT-04, AT-07 (server side), AT-10 to AT-16, AT-18, AT-19
and AT-28 in `backend/tests`; AT-02, AT-06, AT-24, AT-27 and AT-29 by the contract suite
against both back ends; AT-05 by `backend/independent` (OSHConnect; the CSAPI Explorer is a
web tool and is checked by hand); AT-07 to AT-11, AT-13, AT-17, AT-19 to AT-23, AT-25, AT-30
and AT-31 in `web/e2e`. AT-26 is covered for AT-07 to AT-11, which run in the stand-in.

---

## 15. Open questions

- **Name.** A coined working name with no association.
- **History length.** Models read and publish history as SWE Common JSON over HTTP, which
  costs seconds per day of 1 Hz data in a browser. 24 hours is loaded. Four weeks would
  need a compact encoding for bulk reads (Connected Systems offers SWE Common binary), or
  models that summarise without republishing every cleaned reading.
- **Retention.** The server keeps everything models publish. Data cleanse's 1 s output for
  a long history would need a retention policy that a stateless server can apply.
- **Latest-run results.** Analysis replaces its previous run with a plain HTTP PUT.
  The standard-only alternative is one observation per run, carrying arrays.
- **Start-up.** Measured figures for each back end are in the findings; to confirm on the
  presentation machine.
- **Memory.** An index, a back-end worker and one Pyodide worker per model may press on a
  tab's memory. Measure in the Python back end.
- **Legible rate.** The fastest legible speed, measured on the target display; it may be
  below 1×.
- **Pub/sub.** Revisit polling, by the display client and by the models, when Connected
  Systems Part 3 is published.
- **OpenSensorHub.** The spike of 2026-11-23 leaves these open:
  - **Commands.** A model cannot poll for them (FR-27): OpenSensorHub pushes a command to
    a receiver and drops it without one, keeps the sender waiting 5 s, and does not
    enforce the schema's bounds. FR-27, FR-55 and the exclusion of push delivery need
    revising.
  - **Latest-run results.** No `PUT` (FR-28a), and an array inside a record was refused
    as the stand-in encodes it.
  - **The store adapter** as a module: untried, and loading over HTTP is one observation
    per request.
  - **The stand-in** now differs from the server it stands for (identifiers, missing
    values as `"NaN"`, one observation per request, HTML refusals, no 503, no instance
    identifier). Either it follows OpenSensorHub, or FR-06c is weakened.
  - **The contract suite** must be made server-neutral before AT-32 can be passed.
- **Conformance testing.** The conformance class identifiers claimed are those of the
  published Parts 1 and 2. Whether an OGC test suite for Connected Systems exists is still
  to be checked; one independent client (OSHConnect) reports two differences (decisions
  D-31, D-32).

## 16. Deliberate exclusions from Version 4

- **Removed since 3.3**: the guided tour, the docked panels, the canal map, the seam relay
  as a drawn component, the separate scientists' workspace, the message popup (replaced by
  the message strip), the demonstrator-shell node on the flowchart.
- **Position**, and every model that needs it.
- **Estimates and measures of risk** on screen (effort, a risk register, live test
  results, code size). The overview names what is adopted, written and absent; it puts no
  numbers on them. Deferred, not rejected.
- **Replacing and deleting resources**, apart from the one declared PUT (FR-28a).
- **Discovery while running**, **server-side sessions**, **replay**, **push delivery**,
  **persistence** and **authentication**.
