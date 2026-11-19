# ADR 0001: The backend is a plain ASGI application

**Status:** accepted, 2026-11-19

**Context.** NFR-03 requires the backend to run unchanged under an ordinary ASGI
server. It also runs in Pyodide, where every package is a download.

**Decision.** `barge.edr.App` is a plain ASGI callable with a small router, no
framework. In the browser, `barge.bridge.Bridge` builds an ASGI scope and awaits
the app exactly as a server would. Under CPython, `uvicorn --factory
barge.edr:app_factory` serves it.

**Consequences.** No framework to load in the browser; routing and query
validation are hand-written and must be tested (the contract suite does). If
the API grows substantially, Starlette (available in Pyodide) is the natural
step.
