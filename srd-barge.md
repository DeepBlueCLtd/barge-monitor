# Software Requirements Document
## Canal barge weather demonstrator, Version 4.7 (draft)

**Status:** Draft. Builds on Version 4.6, with the decisions of the owner's review of the
first 4.6 build (2026-11-26). That build was withdrawn; what it did is recorded in
`docs/software-changes-v4.6-branch.md`. Version 4.6 added an **opening act** for
non-engineers: the demonstrator opens with the data server shown as subsystem components we
would have to build, and one click adopts OpenSensorHub (§9.8).
**Author:** Doc
**Working name:** to be chosen (§15). This document says *the demonstrator*.
**Supersedes:** Version 4.6 and, through it, every earlier version and Annex A. Earlier
change lists are below. Requirements marked **(4.7)** are new or changed here; **(4.6)**,
**(4.5)**, **(4.4)** and **(4.3)** mark those changed in those versions and unchanged since.

### Changes from Version 4.6 (the owner's review, 2026-11-26)

- **No access gateway, for now (4.7).** Clients talk to OpenSensorHub directly.
  Restricted resources are **listed in discovery and refused with 403**, as stock
  OpenSensorHub does, instead of being hidden (FR-93, FR-06c). C6 is restated. Hiding them is
  an open question the owner is taking up with the OpenSensorHub team (§15). **A stream's title
  may be known, not its contents** (the owner, 2026-11-27, D-351): a restricted datastream is
  listed and described, its schema included; its observations, and a restricted control stream's
  commands and status, are refused.
- **Replay moves into the display client (4.7).** There is no replay controller on the
  server. **Models process each dataset as soon as it is imported**; each display client keeps
  its own replay clock and reveals data and results up to it (§8.6). C4 is restated; model
  rate bounds are withdrawn.
- **No Freeze (4.7).** Play and Pause cover it (FR-92 withdrawn).
- **The opening's wording (4.7).** Written ourselves, the data server is **a range of subsystem
  components to develop**, among them those drawn; not a fixed count (FR-120).
- **Popups in the display client (4.7).** The dataset list becomes a popup **Dataset
  selector**, and data of interest a popup called **Favourites**, opened by a star button;
  both free screen space (§8.1, FR-103, §8.5).
- **Startup says why (4.7).** A control that cannot act yet says why, and a startup that
  stalls says where (FR-125a, NFR-10a). The first build stalled at the seam relay's start,
  with every control disabled and no explanation.

### Changes from Version 4.5

- **An adoption opening (4.6)**, entered with the `hand-made` flag in the URL's query
  (FR-119). The data server starts out as **eight subsystems** in the back end, drawn as
  equals of the CSV importer, replay controller and Models (FR-120).
- **Nothing is gold, and nothing runs, before adoption (4.6).** The opening comes before
  the value-add reveal. The top bar's controls are hidden and no message is sent (FR-121,
  FR-122).
- **Adopt OpenSensorHub (4.6)** merges the eight into one data server in the third-party
  zone, shows what that saves, and hands over to the normal startup (FR-123 to FR-126).
- **Savings only (4.6):** the opening shows no costs (§16).
- **Settled in review (4.6):**
  - the opening starts nothing until Adopt (FR-122);
  - the opening's flows are mapped to the subsystems, with the lines between them (FR-120a);
  - pushed commands travel as a stream through the relay (FR-02);
  - Mission A is imported silently at every load (FR-15);
  - a full handshake follows each import (FR-44);
  - the profile is a template (FR-40);
  - the latest run is shown on return to a dataset (FR-35);
  - charts stay, and D-53 is superseded (FR-80).

### Changes from Version 4.4

- **CO₂ is measured (4.5)** by both sensors, in ppm, and is an **optional, restricted**
  source (FR-09).
- **Restriction is by resource, never by field (4.5).** CO₂ lives in its own **CO₂ analyser
  subsystems** and datastreams, never inside the weather record, so the server can
  permit or deny it whole (FR-24, FR-25, FR-21c).
- **Anything derived from CO₂ is restricted (4.5)**, including the record of an analysis
  run whose settings name CO₂ (FR-112).
- **Restricted resources are hidden, not merely refused (4.5)**: a user without access
  cannot discover that they exist (FR-93).
- **Three roles (4.5)**: Owner, Viewer with emissions, Viewer (weather only). The owner
  manages accounts through **OpenSensorHub's own administration** for now; a screen of
  ours follows only on a stated trigger (§7.6).
- **New claim C6 (4.5)**: access to sensitive data is restricted per user, with no
  restriction-specific code in the display client.
- **Two demo accounts (4.5)**, the owner and a friend, and a new failure demo (§9.7).

**Companion mockups (non-normative):** SRD v4 mockups 1 to 3, the interactive frame, and
the two OpenSensorHub savings frames. The savings frames predate 4.6. In them the eight
subsystems sit inside a "built by us" box and the importer and Models are gold, and 4.6
forbids both. Where a mockup and this document disagree, this document wins.

**Companion documents (4.7):** the contract is `docs/v4-interfaces.md`, the plan
`docs/plan-v4.7.md`, and the decisions `docs/decisions-log.md` (D-220 to D-232). ADR 0009
(replay in the display client) and ADR 0010 (access control by OpenSensorHub) supersede
ADRs 0006 and 0008.

### Changes from Version 4.3

- **CSV files in a data folder (4.4).** The legacy archive becomes a **data folder** of CSV
  files that scientists copy in (§6.1). Its format is awkward CSV, not fixed-width text.
- **Import, not serving in place (4.4).** A **CSV importer**, a module of the data server,
  imports each chosen file **in bulk** into the server's own store and keeps it (§6.2).
  The store adapter, its index and the store query at read time are withdrawn.
- **Datastreams per file (4.4).** Each imported file has its own datastreams, and every
  model's outputs are per file, so files never mix, even when their times overlap (§6.3).
- **One current dataset (4.4).** The analyst chooses one dataset at a time with a **dataset
  picker**. The replay controller holds the current dataset (§6.6, §8.2).
- **Data of interest (4.4).** An analyst can save a named record of a set of data and use
  it to regenerate any view, or to compare two records on elapsed time (§6.7, §8.5).
- **Authentication and screen lock (4.4).** Every request needs credentials; the display
  client shows a login screen and locks after inactivity; nothing sensitive is kept in the
  browser (§7.5).
- **Reset instance (4.4).** Clears the server's whole store at once; nothing is ever deleted
  record by record (FR-50a).

---

## 1. Purpose

The demonstrator is a **system and architecture demonstrator** for an environment in
which analysts **import, replay and investigate recorded data** from a collection
platform: an uncrewed electric cargo barge that shuttled between two wharves on a
fictional canal, with a weather sensor at the **bow** and another at the **stern**. Its
recordings arrive as **CSV files**, a few days at a time. Nothing is live, and nothing
records position. The demonstrator runs whole in one browser session.

Its intention is to show that **the author's understanding of the software architecture
is complete**, and therefore that **the software need not be a risk to the project and
does not need a large contingency**. It puts the architecture on screen: every component,
every interaction, every real message, each labelled with the standard it meets, and it
marks clearly **where the company adds value** and where it relies on standards and
off-the-shelf parts.

Its audience is **stakeholders deciding whether to adopt this architecture**. It makes
six claims:

1. **C1. A standards facade over awkward legacy files works (4.4).** Legacy CSV files are
   imported into an off-the-shelf OGC API – Connected Systems server, each file kept
   separate and traceable, and the files themselves never altered.
2. **C2. A client can configure itself from the server.** The display client discovers
   what is on offer through standard discovery, degrades clearly when an essential source
   is missing, and shows sources it has never seen without new code.
3. **C3. The value-add is isolated and extensible.** The company's own work (the display
   client and the models) sits on standards and third-party parts, and a new model can be
   added without touching anything else.
