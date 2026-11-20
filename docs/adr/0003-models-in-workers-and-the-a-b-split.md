# ADR 0003: Models in their own workers, and the split between Model A and Model B

**Status:** proposed, 2026-11-20 (SRD v4 FR-33, FR-34; open question §15 "Model A and Model B")

**Context.** SRD v4 merges the analysis service and the scientists' workspace into one
component, Models: Data cleanse, Model A and Model B, each an OGC process system in its
own worker, reaching the data server directly rather than through FastAPI. The SRD leaves
the split of work between A and B to an ADR, and never names it on screen.

**Decision.**

1. *How a model reaches the server.* Each model runs in its own Pyodide worker and calls
   the data server's **internal interface** (`backend/barge/modelhost.py`) over a
   MessagePort: create system, create datastream, create control stream, find, read,
   publish, command status, score. The operations mirror Connected Systems resource
   creation, so a model could later be moved behind HTTP. The server reaches a model the
   other way only to pass on a command. In CPython the same model code runs in-process
   through the same interface (`backend/barge/local_models.py`).
2. *Data cleanse* reads raw records, drops what the server's QARTOD flags reject and what
   stands out from its neighbours by more than its `spike_threshold`, smooths over five
   seconds and publishes `cleaned-bow` and `cleaned-stern` at 1 s, kept for a day.
3. *Model A* turns cleaned data into the long view: 1-minute and hourly **summary**
   datastreams for each sensor (FR-29) and **derived values** (dew point, bow minus
   stern, pressure tendency) at the same two resolutions.
4. *Model B* does the analysis on demand: **change detection, correlation and clustering**
   (algorithms A k-means, B Gaussian mixture, C agglomerative Ward) on the fields and
   period the display client sends as commands, re-run every ten simulated minutes.
5. *Scores* (FR-37) come from a referee in the back end that alone reads the manifest;
   Model B asks it for a score and publishes it with the run.

**Why this split.** A is continuous and incremental (every minute, all history); B is
episodic and driven by the viewer's selection. Keeping them apart means a slow clustering
run never delays the summaries the display depends on, and each worker loads only what it
needs (only B loads scikit-learn). It also makes AT-15 easy to state: A reads only Data
cleanse; B reads only Data cleanse and A.

**Consequences.**

- Four Pyodide instances (back end plus three models). Measured with one week of history:
  all models live about 18 s after load on a development machine. Memory is unmeasured
  on the target (SRD §15).
- History catch-up at startup streams the whole history through Data cleanse and Model A.
  Data cleanse's 1 s output is kept only until every model that reads it has read past it
  (and for a day), so memory stays bounded.
- Derived values exist at 1-minute resolution at best; a 1-hour period reads them from the
  1-minute datastream (60 points). Raw 1 s records are read only for sensor fields.
- The referee is demonstrator scaffolding with no counterpart in a developed system.
