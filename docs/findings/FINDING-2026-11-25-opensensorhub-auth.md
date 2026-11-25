# Finding: authentication and permissions in a stock OpenSensorHub (S-AUTH, SRD 4.6 §15)

**Date:** 2026-11-25 · **Server:** OpenSensorHub `osh-core` 2.0.4, built from source at
commit `75bb094`, unmodified, with its own security realm (`BasicSecurityRealm`: users, roles,
permissions), HTTP Basic authentication, the admin UI, and Connected Systems endpoints with
access control and resource creation on · **Where:** one development machine, client and
server on the same host · **How:** `backend/spike/osh_auth_spike.py` in three phases (no deny
entries; deny entries on the restricted systems; deny entries also on their ancestors), each
against the configuration `backend/spike/osh-config-auth.json`, restarted between phases. The
record of the run is `backend/spike/auth-results.json`. Where a statement rests on reading the
source rather than on a request, it says **(source)**, with the class.

## Summary

OpenSensorHub's access control does **authentication and write ownership** well, and does
**not** do what FR-93 asks for reading.

- **Works, as shipped:** every request, discovery and WebSocket included, needs credentials
  (401 otherwise); roles are defined once and assigned to users; a user who creates a system
  is given ownership of it and of everything under it at once, so a workspace or a model's
  systems can be written only by their creator; a command records **who sent it** (`sender`,
  the user id), both in what is pushed to the receiver and in the stored command.
- **Does not work:** restricted systems are **never hidden**. Listings are permitted or refused
  whole and never filtered per item; a denied resource answers **403**, not 404; a deny on a
  system is **not inherited** by its datastreams and is overridden by any allowed ancestor;
  WebSocket streaming of observations is checked per server, not per datastream. Nor can a
  workspace be made unreadable to other users with role permissions.