4. **C4. Recorded data can be replayed at any rate (4.7).** Each imported dataset is
   processed once by the models, as soon as it is imported, and the display client replays
   it and its results at any rate on its own clock. Results never depend on how, or how
   fast, anyone replays.
5. **C5. The data is protected at the screen (4.4).** Nothing is served or shown without
   logging in, an unattended screen locks, and the browser keeps nothing sensitive.
6. **C6. Sensitive data is restricted per user (4.7).** CO₂ and everything derived from it
   can be read only by users the owner permits. Anyone else is refused (403) the data: they
   can see that such sources exist, their titles and schemas included, but never their contents
   (§15; D-351). The display client has no restriction-specific code: it offers only what it can
   read.

The claims are supported by acceptance tests (§14), never asserted by the display.

The recordings arrive as CSV files and now include **CO₂** from both sensors (4.5).

- **NFR-01 (One browser session.)** Every component runs in the browser.
- **NFR-02 (Two languages, by design.)** TypeScript front end; Python back end and models
  in Pyodide. The stand-in of §2.3 is TypeScript scaffolding.
- **NFR-03 (The back end is deployable.)** The Python back end runs unchanged under an
  ordinary ASGI server (AT-02).

### 1.1 What this is not

- **FR-01** The demonstrator models no real canal, boat, person or place. The recordings
  are synthetic. The landing page says so plainly.
- It is not a mock of any real application's user interface. The display client's screen
  is deliberately small and generic (§8).

---

## 2. Runtime architecture

| Runtime | Holds |
|---|---|
| Main thread | The display client and the demonstrator shell (TypeScript, React) |
| Back-end worker | Data folder, CSV importer, the data server's stand-in (Python, Pyodide) |
| One worker per model | Each model in Models (Python, Pyodide) |
| Service Worker | The seam relay |

### 2.1 The seam

- **FR-02 (4.7)** All traffic between the display client, the data server, the importer
  and the models crosses as **HTTP**, or as a **pushed stream** for commands,
  and nowhere else, through a **Service Worker relay**. **Every request and every push
  subscription carries credentials (4.4)** (§7.5).
- **FR-02a (4.6)** A Service Worker cannot carry a WebSocket. So in the demonstrator, a
  push subscription is **one long streaming response** through the relay, with one
  command per line. It is wrapped in a class with WebSocket's interface, and drawn as
  "push". In a developed system it is OpenSensorHub's WebSocket.
- **FR-03** The relay is an **invisible transport**, not a component, and not drawn.
- **FR-04** No client code or configuration carries an absolute URL.
- **FR-05** Every shape crossing the seam is governed by a committed master under
  `contracts/`: an OpenAPI document of what this system needs of a Connected Systems
  server, SWE Common 3.0 schemas, the declared profile, the data-of-interest record
  (§6.7), and JSON Schema for anything else.
- **FR-06** The data server is **stateless with respect to clients** beyond
  authentication.

### 2.2 Honest ports

The **seam transport**, the display client's **replay clock** (4.7), the **RNG** and the
**CSV importer** (4.4). Nothing else is presented as pluggable.

### 2.3 Two back ends

The stand-in is **demonstrator scaffolding only**: it has no counterpart in a developed
system and says nothing about its effort or contingency.

- **FR-06a (4.7)** Two back ends behind the same seam: the **Python back end** and the
  **JavaScript stand-in**, each with its own importer, data-server stand-in and core
  models.
- **FR-06b** The stand-in is the default; `?backend=python` and `?backend=standin` choose.
- **FR-06j** In both back ends the data server is a **stand-in for OpenSensorHub**, and its
  card says so.
- **FR-06c (4.4)** Both stand-ins **behave as a stock OpenSensorHub does** wherever the
  system relies on it (as recorded by the spike, and for authentication as confirmed by
  the next spike, §15): opaque identifiers; `201` with the existing `Location` on creating
  what exists; missing values as `"NaN"`; commands pushed to a subscribed receiver; no
  instance identifier; connections refused while starting; **`401` without valid
  credentials**; **restricted resources listed in discovery and refused with 403 to users
  without permission (4.7)**.
- **FR-06d (4.4)** Both back ends read the **same data folder**.
- **FR-06e** The stand-in's models are simpler, **marked illustrative** and unscored.
- **FR-06f** In stand-in mode the model editor is unavailable, with a link to Python.
- **FR-06g** The architecture view, import, replay, data of interest, authentication,
  restarts, the control panel and degraded mode **work identically** in both back ends.
- **FR-06h** Stand-in mode is visible: status, "stand-in" tags, and a one-line notice.
- **FR-06i** Claims by mode:

  | Claim | Python back end | Stand-in |
  |---|---|---|
  | C1 | Shown and tested | Shown; tested only in Python |
  | C2 | Shown and tested | Shown and tested |
  | C3 | Shown and tested | Shown; live model editing only in Python |
  | C4 | Shown and tested | Shown and tested |
  | C5 | Shown and tested | Shown and tested |
  | C6 | Shown and tested | Shown and tested |

---

## 3. Components and zones (4.4)

| ID | Component | Zone | Value-add | Responsibility |
|---|---|---|---|---|
| C-02 | Data folder | Legacy | | CSV files that scientists copy in; never altered by the system (§6.1) |
| C-03 | CSV importer | New build · back end | | A module of the data server: the only code that understands the CSV files; lists the folder; imports a file in bulk (§6.2) |
| C-04 | Data server | Third-party libraries | | **OpenSensorHub**, off the shelf: authentication, discovery, datastreams, observations, control streams, command delivery, storage |
| C-05 | Models | New build · back end | **★** | Core models and empty slots, each an OGC process system in its own worker |
| C-07 | Scientific libraries | Third-party libraries | | numpy, scikit-learn |
| C-08 | Display client | New build · front end | **★** | The real system's screen: login, dataset selector, its own replay clock, views, Favourites (data of interest) |

