# ADR 0008: A thin access gateway hides what a user may not see

**Status:** accepted, 2026-11-26 (SRD 4.6 FR-93, FR-112a, FR-116; interfaces §9.5; the
finding of 2026-11-25 on authentication; decisions D-147, D-150..D-153). Amends ADR 0005
item 1 ("used as shipped").

**Context.** FR-93 requires restricted systems (CO₂, the restricted analysis, other
users' workspaces) to be **absent**, not refused: not listed, and 404 by identifier. The
authentication spike found that OpenSensorHub refuses with 403 and lists the resource, and
that denies are not inherited.

**Decision.**

1. An **access gateway** sits in front of the data server and is drawn as a component of
   its own (`gateway`, New build · back end).
2. It filters by **unique-id prefix** (`urn:x-barge:sensor:*:co2`,
   `urn:x-barge:process:*:restricted`, other users' `workspace`s), from listings,
   subsystems and datastream listings, and answers **404** for a hidden resource asked for
   by id.
3. It reads the user's role **on every request**, so a role change takes effect at once
   (D-151, FR-116).
4. Only **service accounts** subscribe, and only to their own control streams (D-147).
5. A receiver learns a sender's role by looking up the command's `sender` user id (D-152).
6. It **strips `WWW-Authenticate`**, so the browser shows no native login dialog (D-153).

**Consequences.** OpenSensorHub is no longer "used as shipped" for access control: the
gateway is the second piece of our own code in front of it, alongside the importer module.
It is small and stateless apart from the role table, and it is tested by the shared
contract suite against both back ends. Field-level permission remains out of scope.

**Alternatives.** OpenSensorHub's own permissions (fail FR-93: refused, not hidden). A
custom security module inside OpenSensorHub (possible, but couples us to its internals as
the importer already does; revisit if the gateway's latency matters).