- **A defect that blocks commands:** with access control on, **no command receiver can
  subscribe** to a control stream: the server closes the WebSocket (1011, "No user
  specified"). Receivers work only on a second endpoint with access control off, which any
  authenticated user can then read in full.
- **No session:** Basic authentication is checked on every request and the user's roles are
  looked up each time; nothing is cached in a cookie. A change takes effect on the next request.

The fallback §15 names for items 1 and 2 is needed: a **filtering gateway** in front of
OpenSensorHub. The gateway is also where the command-receiver defect is contained.

## The seven questions

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Restricted system hidden (absent from `/systems`, subsystems, `/datastreams`; 404 by id)? | **No.** Without a deny entry everything is listed and readable. With deny entries on the restricted systems (and on every ancestor's `parent=` form), the system by id answers **403**, against **404** for an id that does not exist, so its existence is revealed; it is still listed under its parent, in `/systems?searchMembers=true` and its datastreams in `/datastreams`; its datastream, observations and WebSocket stream stay readable. A second endpoint whose view excludes `urn:barge:restricted:*` hides the systems (404, absent from subsystems) but **not** their datastreams, observations, `searchMembers` listing or WebSocket stream | **Observed** (phases 1–3); why: **source** (`BaseResourceHandler.list` checks only the parent, `ConSysApiSecurity.hasPermission`) |
| 2 | Permissions per system inherited by subsystems, datastreams, control streams? | **Allows yes, denies no.** A permission on a system (`…/systems/{id}` and `…[parent={id}]`) reaches what is under it: a user who created a workspace could at once add a datastream to it and append to it. A **deny** is not inherited: denying the CO₂ analyser left its datastream readable, and an allowed ancestor re-grants a denied child unless every ancestor's `parent=` form is denied too | **Observed**; mechanism **source** (`ConSysApiSecurity.hasPermission` walks the ancestors and grants on the first allowed one) |
| 3 | Roles defined once, assigned without editing permissions? | **Yes.** Roles carry allow/deny lists; a user has a list of role ids. But permissions name resources by the **server-assigned id** (`csapi[*]/get/systems/041g`), so a role that restricts particular systems cannot be written before those systems exist, and has to be edited when they are created | **Observed** (config; five roles worked as written) |
| 4 | WebSocket credentials; does the receiver learn who sent a command? | Credentials only as an `Authorization: Basic` header on the upgrade request (401 without, 401 with a wrong password; query parameters are not accepted). The Python client turns `ws://user:pass@host/…` into that header. **Who sent:** yes, the **user id** in `sender`, in the pushed command and the stored one; **not the role**, and there is no API to look up a user's roles. **But** with access control on, a receiver on `/api` is closed at once (1011 "Permission denied: …/create/status: No user specified"), and the sender's POST answers 202 after 29.5 s. A receiver on `/api-internal` (access control off) got both commands, `sender` `emi` and `friend` | **Observed**; the defect's cause **source** (`CommandHandler.startRealTimeStream` checks a permission on the WebSocket thread, where no user is set). Browsers: **not determined** (not tried in a browser) |
| 5 | Admin UI: URL, can a non-technical owner manage users? | At **`/sensorhub/admin`** (Basic-authenticated; 200 for the owner, 403 for a viewer). Users are entries in the configuration form of the security module ("Security" tab): id, name, password, roles picked from the defined roles, and a permission tree. **There is no "disabled" flag**: to disable a user, remove the user, their roles or change their password. Passwords are stored in the configuration file in plain text unless written as Jetty `MD5:`/`CRYPT:` strings. Whoever may edit users may also edit roles and their permissions: account management and permission editing are the same right (update the module's configuration) | URL and access **observed**; the forms **source** (`AdminUI`, `BasicSecurityConfigForm`, `BasicSecurityRealmConfig`). Usability for a non-technical owner **not determined** |
| 6 | Answer without credentials; per-user workspaces? | **401**, `WWW-Authenticate: basic realm="OpenSensorHub: Authentication Required"`, `text/html` Jetty error page, no cookie, on the API, every endpoint and the admin UI; CORS preflight (`OPTIONS`) answers 200 without credentials. **Workspaces: half.** Creating a system makes the creator its owner (written to `user_permissions.json`, kept across restarts); others get 403 on appending or adding datastreams to it. But anyone whose role can read can **read** another's workspace (200), and a role that may create a top-level workspace may also create a subsystem **under any system** (201 under the platform) | **Observed** |
| 7 | Role change at once or at next login? Session? | **No session**: no `Set-Cookie`, and the next request without `Authorization` is 401. Credentials and the user's roles are looked up on **every request**, so a role change applied in the admin UI takes effect **on the next request**; there is no logout to force. A permission granted at run time (ownership) took effect on the very next request | Session **observed**; per-request lookup **source** (`OshLoginService.login`, `ModuleSecurity.setCurrentUser`); a role change through the admin UI **not observed** (the UI was not driven) |

## Consequences

**FR-93 (authentication and permissions).**
- "Valid credentials on every request and push subscription, 401 otherwise" — **met**, stock.
- "Per system, inherited by datastreams and control streams" — met for **granting**, not for
  restricting. Restricting needs an allow-list of every open resource by id, maintained as
  resources are created, and even that does not filter listings.
- "Absent, not refused" — **not met** by any stock configuration tried. A **filtering
  gateway** is required: it removes restricted systems and datastreams from every listing
  (`/systems`, subsystems, `searchMembers`, `/datastreams`, `/systems/{id}/datastreams`),
  answers 404 for them by id (and for their schema, observations and control streams), and
  refuses their WebSocket streams. It identifies restricted resources by **unique id prefix**
  (`urn:barge:restricted:`), not by server id, so it needs no per-install configuration.
- "Create and append only under their own workspace; service accounts only under their own
  systems" — **met for writing** by OpenSensorHub's ownership on creation, provided top-level
  system creation is the only create right a role has. "Under any system" is the leak: the
  gateway must also refuse creating subsystems under systems the user does not own.
- "No account may read another user's workspace" — **not met** stock; the gateway hides
  other users' workspaces (`urn:barge:open:ws:<user>`), by matching the user id in the unique id.

**FR-112a (rejecting a CO₂ command from a user without emissions).** The receiver learns the
**user id** from `sender`, never the role, and OpenSensorHub has no interface to look one up.

**FR-116 (role change at next login).** OpenSensorHub has no login and no session; a change
applies on the next request. "Logged out" has no meaning with Basic authentication.

**FR-117 (our own account screen).** The trigger is **likely met** on two counts, though the
trial with an owner was not run: (a) there is no "disable", and creating a user means editing a
generic configuration form beside a permission tree; (b) FR-115's "assigns roles but cannot
expose CO₂ by changing a permission" cannot hold: the same right edits users and role
permissions, and the realm restarts on every change (during which, by the source,
`SecurityManagerImpl.isAccessControlEnabled()` is false: not tested).

**FR-27 (commands pushed to receivers)** is affected too: receivers cannot connect where access
control is on. They connect to an internal endpoint with access control off, which must be
reachable only by service accounts: OpenSensorHub cannot restrict it to them (any
authenticated user reads everything there, observed), so the gateway must not route it and
OpenSensorHub's port must not be reachable except through the gateway.

## Recommended mechanisms

**FR-112a.** The receiver takes the sender's **user id** from the command's `sender` (stock,
observed) and resolves the **role** from the delivered user→role assignment, the same source
the gateway uses (OpenSensorHub's realm configuration, read-only). It never trusts a role
supplied by the client. Because the gateway already hides the restricted subsystem's sources
from a weather-only user, a command naming CO₂ from such a user can only come from a crafted
request, and is rejected `REJECTED` "a requested source is not available".
*Alternative without a role lookup:* a second control stream under the model's restricted
subsystem, hidden by the gateway; commands naming CO₂ are accepted only there. It works only
because of the gateway, and doubles the control streams.

**FR-116.** **Take effect at once, on the next request**, as OpenSensorHub does; drop "at next
login" and "logged out". The stand-in follows (PR-06): Basic authentication per request, no
session. The display client must treat a 401 as "credentials no longer valid" (back to the
login screen) and must re-run its handshake when a source disappears (404) mid-session, which
FR-118 already allows since it knows nothing of roles.

## Limits of this spike

- One version, one machine, Basic authentication only (not Digest, client certificates or an
  external authenticator); no TLS, so passwords travelled in clear on localhost.
- The admin UI was reached but **not driven**: creating a user, assigning a role, and a live
  role change were not done through it; what it offers comes from its source. No owner trial.
- WebSocket credentials were not tried from a **browser**. Browsers cannot set `Authorization`
  on a WebSocket; whether they reuse cached Basic credentials for the upgrade was not tested.
  The display client's own use of WebSockets (FR-02a) depends on it; through the gateway, the
  gateway can authenticate the browser some other way.
- System and datastream ids are separate spaces and the same string can name both (`041g` is
  the bow CO₂ analyser and the clusters datastream). One deny entry (`datastreams[parent=0410]`,
  meant for the bow's datastreams) therefore also matched the bow CO₂ datastream's schema
  check in phase 3, which is why that schema answered 403 while the datastream itself was 200.
- The realm restart window (access control off while the realm module restarts after an admin
  UI change) and the persistence of run-time ownership across an admin UI change were read in
  the source, not tested.
- The deny entries and the second-endpoint views are the stock mechanisms tried; a custom
  security module or authorizer (Java, loaded as an OpenSensorHub module) could filter
  differently, but would not be "OpenSensorHub as shipped", and listings would still not be
  filtered per item without changes to the Connected Systems service.