Withdrawn: **C-01 Collection platform** (4.3), **C-06 FastAPI** (4.2), in 4.4 the
**legacy archive** and **store adapter** of 4.3, replaced by the data folder and the CSV
importer, and in 4.7 **C-09 Replay controller** (replay is the display client's, §8.6) and
the **access gateway** of the first 4.6 build. The **demonstrator shell** frames everything and is not a component.

### 3.1 Flows (4.7)

| From | To | Messages |
|---|---|---|
| CSV importer | Data folder | S (list the folder; read a file) |
| Data folder | CSV importer | L (the listing; CSV rows) |
| CSV importer | Data server | I (bulk write into the store, inside the server; and the catalogue) |
| Data server | CSV importer | K (pushed: import) |
| Display client | Data server | Q, K (HTTP) |
| Data server | Display client | D, P, O, H (HTTP) |
| Data server | Models | D, O, H (HTTP); K (pushed) |
| Models | Data server | Q, O, I (HTTP; I is the referee) |
| Models | Scientific libraries | I (calls and results) |

---

## 4. The recordings

- **FR-07 (4.4)** The recordings were made by the collection platform as it shuttled
  between two wharves, through **reaches** with their own microclimates and weather
  passing through **air masses separated by fronts**, with a diurnal cycle, noise and
  spikes. Each **CSV file** holds one recording: a contiguous span of time from both
  sensors.
- **FR-09** Two sensors, **bow** and **stern**, each recorded seven parameters once a
  second (air temperature and apparent wind speed **essential**; relative humidity,
  pressure, apparent wind direction, solar irradiance and water temperature optional).
- **FR-09a (4.5)** Each sensor package also recorded **CO₂** once a second, in **ppm**, with
  its own QC flag. CO₂ is **optional** and **restricted** (FR-93, FR-112). In the
  recordings it rises with engine load: higher when the platform is under way, lower at
  the wharves and locks.
- **FR-10** **No position** was recorded, and no model may use it.
- **FR-12** A **manifest** per file records its ground truth, read only by the referee.
- **FR-14** All randomness comes from named, seeded streams.
- **FR-15 (4.4)** The demonstrator ships a **data folder** generated at build time:
  - **Mission A**, 24 hours, **already imported** at startup, so replay can begin at once.
    Since nothing persists between visits, it is imported **silently on every load
    (4.6)**: before the server takes requests, without being drawn, and the importer's
    panel says so. After Reset instance it stays gone until the page is reloaded;
  - **Mission B**, 24 hours, not yet imported;
  - **Mission B (re-export)**, which overlaps Mission B in time and differs in a few
    readings, not yet imported, to show that overlapping files are kept apart;
  - **Mission C**, 12 hours, missing the stern's wind speed column, to show a dataset
    opening in degraded mode.

  Every file includes the two CO₂ columns (4.5).
- **FR-15a** The build fails if regenerating the files from their seeds does not reproduce
  them exactly.

---

## 5. Message letters (4.4)

| Letter | Meaning | Standard |
|---|---|---|
| Q | Connected Systems request | OGC API – Connected Systems |
| D | Discovery resource | OGC API – Connected Systems, Features, Common; SensorML; SWE Common 3.0 |
| O | Observations, read or published | SWE Common JSON |
| K | Command on a control stream, sent or pushed | OGC API – Connected Systems Part 2 |
| P | Declared profile | JSON Schema |
| H | HTTP status of 400 or above, including **401** | RFC 9110 |
| S | File request: list the data folder, or read a file | Internal; no public standard |
| L | Legacy CSV: the folder listing or the file's rows | The files' own format |
| I | Internal object; also the referee, which is scaffolding | Internal; no public standard |

- **FR-16** Messages that meet no public standard are named honestly as **S**, **L** or
  **I**.
- **FR-16a (4.4)** **Credentials are never shown.** Every captured message shows its
  `Authorization` header, and any password field, as `****`.

---

## 6. Functional requirements: the back end

### 6.1 Data folder (4.4)

- **FR-17 (4.4)** The data folder holds CSV files that scientists copy in. The files are
  **deliberately awkward CSV**: an unusual time format and epoch, units in the column
  headings, coded missing values, and the two sensors as separate column groups in one
  file.
- **FR-17a (4.4)** The system **never writes, renames or deletes** anything in the data
  folder.
- **FR-19** C1 is stated as *the import works for awkward CSV, to be confirmed against the
  client's real files*.

### 6.2 CSV importer (4.4)

- **FR-20 (4.4)** The importer is the **only code that understands the CSV format**.
- **FR-20a (4.4)** In a developed system the importer is a **module of the data server**,
  written against OpenSensorHub's extension interface, and writes **in bulk** into the
  server's own store. Importing over HTTP (one observation per request, about 450 a second
  in the spike: roughly 20 minutes for three days of two 1 Hz sensors) is not acceptable.
  Whether a module can write in bulk is the **next spike** (§15).
- **FR-20b (4.4)** The importer registers as a Connected Systems **System** with:
  - an **archive catalogue** datastream: one observation per file in the folder, giving
    the file's **name, size, modified date and content hash**, its **time span** and
    **record count** once read, and its **status**: *not imported*, *importing* (with
    percentage), *imported*, *changed since import*, or *superseded*;
  - a **control stream** `import`, taking a file name.
- **FR-20c (4.4)** The importer lists the folder when the server starts and again when
  asked (`rescan`), and publishes a new catalogue observation for any file whose status
  changes. The catalogue is append-only: its latest observation per file is the file's
  current status.
- **FR-21 (4.4)** Importing a file creates **its own datastreams** (FR-25) and writes every
  row into them, mapping the file's columns to the declared fields and units. A column
  missing from a file leaves its field absent from that file's datastreams.
- **FR-21a (4.4)** A file whose size, modified date or content hash differ from a version
  already imported is imported **as a new dataset**. The earlier one is marked
  *superseded*, is kept, and stays openable.
- **FR-21b (4.4)** Files whose time spans **overlap** are imported and kept **separately**,
  each in its own datastreams. They never mix.
- **FR-21c (4.5)** The importer writes the **CO₂ columns into the CO₂ datastreams** (FR-25)
  and never into the weather datastreams. The importer's service account has access to
  CO₂. The archive catalogue names files and spans only, never their columns, so it
  reveals nothing about CO₂.
- **FR-22** Nothing in a file is altered, and nothing imported is altered or deleted, except
  by Reset instance (FR-50a).

### 6.3 Data server

The data server is **OpenSensorHub, used as shipped** (ADR 0005). This section lists what
the system **needs** of it. ✓ marks what the spike confirmed.

- **FR-23** **Discovery** ✓. The system does not rely on a served OpenAPI document.
- **FR-24 (4.7)** **Systems** ✓: the collection platform as a **Platform** with bow and
  stern **Sensors**, and under each sensor a **CO₂ analyser** subsystem (Sensor); the
  importer as a System (`assetType` Equipment); each model (`assetType` Process), with a **restricted** subsystem for its
  CO₂-derived outputs (FR-112); and one **workspace** system per user (FR-95).
- **FR-25 (4.4)** **Datastreams per dataset** ✓. Each imported file is a **dataset** with a
  dataset id derived from its name and content hash. Its datastreams are the bow and
  stern record datastreams, output name `weather · <dataset id>`, each parameter a
  Quantity with its unit and a Category QC flag referred to by `quality`. Every model's
  outputs are per dataset too (for example `cleaned · <dataset id>`). **CO₂ is never a
  field of the weather record (4.5)**: each CO₂ analyser has its own datastream,
  `co2 · <dataset id>`, with CO₂ in ppm and its QC flag.
- **FR-26 (4.3)** **Observations** ✓ by `phenomenonTime` and `resultTime=latest`, with
  `f=application/swe+json`, paging by `offset`, missing values as `"NaN"`.
- **FR-27 (4.7)** **Commands are pushed** to each receiver (the importer and each model), which holds a subscription to its control stream and
  subscribes before declaring itself ready. A command carries every parameter. The
  **receiver validates** bounds and reports `REJECTED` naming the bound. The **sender
  never waits** on its `POST`.
- **FR-28** **Registration** ✓ with ordinary resource creation; `201` with the existing
  `Location` is success.
- **FR-28a (4.7)** **Nothing is replaced or deleted.** Results are appended under a new
  `run_id`. Stock OpenSensorHub lets an account delete what it created (the delete probe of
  2026-11-26), so the delivered configuration must forbid replacing and deleting (§15).
- **FR-29** **Summary datastreams** per dataset: 1-minute and hourly minimum, mean and
  maximum.
- **FR-30 (4.3)** The system does not rely on refusal bodies or enforced size limits.
- **FR-31** Declared queries (the last hour before a client's replay time; one field over a
  whole dataset from a summary) meet a declared time budget.
- **FR-32** QC flags are computed on import, never by altering the files.
- **FR-93 (4.7)** **Authentication and permissions**, required of the server, which clients
  reach directly; there is no gateway of ours in front of it:
  - every request, discovery included, and every push subscription (FR-02a) needs **valid credentials**;
    without them the answer is **401** and nothing is served;
  - permissions are granted **per system** and **inherited by its datastreams and control
    streams**. Nothing in this system needs permission per field;
  - a user **without permission** for a system is **refused (403)** its **contents**: its
    datastreams' observations, and its control streams' commands and their status. **Its
    description is not restricted (4.7, D-351)**: it is listed in discovery, as stock
    OpenSensorHub does, and the system, its datastreams with their titles and schemas, and its
    control streams can be read. A stream's title may be known, never its contents. Hiding it
    from discovery is wanted, and is an open question (§15);
  - **users** may read what their role permits, send commands to the importer and the
    models, and create and append only under **their own workspace**;
  - each **model** and the **importer** has its own **service account**, allowed to create
    and append only under its own systems;
  - no account may read another user's workspace.
