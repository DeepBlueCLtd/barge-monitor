# ADR 0004: Models use the Connected Systems HTTP interface

**Status:** accepted, 2026-11-21 (SRD 4.1 FR-02, FR-28, FR-28a, FR-35). Supersedes point 1
of ADR 0003 and decisions D-58, D-63 and D-68.

**Context.** In Version 4.0 a model reached the data server through an internal interface
over a MessagePort, whose operations mirrored Connected Systems resource creation. The
Data server panel nonetheless said that adding a model "is ordinary resource creation",
and `POST /systems` was refused. The claim that matters most to the project (a scientist's
model drops in without touching anything else) rested on an interface nobody else could
use.

**Decision.**

1. A model makes ordinary HTTP requests of the same application the display client reads:
   `POST /systems/models/subsystems`, `POST /systems/{id}/datastreams` and
   `/controlstreams`, `POST /datastreams/{id}/observations`,
   `GET /controlstreams/{id}/commands?statusCode=PENDING`, `POST /commands/{id}/status`.
   In the browser a model worker uses `fetch` through the relay; in CPython and in the
   stand-in the models make the same requests in-process.
2. Creating what already exists answers **409 with its Location**, so a restarted model
   finds its resources without a lookup of its own.
3. The server no longer pushes a command to a model. A model **polls** its control stream
   on the simulation clock (Analysis every simulated second). While the clock stands still
   the shell tells model workers that a command is pending, so a viewer's click is still
   answered at once (D-83).
4. Two things are **not Connected Systems** and are named so in the OpenAPI document:
   `PUT /datastreams/{id}/observations` (replace the collection, for results that hold the
   latest run only) and `POST /demonstrator/referee/{kind}` (scaffolding: scores against
   the manifest).
5. Nothing else is replaced or deleted, so the Create/Replace/Delete conformance classes
   are not claimed.
6. The server keeps everything published and no account of who has read it (FR-06). Data
   cleanse's output is no longer pruned.

**Alternatives.** Keep the internal interface and reword the panel: cheaper, but the
extensibility claim would stay unproven. One observation per run carrying arrays instead
of the PUT: standard-only, but it changes every reader of Analysis's outputs. A status
filter the model applies itself instead of `statusCode`: more traffic for no gain.

**Consequences.**

- The bespoke interface, its wire format and `modelhost.py` are gone; the contract suite
  registers a system and a datastream by hand against both back ends (AT-29).
- History is worked through as SWE Common JSON, a few hours at a request. Measured on a
  development machine with 24 hours of history: Python, first charts after about 29 s
  (at most 17.5 s before); stand-in, flowchart after about 3.4 s (1.0 s before). See
  `docs/findings/FINDING-2026-11-21-models-over-http.md`. Four weeks is
  not practical this way; a compact encoding for bulk reads is the route (SRD §15).
- Models read values at the server's published precision (two decimals), not the stored
  floats.
- A model's polling adds one request chain per simulated second to the flowchart.
