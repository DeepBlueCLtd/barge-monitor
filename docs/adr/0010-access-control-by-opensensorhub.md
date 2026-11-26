# ADR 0010: Access control is OpenSensorHub's own; no gateway of ours

**Status:** accepted, 2026-11-26 (SRD 4.7 FR-93, FR-118, C6, §15; interfaces §9.3 and §14;
decisions D-221 to D-226). Supersedes ADR 0008. Restores ADR 0005 item 1 ("used as
shipped") for access control.

**Context.** FR-93 in 4.6 required restricted resources (CO₂, restricted model outputs,
other users' workspaces) to be **absent** from discovery. Stock OpenSensorHub refuses them
with `403` but lists them (S-AUTH, 2026-11-25). ADR 0008 added an access gateway of our own
to hide them. It also bridged command subscriptions, stripped `WWW-Authenticate` and refused
`DELETE`. The owner's review withdrew the gateway: for now we trust OpenSensorHub's own
abilities. The owner is working with the OpenSensorHub team so that restricted resources
are not listed.

**Decision.**

1. Clients (the display client, the models and the importer) reach **OpenSensorHub
   directly**. There is no gateway component.
2. **FR-93 is relaxed:** a restricted resource is **listed and refused with `403`**. C6 is
   restated: other users can see that CO₂ sources exist, but never read them.
3. OpenSensorHub inherits grants but not denies, so restriction is an **allow-list**: each
   role is granted read on every open resource by id. The list is extended as imports and
   models create datastreams (D-222).
4. Receivers subscribe on the **internal endpoint** (`/api-internal`), because public
   subscriptions close with access control on (D-223).
5. The display client **leaves out any datastream whose schema answers `403`** (D-225). It
   keeps no list of restricted ids (AT-58).
6. Refusing `PUT`, `PATCH` and `DELETE`, and keeping the browser's login dialog away, become
   **configuration of the delivered server**, open with the OpenSensorHub team (D-224,
   D-226). The stand-ins behave as the configured server is expected to.

**Consequences.**

* C6 is weaker until OpenSensorHub hides restricted resources: their names and existence
  leak to users without access, though no data does.
* The access-control part of "used as shipped" holds again. The only code of ours touching
  the server is the importer module.
* Correctness now rests on configuration: an allow-list maintained at every import,
  refusing delete, refusing subsystems under others' systems, private workspaces, and an
  internal endpoint unreachable from outside (where any authenticated account reads
  everything). Each is listed in interfaces §14 and must be confirmed before a developed
  system relies on it.
* The stand-ins must not be stronger than OpenSensorHub (PR-05). Where they refuse delete
  or enforce workspaces ahead of confirmation, §14 says so.

**Alternatives.** Keep the gateway (ADR 0008). Hide restricted resources in the stand-ins
only (rejected: the stand-ins would claim more than OpenSensorHub does). Drop restrictions
entirely (rejected: C6 would go).