- **FR-111 (4.5)** **Restricted systems** are the **CO₂ analysers**, every model's
  **restricted** subsystem, and nothing else. Only the roles of §7.6 that include emissions
  may read them.

### 6.4 Models

- **FR-33** Each model is an OGC **process system** in its own worker; a failure in one
  stops nothing else.
- **FR-34** Core models: **Data cleanse** (first), **Summaries**, **Analysis** (change
  detection, correlation and clustering with three algorithms).
- **FR-35 (4.7)** Models **process each dataset as soon as it is imported**, the whole
  dataset, in fixed windows aligned to the dataset's start, and publish **per dataset**.
  They follow no replay clock and no current dataset. Outputs for every dataset are kept,
  so opening any processed dataset shows its results at once. Views show the dataset's
  **latest run** (4.6); earlier runs are reached through a saved data of interest.
- **FR-35b (4.7)** Each model publishes its progress on each dataset in its `runs`
  datastream (processing, with how far; complete). The display client shows that a
  dataset's results are **still being prepared**, read generically from the runs it can
  see, until they are complete.
- **FR-35a (4.4)** **Analysis takes a data of interest** (§6.7) as its input: the display
  client's current selection is sent, as an unsaved data of interest, in the command.
- **FR-36** Empty slots open an in-browser Python editor (Python back end only).
- **FR-37** Every result carries its settings, data range and `run_id`; scores come from
  the referee (scaffolding).
- **FR-37a** Withdrawn (4.7): models no longer follow a replay rate.
- **FR-112 (4.5)** **Anything derived from CO₂ is restricted.** A model publishes any output
  with CO₂ among its inputs **only** under its **restricted** subsystem: cleaned CO₂,
  CO₂ summaries, and any Analysis run whose selection includes CO₂ (its changes, clusters
  and correlation). **The run's entry in the runs log is restricted too**, because its
  settings name CO₂. An output whose inputs exclude CO₂ is published as before.
- **FR-112a (4.5)** A command asking a model to use CO₂ is **rejected** (`REJECTED`, saying
  only that a requested source is not available) when the sender's role does not include
  emissions. The receiver checks the sender's role; it never relies on the client having
  hidden the choice. How the receiver learns the sender's role is decided by the
  authentication spike (§15, item 4).
- **FR-113 (4.5)** The core models' service accounts have access to CO₂. A **new model**
  written in an empty slot **does not**, unless the owner grants it.

### 6.5 Third-party libraries

- **FR-38** The data server is **OpenSensorHub**, unmodified; the contract suite tests that a
  server provides what the master states.
- **FR-38a** In the demonstrator a **stand-in** takes its place (FR-06c).
- **FR-39** **Scientific libraries** (numpy, scikit-learn) are used by the models only.

### 6.6 Replay (4.7)

Withdrawn from the server in 4.7: the replay controller, its `replay` control stream, its
state and log datastreams, and the readiness of models for a dataset. Replay is the display
client's own (§8.6).

- **FR-89 (4.7)** **One user at a time** is logged in (§16).

### 6.7 Data of interest (4.4)

- **FR-94** A **data of interest** is a named record of a set of data, enough to
  regenerate any view of it exactly. Its fields (committed as a JSON Schema master):

  | Field | Meaning |
  |---|---|
  | `version` | The record's schema version |
  | `label`, `note` | The analyst's name for it, and why it was kept |
  | `dataset` | File name, size, modified date and content hash |
  | `start`, `end` | Within that dataset's own time |
  | `resolution` | An ISO 8601 duration (`PT1S`, `PT1M`, `PT1H`) |
  | `aggregation` | `as-stored`; reserved: `mean`, `min`, `max` |
  | `sources` | Datastreams by system unique id and output name, and the fields chosen |
  | `run` | A model run's `run_id`, only where a datastream holds more than one run |
  | `created` | When it was saved, and by whom |

  Processing stage and model settings are **not** fields: different stages are different
  datastreams, and a run's settings are in its model's `runs` datastream.
- **FR-94a** **For now, a resolution that does not exist as a datastream is refused**,
  naming those that do. The `aggregation` field exists so resampling can be added later
  without changing saved records.
- **FR-95** Data of interest is kept **on the server, per analyst**: each analyst has a
  **workspace** system with an append-only `data-of-interest` datastream. Saving appends a
  record; removing appends a removal. Nothing about it is kept in the browser.
- **FR-96 (4.6)** A data of interest that cannot be resolved is listed **greyed**, saying
  why: its source is no longer permitted (FR-96a), or its file is not imported, naming the
  file. A record names the file, not a server identifier, so importing that file again
  restores it. Reset instance does **not** grey records: it deletes them with everything
  else (FR-50a).
- **FR-96a (4.5)** A user can only save data of interest from sources they can see. If a
  user's role later loses emissions, any of their records naming CO₂ sources is listed
  greyed as "no longer permitted", and nothing from those sources is drawn.

---

## 7. Functional requirements: client and server lifecycle

### 7.1 Declared profile

- **FR-40 (4.7)** The profile lists the essential sources: **for every imported dataset**,
  bow and stern air temperature and apparent wind speed, and the core models' datastreams
  the views depend on; and the importer's catalogue and control stream (4.7). **CO₂ is
  never essential (4.5)**, so a weather-only user does not start
  degraded.
- **FR-40a (4.6)** Per-dataset essentials are written as **templates**, with output names
  such as `weather · {dataset}`. The client checks each dataset against them when it is
  loaded. The profile's schema allows the placeholder.
- **FR-41** The profile is at a fixed path beside the server (`profile.json`).

### 7.2 Handshake and self-configuration

- **FR-42 (4.4)** The handshake happens **after login** and is standard discovery only,
  finding resources by unique id and output name.
- **FR-42a** The handshake is drawn one request at a time.
- **FR-43 (4.4)** The field list is built **for the current dataset**, and rebuilt when the
  current dataset changes, without a full handshake.
- **FR-44 (4.6)** Discovery happens only at handshake. When an **import completes**,
  the client repeats the **full handshake**, so that it finds the new dataset's
  datastreams.
- **FR-45 (4.4)** Degraded mode is **per dataset**: a dataset missing an essential source
  (Mission C) opens degraded, naming what is missing; other datasets are unaffected.

### 7.3 Restarts

- **FR-46** **Restart client** discards the display client's state, **including the
  credentials**, and returns to the login screen.
- **FR-47 (4.3)** **Restart server**: while starting, the server refuses connections.
- **FR-48 (4.3)** After any period of unreachability the client repeats the handshake;
  receivers resubscribe.

### 7.4 Control panel

- **FR-49** Take server down / bring server up.
- **FR-50** Field toggles, taking effect at the next server start.
- **FR-50a (4.4)** **Reset instance** stops the server, **deletes its whole store**, and
  restarts it empty: no dataset imported, no results, no data of interest. Nothing is ever
  deleted record by record. The data folder is untouched. Reset instance asks for
  confirmation, naming what will be lost.
- **FR-51, FR-52** As in 4.3.

### 7.5 Authentication and screen lock (4.4)

The threat is a **guest at an unattended screen and keyboard**, in an area with wide
access. The device itself is secured.

- **FR-97** The display client opens on a **login screen**. **Nothing is shown before
  login**: no dataset names, no catalogue, no data.
- **FR-98** Credentials are held **in memory only**, never in browser storage. Reloading or
  closing the page means logging in again. There is no "remember me".
