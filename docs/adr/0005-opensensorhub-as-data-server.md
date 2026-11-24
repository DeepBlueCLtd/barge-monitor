# ADR 0005: OpenSensorHub, off the shelf, is the data server

**Status:** proposed, 2026-11-23 (SRD 4.2 §3, §6.3, §6.5, §7, FR-38, FR-81). Supersedes
ADR 0001. The demonstrator's architecture view shows this design, with the Version 4.1
server as the stand-in; nothing here has been tried against OpenSensorHub.

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

**To be confirmed by a spike** (the contract suite pointed at a stock OpenSensorHub).
Each of these is something the Version 4.1 server does that the standard does not require:

| Behaviour | Used for | If OpenSensorHub does not provide it |
|---|---|---|
| A link to the declared profile on the landing page | FR-41 | The profile is published beside the server at a fixed relative path |
| An instance identifier on every response | FR-47, FR-48 | The client detects a restart another way (for example the landing page's `ETag`, or a failed request followed by an answer) |
| 503 with `Retry-After` while starting | FR-47 | A server that is starting is treated as unreachable until it answers |
| 409 with `Location` when creating what exists | FR-28 | A model looks its resources up before creating them |
| Plain `PUT` to replace a datastream's observations | FR-28a | One observation per run, carrying arrays (already the standard-only alternative in §15) |
| The `quality` reference form `{"href": "#…_qc"}` | FR-25 | The form OpenSensorHub's own client accepts (D-31) |
| The extension interface the store adapter is written against, and its language | FR-20, FR-21 | A separate process in front of the store that OpenSensorHub reads |

**Also to be confirmed by the same spike.** These are within the standard, but the models
depend on them and a server need not offer them to an outside client:

| Behaviour | Used for | If OpenSensorHub does not provide it |
|---|---|---|
| An outside client creating a subsystem under an existing system | FR-28 | A model registers as a top-level system and names the Models system as its parent another way |
| An outside client taking up a command and reporting its status over HTTP, rather than a module inside the server doing so | FR-27 | A small module in the server passes commands to the model; failing that, a model reads its settings from a datastream |
| A model described as a system whose asset type is a process, with no procedure resource | FR-28 | The model also creates, or refers to, a procedure |

**Considered and rejected: OpenSensorHub itself in the browser tab.** Pyodide is CPython
and carries no Java runtime. A Java runtime compiled to WebAssembly cannot open a listening
socket in a tab, so the server's own HTTP layer could not serve. The stand-in is therefore
**representative only**: the spikes establish the contract and behaviour it must copy, and
the demonstrator says so on the Data server card.

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
