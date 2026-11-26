# ADR 0007: The CSV importer is a server module, commanded like any system

**Status:** accepted, 2026-11-26 (SRD 4.6 FR-15..FR-22, FR-44, FR-67; interfaces §5, §7;
the finding of 2026-11-25 on bulk import; decisions D-119, D-120, D-130, D-144).

**Context.** The logger exports an awkward CSV dialect (`;`, decimal comma, half-seconds
since 1994, knots, tenths of °C, `-9999`/`VRB`, CRLF). Version 4.3 read the logger's
store in place through an adapter. From 4.5 the recordings are files in a data folder,
imported into the server's store.

**Decision.**

1. The **CSV importer** is the only code that understands the dialect. In the developed
   system it is an **OpenSensorHub module** writing in bulk. The spike measured about
   300,000 rows/s, through internal classes that need a retest on each upgrade.
2. It is a system (`urn:x-barge:importer`) with an `import` **control stream** (`import`,
   `rescan`) and a `catalogue` datastream that names files, hashes and spans, never
   columns, so it reveals nothing about CO₂.
3. A dataset id is `<slug>-<first 8 hex of sha256>`. Weather goes to `weather__{ds}`, CO₂
   to the restricted CO₂ datastreams (FR-21c). QC flags are computed on import (FR-32;
   CO₂ 250–5000 ppm with a 60 ppm spike test, D-144). Nothing in a file or the store is
   altered afterwards.
4. A changed file (the same name, a new hash) **supersedes** the old version in the
   catalogue (D-130); both stay readable.
5. **Mission A is imported silently** on every load (D-120). Each completed import causes a
   **full handshake** in the display client (D-119).

**Consequences.** One reader of the dialect; the rest of the system sees only Connected
Systems. The handshake grows with each dataset imported (recorded in §15 of the SRD).
Bulk writes depend on OpenSensorHub internals, which is a maintenance cost on upgrade.

**Alternatives.** An importer outside the server writing over HTTP (the fallback: slower,
but it uses only public interfaces). Reading files in place (the 4.3 adapter, rejected
because the folder is not a store).