- **FR-99** The display client **locks** after a period of inactivity (5 minutes by
  default), and at once on a **Lock** button. On locking it blanks every view, list and
  data of interest, **discards the credentials** and stops all requests. Unlocking needs the
  password again, and restores the analyst's place.
- **FR-100** The browser keeps **nothing sensitive**: only harmless preferences such as panel
  layout. Data of interest lives on the server (FR-95). Nothing is encrypted in the
  browser, because nothing sensitive is stored there.
- **FR-101** A refused login says only that the name or password was wrong, not which.
- **FR-102 (4.5)** **In the demonstrator only**, the login screen offers **two demo
  accounts**, each pre-populated and labelled as demo credentials: **the owner** (Owner
  role) and **a friend** (Viewer, weather only). **A developed system never pre-populates
  credentials**, and this requirement must not be carried over.
- **NFR-11** In a developed system the browser runs in **kiosk mode**, without an address
  bar or developer tools, so a guest at an unlocked screen cannot inspect the page.

### 7.6 Accounts and roles (4.5)

- **FR-114** Three **roles**, defined once at installation as part of the delivered
  configuration:

  | Role | Weather data and its products | CO₂ and its products | Manage accounts |
  |---|---|---|---|
  | **Owner** | Read | Read | Yes |
  | **Viewer with emissions** | Read | Read | No |
  | **Viewer (weather only)** | Read | **Refused (403); listed, for now** | No |

  Every role may use the importer and the models, and keep its own workspace.
- **FR-115** The **owner creates and maintains accounts** (create, set or reset a password,
  assign a role, disable) **through OpenSensorHub's own administration**. The owner
  assigns roles but does not edit them, and so cannot expose CO₂ by changing a permission. Granting or
  removing emissions is changing a user's role.
- **FR-116 (4.6)** A change of role takes effect **at once, on the user's next request**
  (basic authentication has no session; the authentication spike confirmed OpenSensorHub
  applies a change on the next request, D-151). A logged-in user is not logged out: what
  they can no longer see disappears at their next poll, and their data of interest from it
  is shown greyed (FR-96a).
- **FR-117** **Our own account screen** is built only if a stated **trigger** is met: the
  owner cannot complete the account tasks of FR-115 unaided in a short trial, or
  OpenSensorHub's administration cannot be used on the delivered machine. Until then it is
  excluded (§16).
- **FR-118 (4.7)** The display client has **no code that knows about CO₂ or roles**. It
  offers **only sources it can read**: a source whose schema or data is refused (403) is
  left out, generically, like any source it cannot use. So for a weather-only user no chip,
  view or data-of-interest source for CO₂ appears, although discovery lists the CO₂
  systems (FR-93).

---

## 8. Functional requirements: the display client

The display client is the real system's screen, inside a **monitor frame** in the detail
panel. It is deliberately **small and generic**.

### 8.1 Layout (4.7)

Before login: the **login screen** only. After login, from top to bottom: a status strip
with the analyst's name, the **dataset selector button**, the **Favourites button** and
**Lock**; the **replay bar**; the **field chips**, **period presets** and **clustering**
control; the **views**. The dataset list and the data of interest list are **popups**, not
always on screen, to leave the space to the views.

- **FR-127 (4.7)** **Popups.** The Dataset selector (FR-103) and Favourites (§8.5) open as
  popup panels anchored to their buttons. Each closes on Escape, on a click outside it, or
  when its main action is taken. Each can be used from the keyboard. Neither is open at
  login.

### 8.2 Controls

- **FR-103 (4.7)** **Dataset selector**: a button in the status strip shows the current
  dataset (or "Choose a dataset" when none is open) and opens a popup listing every file
  in the data folder, from the importer's catalogue, with its name, size, modified date,
  status and, once imported, its time span.
  - **Open** on an imported file makes it the client's **current dataset** and closes the
    popup. No command is sent: the dataset is the client's own choice (§8.6).
  - **Open** on a file not imported sends **import** (K) to the importer, shows progress,
    then opens it when it is ready. Import progress stays visible on the button while the
    popup is closed.
  - Superseded and changed files are marked; overlapping and degraded datasets are marked;
    a file that is importing cannot be opened.
  - **Rescan** asks the importer to list the folder again.
  - With no dataset open, the client invites the analyst to open the selector.
- **FR-90 (4.7)** **Replay bar**: play/pause, rate, and a timeline of the **current
  dataset** with the replay position; seek by dragging. It drives the client's **own
  replay clock** (§8.6); no command is sent.
- **FR-53** **Fields**: chips for the current dataset.
- **FR-54 (4.4)** **Period presets** ending at the replay time: 1 minute, 1 hour, 6 hours, a
  day, **the whole dataset**.
- **FR-55** **Clustering**: three unnamed algorithms on the current selection.
- **FR-56** With no field selected, the views say so.

### 8.3 Views

- **FR-57 to FR-62** Line plot, line plot with error bars, heat map and cluster view, each
  following the selection; unknown fields drawn by type; arranged in a movable, resizable
  grid.

### 8.4 Live data

- **FR-63 (4.3)** While playing, the client polls each datastream in use once per real
  second, up to the replay time.
- **FR-63a (4.3)** While paused, the client polls nothing.
- **FR-63b (4.7)** The client never reads beyond its replay time, even where the server
  holds the whole dataset and its results.

### 8.5 Data of interest (4.7)

On screen, data of interest are called **Favourites**. This document keeps "data of
interest" as the requirement term.

- **FR-104 (4.7)** A **Favourites** button (a star, with a label and tooltip) opens the
  Favourites popup (FR-127). Its top shows **the current data window**: the dataset, the
  period, the resolution, the fields and, where relevant, the run. It can be saved there under
  a name the analyst types, with an optional note. The star shows when the current window is
  already saved.
- **FR-105 (4.7)** Below it, the popup lists the analyst's saved records with name, dataset
  and span. Each can be **opened** in any view, **compared**, or **removed**. Opening one
  closes the popup.
- **FR-106** **Opening** a record regenerates it from the server, as the record describes,
  whatever the current dataset. It is labelled with its dataset and span.
- **FR-107** **Comparing** two records draws them on one chart on **elapsed time** from each
  record's own start, labelled "elapsed", never as simultaneous. A finer resolution is
  brought to the coarser one; a shorter record ends earlier.
- **FR-108** A record whose dataset is not imported is shown greyed (FR-96).

### 8.6 Replay (4.7)

- **FR-84 (4.7)** Each display client holds its **own current dataset** and **replay
  clock**. "Now" is a time within the current dataset. The whole of every imported dataset,
  and every model's results for it, are on the server; the client shows them only up to its
  replay time (FR-63b).
- **FR-84a (4.7)** A client has **one current dataset** at a time. Datasets have no common
  time axis, so a client never plays two at once.
- **FR-86 (4.7)** Rates: 0.1×, 0.5×, 1×, 10× and 100×. No model bounds them.
- **FR-87 (4.7)** **Seek** moves within the current dataset. It changes only what the client
  shows.
- **FR-88** At the end of the dataset the replay pauses and says so.
- **FR-85 (4.7)** The replay clock is not on the server. Restart client returns it to the
  start of the default dataset.

---

## 9. Functional requirements: the architecture view (demonstrator shell)

### 9.1 Layout (4.4)

- **Top bar (4.7)**: title, subtitle, a mirror of the replay bar acting on the display
  client's clock, restart client, restart server, failure demos, control panel, overview.
- **Left**: the stacked flowchart: front end, third-party libraries, back end, legacy.
- **Below it**: status (logged-in analyst or locked, the client's current dataset, replay
  time and rate, back end, server, client, essentials) and the message key.
- **Right**: the detail panel.

### 9.2 Flowchart

- **FR-64** React Flow, from a fixed layout.
- **FR-65** Every flow in §3.1 is drawn; HTTP flows are labelled "HTTP", pushed commands
  "push", and the importer's writes "inside the server".

