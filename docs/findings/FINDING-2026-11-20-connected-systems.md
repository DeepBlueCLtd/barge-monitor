# FINDING: OGC API – Connected Systems, Spike 0

**Date:** 2026-11-20
**Question:** Can the demonstrator's server implement a declared subset of OGC API –
Connected Systems (CS) Parts 1 and 2 as SRD Version 3.1 describes, and where does the SRD
contradict the specifications?
**Method:** desk research of the published specifications, the OGC repository and
developer site, and the known implementations. No code was written.
**Verdict:** **Feasible, with corrections.** The SRD's overall model holds. Nine details
are wrong or under-specified, and the subset is larger than the SRD implies, because CS
Part 1 rests on OGC API – Features and Common.

---

## 1. Status of the standards

| Document | Status |
|---|---|
| CS Part 1, Feature Resources (23-001) v1.0 | OGC Standard. Approved 2025-06-02, published 2025-07-16. Editor Alexandre Robin |
| CS Part 2, Dynamic Data (23-002) v1.0 | OGC Standard, published alongside Part 1 |
| SWE Common Data Model 3.0 (24-014) | OGC Standard. Approved 2025-06-02, published 2025-07-16. Adds JSON encodings; not backward compatible with 2.0 |
| CS Part 3, Pub/Sub | **Not published.** Listed in the OGC repository with MQTT and AMQP bindings and an AsyncAPI document; no status given |
| CS Parts 4 and 5 | Placeholders only |

The OGC repository's README still labels Parts 1 and 2 "draft preview", which is stale.
The developer site describes the ecosystem as **young**.

## 2. What the SRD gets right

- **No position is needed.** A System's `location` is optional (recommended, not
  required), and an Observation's sampling feature is optional. FR-10 and FR-23 hold.
- **Record datastreams are supported.** An Observation may package several properties,
  with result types including `record`. One record datastream per sensor (FR-24) holds.
- **The datastream schema endpoint exists**: `GET /datastreams/{id}/schema`.
- **Control streams, commands and command status exist** in Part 2, as FR-26 assumes.
- **System events exist**, with standard types including Calibration,
  ConfigurationChange, PartReplacement, SoftwareUpdate and Decommission.
- **Stateless discovery is the norm.** Nothing in CS needs a session (FR-06).

## 3. Corrections the SRD needs

1. **"Process" is not a system type.** `systemType` is required and takes one of five
   SOSA values: **Sensor, Actuator, Sampler, Platform, System**. "Process" is a value of
   the optional `assetType` (alongside Equipment, Human, Simulation and others). The
   analysis service and promoted products are therefore `systemType: System`,
   `assetType: Process`. The barge is a **Platform**; bow and stern are **Sensors**.
2. **The schema endpoint requires `obsFormat`.** `GET /datastreams/{id}/schema?obsFormat=…`
   must name a media type (URL-encoded). For `application/json` it returns a
   `resultSchema`; for SWE formats, a SWE Common component tree with an `encoding`.
3. **Media types.** SWE Common JSON is `application/swe+json`, with
   `application/vnd.ogc.swe+json` recommended as a preliminary type "until SWE Common 3.0
   is stable". SWE Common 3.0 is now published, so the demonstrator should serve
   `application/swe+json`. SWE Common Text is `application/swe+text`, not CSV.
4. **Per-value quality flags are separate fields.** In SWE Common 3.0 a component's
   `quality` attribute describes that component's quality; when quality varies per
   value, "the quality value is in fact carried by another component of the dataset".
   QC flags are therefore **separate Category fields** in each sensor's record (one per
   parameter), using the QARTOD flag vocabulary, with each measurement's `quality`
   attribute pointing at its flag field.
5. **Observation filters are narrower than assumed.** Observations support
   `phenomenonTime`, `resultTime` (including the special value `latest`), `foi` and
   `limit`. There is **no `observedProperty` filter on observations**, so a client fetches
   whole records and picks fields. Polling uses `phenomenonTime={last}/..`.
6. **Commands are created by POST** to `/controlstreams/{csId}/commands`, which belongs to
   Part 2's **Create/Replace/Delete** class. A command that does not match its control
   stream's schema is rejected with **HTTP 400**. Bounds therefore belong **in the control
   stream's schema** as SWE Common constraints, which is also what lets the client draw
   its controls from the schema (FR-60). Accepted commands carry a status
   (PENDING … COMPLETED, FAILED, REJECTED).
7. **Promotion is standard resource creation.** A scientist's script registers a product
   by POSTing a System (Part 1 Create/Replace/Delete), a datastream under it, and
   observations (Part 2 Create/Replace/Delete). This needs no invented mechanism, but it
   puts creation classes into the subset.
8. **Changing a datastream's schema is a breaking change.** Part 2 rejects a
   schema-changing replacement with HTTP 409. A field toggle (FR-46b) that changes a
   sensor's record schema should therefore produce a **datastream with a new identifier**,
   not the same identifier with a new schema. The server can still serve the full
   history under the new identifier, because the history comes from the store.
