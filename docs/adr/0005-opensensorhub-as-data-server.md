# ADR 0005: OpenSensorHub, off the shelf, is the data server

**Status:** proposed, 2026-11-23 (SRD 4.2 §3, §6.3, §6.5, §7, FR-38, FR-81). Supersedes
ADR 0001. The demonstrator's architecture view shows this design, with the Version 4.1
server as the stand-in. A spike against a stock OpenSensorHub is recorded below; three
items stay open, so this ADR is not yet accepted.

**Context.** ADR 0001 wrote a subset of OGC API – Connected Systems directly on FastAPI,
because no off-the-shelf server runs in Pyodide. That was a constraint of the
demonstrator, not of the system it stands for. The Spike 0 finding already rated
OpenSensorHub the most complete server for Parts 1 and 2. A developed system has no reason
to write and keep honest its own Connected Systems server when one can be adopted.

**Decision.**

1. In the system the demonstrator stands for, the **data server is OpenSensorHub**, used
   as shipped. It moves from *New build · back end* to *Third-party libraries*.
2. **FastAPI is no longer a component.** OpenSensorHub serves HTTP itself, and a layer
   that only forwards requests has no job. The display client and the models talk to the
   data server directly.
3. The **store adapter becomes an OpenSensorHub module**, written against its extension
   interface. It remains the only code that understands the logger store, and the only
   back-end code written for this system apart from the models.
4. The **demonstrator keeps a stand-in for OpenSensorHub**, since a Java server cannot run
   in a browser: the Connected Systems subset of Version 4.1, in Python (still on FastAPI,
   as an internal detail that is not drawn) and in the JavaScript stand-in. The card is
   labelled as standing in for an off-the-shelf server.
5. The committed OpenAPI master becomes **what this system needs of a Connected Systems
   server**, not the definition of one. The contract suite is the check that a server,
   OpenSensorHub included, provides it.

**Spike, 2026-11-23** (`docs/findings/FINDING-2026-11-23-opensensorhub-spike.md`;
OpenSensorHub 2.0.4). Sensing, discovery, resource creation and reading work as shipped.
Commands, restart recognition and replacing a result do not, and need design changes.

| Behaviour | Used for | Stock OpenSensorHub | Outcome |
|---|---|---|---|
| A link to the declared profile on the landing page | FR-41 | Absent | Publish the profile beside the server at a fixed relative path |
| An instance identifier on every response | FR-47, FR-48 | None | A restart is a period of unreachability; what was created persists, so no fresh handshake is needed |
| 503 with `Retry-After` while starting | FR-47 | Connections refused until ready | Starting is treated as unreachable |
| 409 with `Location` when creating what exists | FR-28 | 201 with the same `Location` | Models accept 201; no lookup needed |
| Plain `PUT` to replace a datastream's observations | FR-28a | 405 | **Open.** One observation per run needs an array, which was also refused as encoded |
| The `quality` reference form `{"href": "#…_qc"}` | FR-25 | Accepted and returned unchanged | No change |
| The extension interface the store adapter is written against | FR-20, FR-21 | Not tried | **Open.** Needs a spike of its own |
| *Found by the spike:* commands polled by a model | FR-27 | Not possible: commands are pushed to a receiver, and dropped without one; the sender waits 5 s; bounds are not enforced | **Open.** FR-27 must be revised, and with it the exclusion of push delivery |

**Spikes, 2026-11-25** (SRD 4.6).

- **Bulk import as a module**
  (`docs/findings/FINDING-2026-11-25-opensensorhub-bulk-import.md`). **Feasible.**
  - A Java module inside osh-core 2.0.4 imported 500,000 rows in about 2 s, roughly
    300,000 rows/s. It uses the same transaction handlers as the Connected Systems
    service.
  - An `import` control stream and an append-only catalogue datastream both work.
  - Caveat: those handlers are internal classes, so every OpenSensorHub upgrade needs a
    retest.
- **Authentication and permissions**
  (`docs/findings/FINDING-2026-11-25-opensensorhub-auth.md`). **Partly.**
  - Users, roles and Basic authentication work. There is no session, and a permission
    change applies on the next request.
  - Pushed commands carry the sender's user id.
  - But a denied system answers 403, and its datastreams and streams stay readable.
    Denies are not inherited.
  - With access control on, command subscriptions close at once.
  - Restriction that hides (FR-93) therefore needs an **access gateway** in front of
    OpenSensorHub (decision D-150).
  - This is the second piece of code written for this system that touches the server,
    after the importer module. It **weakens "used as shipped"** for the access-control
    part, though not for sensing, storage, discovery or commands.

**AT-32, 2026-11-26** (`docs/findings/FINDING-2026-11-26-opensensorhub-contract-suite.md`;
`backend/independent/at32_osh.py`). **Not passed: 1 of 12.** The contract suite, unchanged, ran
against OpenSensorHub 2.0.4 behind the access gateway, with the importer, the replay controller
and the core models as its clients.
  - One path fails 11 checks: OpenSensorHub serves no `/collections/all_systems/items`.
  - With four client-side changes (D-193 to D-196: discovery by `/systems?searchMembers=true`,
    SensorML as `application/sml+json`, `[ppm]` for CO₂, reading JSON whatever the content
    type), **all 12 pass**. They are proposed, not made.
  - In front of a real server the gateway also bridges receivers' subscriptions to WebSocket,
    serves the profile and discovers the system tree itself (D-190 to D-192).

**Consequences.**

* Less is written for this system: the display client, the models and the store adapter.
  The overview's *written for this system* list loses the data server; *sensible defaults*
  gains it.
* The Connected Systems subset is no longer ours to keep honest. What remains ours is the
  list of what we need, and the test that a server provides it.
* The demonstrator's server is now a stand-in in both back ends. What it shows of the
  data server is the interface, not an implementation that a developed system would keep.
* The store adapter's language and shape depend on OpenSensorHub's extension interface,
  which this project has not yet used.
* The referee endpoint remains demonstrator scaffolding and is no part of this decision.
* Fallbacks if OpenSensorHub proves unsuitable: a thin gateway in front of it for the
  behaviours above; failing that, the Version 4.1 server of ADR 0001.
