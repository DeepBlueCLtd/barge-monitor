# ADR 0003: One shared, versioned Pyodide on GitHub Pages

**Status:** accepted, 2026-11-19

**Context.** NFR-06 requires Pyodide and all packages to be served by the site
itself. They total about 42 MB. PR-04 keeps every pull request's preview
permanently.

**Decision.** Publish Pyodide once per version at `pyodide/<version>/` at the
site root. Each build sets the relative path to it (`../pyodide/…` for the
root, `../../../pyodide/…` for `pr/N/demo/`). Every deploy republishes the
folder, so previews do not depend on `main`.

**Consequences.** Upgrading Pyodide adds a new folder; old previews keep
working. The path is configuration, still relative (FR-04).