### 9.3 Messages

- **FR-66** Real messages captured at every boundary, with capture on and off tested.
- **FR-67** Every message is drawn. A bulk import is drawn as **one I message per thousand
  rows written**, labelled with the count, so an import is visible without flooding the
  flowchart.
- **FR-68** Clicking a message shows it in the message strip, with credentials redacted
  (FR-16a).
- **FR-68a (4.5)** The architecture view is a **god's-eye view** of a synthetic system: it
  shows every message, including the models' CO₂ traffic, whoever is logged in to the
  display client. A one-line note says so, so it is not mistaken for a permission leak. The
  display client's own traffic shows what its user can read: a weather-only user's client
  receives no CO₂ value or schema; discovery listings may name CO₂ systems for now
  (FR-93).

### 9.4 Detail panel

- **FR-69, FR-69a (4.7)** The overview, listing the importer and models under *written
  for this system*, and authentication and permissions under *adopted*.
- **FR-70** **Display client**: the monitor, notes, and the message strip.
- **FR-71** **Models**: as in 4.3, with each model's per-dataset outputs.
- **FR-72 (4.4)** **Data server**: OpenSensorHub with a stand-in here; the Connected Systems
  resources describing this system, **per dataset**; the importer and workspace systems; authentication and permissions; why it fits; gaps; what is not used.
- **FR-109 (4.4)** **Data folder**: the files, with sizes, dates and statuses, and a note
  that the system never writes to it.
- **FR-110 (4.4)** **CSV importer**: what it does; the catalogue; the column mapping; the
  last import's speed in rows per second.
- **FR-91** Withdrawn (4.7) with the replay controller.
- **FR-73** Every other component shows an explanation panel.

### 9.5 Value-add reveal

- **FR-74 to FR-76** As in 4.3. The importer is not marked.
- **FR-74a (4.6)** With the `hand-made` flag, FR-74's startup state begins **at adoption**
  (FR-125), not at load. No component can be revealed during the opening (FR-121).

### 9.6 Time in the demonstrator

- **FR-77 (4.4)** At load the display client shows its login screen and nothing else sends.
  After login it handshakes; the replay is paused at the start of Mission A.
- **FR-78** Messages are drawn in real time, whatever the replay rate.
- **FR-92** Withdrawn (4.7): Freeze. Pause covers it.
- **FR-79 (4.7)** A viewer's click is answered at once.

### 9.7 Failure demos (4.4)

- **FR-79a** The menu offers: the server goes down and comes up; the server restarts; an
  essential source is missing; fields the client has never seen; a misconfigured server;
  **a wrong password** (refused, nothing shown);
  **the screen locks** (views blank, requests stop, login needed); **an overlapping file**
  (Mission B and its re-export imported side by side, never mixed); **a degraded dataset**
  (Mission C); **the friend logs in** (the same dataset with no trace of CO₂ anywhere in
  the client, and no CO₂ value in its traffic); **the friend asks for CO₂** by a crafted
  request (refused: 403 from the server, and a command naming CO₂ rejected by the model)
  (4.7).
- **FR-79b, FR-79c** As in 4.3.

### 9.8 Adoption opening (4.6)

The opening is for **non-engineers**. It shows what the data server would be if we wrote
it ourselves, then what adopting OpenSensorHub saves. It comes **before** the value-add
reveal, so nothing is marked as ours in it.

- **FR-119** **Entry.** If the page's URL query has a `hand-made` flag (`?hand-made`, with
  any value or none), the demonstrator opens in the **adoption opening**. Without the flag
  it opens exactly as FR-77 describes. The flag is read once, at load, and has no other
  effect. Reloading with the flag repeats the opening. The flag belongs to the demonstrator
  shell only; a developed system has no such flag.
- **FR-120 (4.7)** **The data server as subsystems.** In the opening the third-party zone
  holds **no data server**. Written ourselves, the data server is **a range of subsystem
  components to develop**. The back end draws the main ones, below, beside the CSV importer
  and Models, and **all are equals**: the same card style, the same size, one grid. No
  frame, label or colour groups the subsystems or sets them apart from the other components,
  and the opening states no count of them:

  | Subsystem | What it does | Keeps data in |
  |---|---|---|
  | Web API | Connected Systems endpoints, discovery, paging, formats | — |
  | Registry | Systems, datastreams, schemas, control streams | a metadata database |
  | Observation store | Time-series storage, indexes, backups, growth | a time-series database |
  | Query engine | Time filters, latest value, building responses | indexes |
  | Commands | Control streams, delivery to receivers, status | a command log |
  | Accounts | Users, passwords, roles, sessions | a user database |
  | Permissions | Who may see and change what | a policy store |
  | Admin | Settings, start, stop, health | configuration files |

  The flows of §3.1 are drawn between the subsystems and the other components as plain
  lines, with no message letters (FR-120a). The back-end band has **two rows** in the
  opening (five cards each), with every card at its normal size. The zones below it
  move down, and return at the merge.
- **FR-120a (4.6)** **Flows in the opening.** Each external flow is drawn to the
  subsystem it belongs to, and the lines between the subsystems are drawn too:

  | From | To |
  |---|---|
  | Display client, Models | Web API (both ways) |
  | Commands | CSV importer, Models (push) |
  | CSV importer | Observation store, Registry |
  | Web API | Query engine, Registry, Commands, Permissions |
  | Query engine | Observation store |
  | Accounts | Permissions (both ways) |
  | Admin | Web API |
- **FR-121** **Nothing is gold.** No card is gold. No ★, diamond or "our value-add" appears
  anywhere in the opening, the detail panel included. Clicking the display client or
  Models does not reveal it.
- **FR-122** **Nothing runs.** The top bar's controls are **hidden, not disabled**: replay
  mirror, restart client, restart server, failure demos, control panel and
  overview. No message is sent or drawn. The display client does not handshake. **The back
  end does not start (4.6)**: no worker runs and no model registers until hand-over
  (FR-125). The status panel shows only "Opening". The **stand-in banner is hidden** until
  hand-over, because it names OpenSensorHub before there is a data server on screen.
- **FR-123** **The opening panel.** The detail panel opens on **Data server** with:
  - a two-way switch, **Build it ourselves | Adopt OpenSensorHub**, with *Build it
    ourselves* selected;
  - the table of FR-120;
  - a row, **"Written by us either way"**: CSV importer, Models, display client, in plain
    style.
  - the lead, before adoption: written ourselves, the data server is a range of subsystem
    components to develop, among them these (4.7).

  Clicking a subsystem card highlights its row in the table. Clicking any other card does
  nothing in the opening.
- **FR-124** **Adopt.** Choosing *Adopt OpenSensorHub*:
  1. moves the subsystem cards into the third-party zone, where they merge into the single
     **Data server** card (OpenSensorHub, OGC Connected Systems);
  2. spreads the CSV importer and Models across the back end that the subsystems have
     left;
  3. changes the table to "OpenSensorHub covers all of these", with each subsystem
     ticked. No number is shown (§16).

  This takes about 1.5 seconds. With reduced motion it is immediate.
- **FR-125** **Hand-over.** When the merge ends, the flowchart is **exactly** FR-77's
  startup layout, and FR-74 applies from that moment: every component looks the same, and
  the display client shows its login screen. The top bar's controls and the stand-in banner
  **appear**. The **back end starts now (4.6)**, with the usual loading progress (NFR-10),
  as on a load without the flag. The detail panel keeps the adopted savings until the
  viewer clicks a component or closes it. **That panel is the only difference** from a load
  without the flag.
- **FR-125a (4.7)** **Ready means usable.** After hand-over, and after any load, nothing
  plays until the analyst logs in, a dataset is open (Mission A by default) and Play is
  pressed. A top-bar control that cannot act yet is **disabled and says why** on hover and
  to assistive technology (for example "Log in to the display client first"). It is enabled
  as soon as it can act.