9. **The subset carries prerequisites.** Part 1 extends **OGC API – Features Part 1 (Core)**
   and **OGC API – Common Part 1**, and uses Features Part 4 for creation. A conforming
   server therefore also provides a landing page, a conformance declaration, an API
   definition, `/collections`, paging links, and the `limit` and `datetime` parameters.
   Neither part has a Core class; an implementation must offer at least one resource
   type and one encoding.

## 4. The declared subset (proposed)

| Part | Class | Why |
|---|---|---|
| Common / Features Core | Landing page, conformance, API definition, collections, paging | Prerequisite |
| Part 1 | Common, System Features, Subsystems | Barge with bow and stern sensors; process systems |
| Part 1 | Property Definitions | Defines the seven parameters and derived quantities |
| Part 1 | Create/Replace/Delete (systems only) | Promotion (correction 7) |
| Part 1 | SensorML encoding | Non-spatial systems; GeoJSON with null geometry is also valid but less natural |
| Part 2 | Common, Datastreams and Observations | Core of the data path |
| Part 2 | Control Streams and Commands | Analysis settings |
| Part 2 | Create/Replace/Delete (datastreams, observations, commands) | Promotion and commands |
| Part 2 | System Events (read) | Optional: server start and field changes as ConfigurationChange events |
| Part 2 | JSON and SWE Common JSON encodings | Discovery in JSON; observations in SWE JSON |
| — | **Not implemented** | Deployments, Procedures, Sampling Features, Advanced Filtering beyond time, Update, Feasibility, SWE Text and Binary, Part 3 |

Every class not implemented is refused by name (FR-27).

## 5. Pub/sub

Part 3 is unpublished. An AsyncAPI document and MQTT and AMQP bindings are in
progress. **Polling stays** (FR-63) and the SRD's open question stands, now with a
concrete trigger: revisit when Part 3 is published.

## 6. Tooling

| Tool | Kind | Language | Relevance |
|---|---|---|---|
| OpenSensorHub | Server, Parts 1 and 2 | Java | Most complete; the reference community |
| connected-systems-go | Server, Parts 1 and 2 | Go | Independent second implementation |
| 52°North connected-systems-pygeoapi | Server | Python | **Proof of concept** on pygeoapi; Apache 2.0; needs Elasticsearch or a database backend, so not usable in Pyodide as it stands |
| OSHConnect-Python | Client | Python | Claims Parts 1, 2 and 3 |
| TypeScript and C++ client libraries | Client | TS, C++ | Listed on the developer site |
| OGC CSAPI Explorer | Reference browser client | — | **An independent check of our server** |

Implications:

- **There is no off-the-shelf Python server that runs in Pyodide.** The SRD's choice to
  write the subset directly on FastAPI (FR-65) stands. The 52°North proof of concept is a
  useful reference for mapping, and links CS to pygeoapi, where you already contribute.
- **Independent clients exist.** Running the CPython build of the server (AT-02) and
  browsing it with the **OGC CSAPI Explorer** and **OSHConnect-Python** gives evidence that
  the subset is genuine CS, not CS-shaped. This is cheap, strong evidence for the
  low-risk argument.

## 7. Risks found

| Risk | Rating | Treatment |
|---|---|---|
| Young ecosystem: few implementations, little tutorial material, stale repository labels | Medium | Declared subset; independent-client test; ADR records the choice and a fallback to SensorThings |
| Subset larger than the SRD implied (Features and Common prerequisites, creation classes) | Low–medium | Size it in the plan; most of it is small and mechanical |
| SWE Common 3.0 is new and not backward compatible with 2.0 | Low | Use 3.0 only; validate against the published schemas |
| No pub/sub standard yet | Low | Polling placeholder, as already planned |
| No CITE test suite confirmed | Unknown | Not found in this spike; check before claiming conformance |

## 8. Recommendation

Proceed with Connected Systems on FastAPI, with the subset in §4 recorded in an ADR, the
nine corrections applied to the SRD, and an acceptance test in which independent CS
clients browse the server.

## Sources

- [CS Part 1, 23-001](https://docs.ogc.org/is/23-001/23-001.html)
- [CS Part 2, 23-002](https://docs.ogc.org/is/23-002/23-002.html)
- [SWE Common Data Model 3.0, 24-014](https://docs.ogc.org/is/24-014/24-014.html)
- [OGC API – Connected Systems standard page](https://www.ogc.org/standards/ogc-api-connected-systems/)
- [OGC announcement of publication](https://www.ogc.org/ogc-announces-publication-of-ogc-api-connected-systems-and-updates-to-supporting-standards/)
- [OGC Connected Systems repository](https://github.com/opengeospatial/ogcapi-connected-systems)
- [Connected Systems developer site](https://csapi.developer.ogc.org/)
- [52°North connected-systems-pygeoapi](https://github.com/52North/connected-systems-pygeoapi)
- [OSHConnect-Python](https://botts-innovative-research.github.io/OSHConnect-Python/)