- **FR-126** **One way.** Adoption cannot be undone in a session. The switch is removed at
  hand-over. To show the opening again, reload with the flag.

---

## 10. Implementation direction

- **FR-80 (4.6)** TypeScript and React; React Flow; **ECharts**; react-grid-layout;
  CodeMirror 6. The views are charts. Decision D-53, which removed them for speed on
  slower laptops, is superseded: slower laptops are not a target for this project.
- **FR-81 (4.7)** In a developed system: **OpenSensorHub**, with its own authentication, the
  CSV importer as its module writing in bulk, and the models as separate processes with
  service accounts, each subscribed to its control stream. Replay is the display client's
  (4.7). In the demonstrator: the stand-ins.
- **NFR-04** TypeScript types are generated from the masters.
- **NFR-05** The startup budget includes each model's worker.

---

## 11. Visual style

As Version 4.2 §11, with the changes of 4.3 (four zones; messages at a fixed on-screen
pace), and in 4.4 and 4.6:

- **VS-25 (4.7)** In the adoption opening the subsystem cards are drawn with the same
  sketch renderer, line weight, fill and font as every other component card. The merge
  moves the cards; it does not redraw their outlines.
- **VS-24 (4.4)** The **login and lock screens** are plain, inside the monitor frame, in the
  display client's own sans-serif. The demonstrator's pre-populated credentials carry a
  visible "demo credentials" label.

---

## 12. Delivery

- **NFR-06 to NFR-10** As in 4.3. The data folder's files are part of the build.
- **NFR-10a (4.7)** **A stalled start says where.** The loading progress names each step. If
  a step does not finish within 10 seconds (for example the seam relay cannot start, because
  the browser blocks Service Workers or an older one is in control), the page says which step
  and what the viewer can do (reload, allow the site), rather than waiting silently with its
  controls disabled.
- **NFR-11** Kiosk mode in a developed system (§7.5).

## 13. Development process

- **PR-01 to PR-03** As in 4.2.
- **PR-04 (4.7)** One server-neutral contract suite, finding resources by unique id and output
  name, run against both stand-ins and a stock OpenSensorHub, **with credentials (4.4)**,
  talking to OpenSensorHub directly (4.7).
- **PR-05** The stand-ins have no capability OpenSensorHub lacks.
- **PR-06** OpenSensorHub is the reference.
- **PR-07 (4.4)** No credential appears in the repository except the demonstrator's demo
  credentials, which are labelled as such and grant nothing outside the demonstrator.

---

## 14. Acceptance criteria (4.7)

| ID | Test | Supports |
|---|---|---|
| AT-01 | Observations served match the CSV file's rows and the manifest at each time | C1 |
| AT-02 | The same application passes the same contract suite in Pyodide and in CPython | C1 |
| AT-03 | A second, differently awkward CSV dialect changes the importer only; every response is identical | C1 |
| AT-04 | The declared queries of FR-31 meet their budget over three days of one dataset | C1 |
| AT-05 | The CPython build is browsed by OSHConnect-Python and the CSAPI Explorer, with credentials | C1 |
| AT-07 | Mission C opens degraded, naming its missing source; Mission A and B are unaffected | C2 |
| AT-09 | Each extra field appears after restart client, drawn by type | C2 |
| AT-11 | Server down, then up: banner, stale data, fresh handshake | C1, C2 |
| AT-12 | A field toggle changes nothing until the next server start | C1, C2 |
| AT-13 | A model written in an empty slot registers and appears after restart client | C3 |
| AT-14 | A failing model leaves everything else running | C3 |
| AT-15 | Every model but Data cleanse reads only Data cleanse's output | C3 |
| AT-16 | Change detection and clustering recover each dataset's manifest features, with scores | C3 |
| AT-18 | Every boundary in §3.1 produces captured messages; outputs identical with capture on and off | Architecture view |
| AT-19 | Before login, while locked and while paused, nothing is sent but what each state allows | Architecture view, C5 |
| AT-20 | The value-add reveal works as FR-75 describes | Architecture view |
| AT-21 to AT-23 | Visual style and delivery | |
| AT-25, AT-26 | Stand-in visibility and parity | Honesty |
| AT-28 | Regenerating the data folder from the seeds reproduces the files exactly | Delivery |
| AT-29 | A model creates its resources; creating them again returns the same `Location` | C3 |
| AT-31 | Each failure demo shows what its banner says | C1, C2, C4, C5, C6 |
| AT-32 | The server-neutral contract suite passes against a stock OpenSensorHub, with credentials, configured only as interfaces §14 allows (no component of ours in front of it) | C1 |
| AT-33 | Open, play, pause, each rate and seek act on the display client's own clock and send no command; the views follow within one real second | C4 |
| AT-34 | Every model's outputs for a dataset are identical however often it is processed, and whatever any client's replay does | C4 |
| AT-35 | Withdrawn (4.7): no model bounds the rate | |
| AT-36 | A seek changes only what the client shows; no model output changes | C4 |
| AT-37 | Requests per real second are the same at 0.1× and 100× | C4 |
| AT-38 | Receivers (the importer and the models) subscribe before declaring ready, and resubscribe after every restart | C1, C3 |
| AT-39 | No request waits on a command's `POST` before the display updates | C1, C3 |
| **AT-40** | The catalogue lists every file in the data folder with name, size, modified date, hash and status; a file copied in appears after rescan | C1 |
| **AT-41** | Opening a file not imported imports it, showing progress, then loads it; nothing in the data folder changes | C1, C4 |
| **AT-42** | Mission B and its re-export are imported into separate datastreams; a query on one never returns the other's readings | C1 |
| **AT-43** | A file changed since import is imported as a new dataset; the earlier one is marked superseded and still opens | C1 |
| **AT-44** | Changing the current dataset rebuilds the field list without a full handshake; a dataset already processed shows its results at once; one still being processed says so (FR-35b) | C2, C3 |
| **AT-45** | A saved data of interest, opened after switching dataset, regenerates exactly the same values | C3 |
| **AT-46** | Two data of interest compared on elapsed time are drawn from each one's start, at the coarser resolution, labelled "elapsed" | C3 |
| **AT-47** | A resolution with no datastream is refused, naming those available | C3 |
| **AT-48** | After Reset instance, every user's data of interest list is empty; re-importing a file restores nothing saved before the reset | C1, C3 |
| **AT-49** | Every request and push subscription without valid credentials is refused with 401, discovery and the catalogue included | C5 |
| **AT-50** | After inactivity, or on Lock, every view and list is blanked, the credentials are discarded, and no request is sent until login | C5 |
| **AT-51** | Nothing sensitive is in browser storage at any time: no credentials, dataset names or data of interest | C5 |
| **AT-52** | One analyst cannot read another's data of interest; a model's service account cannot create outside its own system | C5 |
| **AT-53** | No captured message shows a credential | C5 |
| **AT-54** | Reset instance empties the store and leaves the data folder byte-identical | C1 |
| **AT-55** | Logged in as weather only: reading the observations of any CO₂ datastream or restricted model output gives 403 (its title and schema may be read, D-351); no CO₂ value reaches the client; the client offers no CO₂ source | C6 |
| **AT-56** | Every model output with CO₂ among its inputs, and every runs-log entry naming CO₂, is published only under a restricted subsystem; no unrestricted datastream contains a CO₂ value or name | C6 |
| **AT-57** | A weather-only user's command naming CO₂ is rejected by the model, whatever the client sent | C6 |
| **AT-58** | The display client's code contains no reference to CO₂ or to roles; the same build shows CO₂ to the owner and nothing of it to the friend | C2, C6 |
| **AT-59** | Changing a user's role from emissions to weather only takes effect at their next request: CO₂ disappears and their CO₂ data of interest is greyed as no longer permitted (FR-116) | C6 |
| **AT-60** | A weather-only user is not degraded on any dataset that has every essential source | C2, C6 |
| **AT-61** | A new model from an empty slot cannot read CO₂ unless the owner grants it | C3, C6 |
| **AT-62** | Without the `hand-made` flag the demonstrator opens as FR-77 describes; with it, in the adoption opening; reloading with it repeats the opening | Architecture view |
| **AT-63** | In the opening: no top-bar control and no stand-in banner is in the page; no back-end or model worker has started; no message is captured or drawn; the third-party zone has no data server; nothing gold, no ★ and no diamond anywhere, and clicking the display client or Models reveals nothing | Architecture view |
| **AT-64** | The subsystem cards match the CSV importer and Models cards in size, outline style, fill and font; no element encloses or labels them as a group; no count of them is shown | Architecture view |
| **AT-65** | After Adopt: one Data server card in the third-party zone; the table shows every subsystem ticked, with no number; the top-bar controls and banner appear and the back end starts; once it has started, everything but the detail panel matches a load without the flag, and the state passes AT-19 and AT-20 | Architecture view |
| **AT-66** | With reduced motion, Adopt changes the layout immediately, without animation | Visual style |
| **AT-67** | After Adopt, nothing plays before login, an open dataset and Play; every disabled top-bar control says why | Architecture view |
| **AT-68** | With Service Workers blocked, or an older one in control, the page names the stalled step and what to do within 10 seconds | Delivery |
| **AT-69** | The Dataset selector and Favourites open as popups, close on Escape, outside click and their main action, work from the keyboard, and keep import progress visible on the selector button | C2, C3 |
| **AT-70** | Two clients replaying the same dataset at different rates and positions see the same results up to their own replay times, and the server's outputs do not change | C4 |

---

## 15. Open questions

- **Hiding restricted resources from discovery (4.7, open).** FR-93 is relaxed: restricted
  resources are listed and refused with 403, as stock OpenSensorHub does. The owner is
  working with the OpenSensorHub team so that a user is not shown resources they may not
  read. Until then C6 is the weaker claim of §1: the friend can see that CO₂ sources exist,
  their titles and schemas included, never their contents (D-351).
- **Refusing replace and delete in OpenSensorHub (4.7, open).** The delete probe of
  2026-11-26 found that stock OpenSensorHub lets the owner, and a user on their own
  workspace, delete. FR-28a needs that forbidden by configuration. To be confirmed with the
  OpenSensorHub team; the first 4.6 build refused it in its gateway, now withdrawn.

- **Reset instance and greyed data of interest (answered 2026-11-26).** FR-50a stands:
  Reset instance deletes everything, data of interest included. FR-96 and AT-48 are
  restated; greying is shown through a change of role (AT-59).

- **The CSV importer as an OpenSensorHub module (answered 2026-11-25: feasible, at about
  300,000 rows/s, through internal classes that need a retest on each upgrade; see the
  finding of that date).** The question was: Can a module write a file of
  about half a million observations into the store in bulk, and how fast? This replaces
  4.3's in-place store-adapter spike. Fallback: an importer outside the server writing over
  HTTP, accepting the import time, with progress shown.
- **Authentication and permissions in OpenSensorHub (answered 2026-11-25; see the finding of
  that date and decisions D-150 to D-153).** Answers in brief:
  1. Not hidden: OpenSensorHub answers 403. The access gateway fallback was taken in the
     first 4.6 build and withdrawn in 4.7; FR-93 is relaxed instead (see above).
  2. Denies are not inherited.
  3. Roles work, but they name server ids.
  4. The sender's user id is carried, but not the role. Subscriptions close with access
     control on.
  5. The administration screen is generic.
  6. 401 with `WWW-Authenticate: basic`; workspaces are only half enforced.
  7. Changes take effect on the next request; FR-116 is reworded accordingly.

  The original question: Confirm, in this
  order of risk:
  1. restricted systems are **hidden from discovery**, not only refused (FR-93);
  2. permissions per system, **inherited** by datastreams and control streams;
  3. user accounts and **roles**, assignable without editing permissions;
  4. authenticated **WebSocket** command subscriptions, and a receiver able to learn the
     sender's role (FR-112a);
  5. the **administration** usable by a non-technical owner on the delivered machine
     (FR-117's trigger);
  6. the answer to a request without credentials, and per-user workspaces.

  Fallback for 1 or 2: a thin **filtering gateway** that removes restricted resources
  from responses. It worked in the first 4.6 build, but weakened "OpenSensorHub as
  shipped"; the owner withdrew it in 4.7.
- **CO₂ in the client's real files.** Column names, units (ppm or mg/m³) and whether CO₂
  was recorded by every sensor.
- **The client's real CSV files.** Column names, time format, units, missing-value codes,
  file sizes and whether files ever overlap or are re-exported.
- **Idle time before lock.** 5 minutes is a placeholder; confirm with the barge owner.
- **Decision log numbering.** Resolved: the duplicates are now D-107 to D-114.
- **What OpenSensorHub must be configured to do (4.7).** Interfaces §14 lists what the
  stand-ins assume of a configured OpenSensorHub without a gateway: an allow-list for
  restricted reads, refusing delete, private workspaces, an internal endpoint for receivers,
  and no browser login dialog. Each is to be confirmed with the OpenSensorHub team.
- **Handshakes after imports (4.6).** A full handshake after every import (FR-44) is
  drawn one request at a time (FR-42a), and it grows with every dataset imported. If it
  gets in the way of a demonstration, a handshake scoped to the dataset is the
  alternative.
- **Retention.** Results are appended per run and per dataset; a long-lived instance grows
  until Reset instance.
- **Resampling.** Reserved in `aggregation` (FR-94a); not offered yet.
- **Several analysts at once.** Excluded (FR-89). Data of interest is per analyst and
  replay is per client (4.7), so the step is smaller than it was.
- **Name.**

## 16. Deliberate exclusions from Version 4.7

- **A live sensor or live ingest**, and any writing to the data folder.
- **Two datasets playing at once in one client** (FR-84a); comparison is by data of
  interest on elapsed time.
- **A shared replay clock (4.7)**: there is no replay on the server; models do not follow
  replay.
- **Freeze (4.7)**: Pause covers it.
- **An access gateway of ours (4.7)**: clients reach OpenSensorHub directly (FR-93).
- **More than one analyst logged in at a time** (FR-89).
- **Replacing and deleting** anything, except Reset instance as a whole (FR-50a).
- **Encryption in the browser** (FR-100): nothing sensitive is stored there.
- **Pre-populated credentials in a developed system** (FR-102).
- **Position**, and every model that needs it.
- **Estimates and measures of risk** on screen.
- **Resampling to arbitrary frequencies**, for now (FR-94a).
- **Our own account administration screen**, until FR-117's trigger is met.
- **Permissions per field** within a record: restriction is always per system (FR-93).
- **Roles defined or edited by the owner**: roles are fixed at installation (FR-114).
- **Costs of adoption in the opening (4.6)**, such as learning OpenSensorHub, its spikes,
  licence obligations or the risk of depending on it. The opening shows savings only;
  those costs belong in the ADR.
- **Counts, scores or totals in the opening (4.6)**, such as subsystems saved or stores
  avoided. The merge itself makes the point; numbers would read as a sales pitch.
- **Marks of what is unproven in the opening (4.6).** Every subsystem is ticked once
  adopted. What the authentication and bulk-import spikes have still to prove is recorded
  in §15 and ADR 0005, not on screen.
- **Returning to "Build it ourselves"** after adoption, in a session (FR-126).
- **The adoption opening in a developed system (4.6)**: it is demonstrator shell only.
