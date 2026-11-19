# ADR 0002: One EDR collection per sensor

**Status:** accepted, 2026-11-19 (answers the SRD §10 open question)

**Context.** Bow and stern sensors are 20 m apart. CoverageJSON trajectory
coverages have one domain: a position and time per point.

**Decision.** Collections `bow` and `stern`, each a trajectory. Analysis
results are further collections (`analysis-*`) in the same shape.

**Consequences.** A client wanting both sensors makes two requests. Bow and
stern positions stay honest; lag correction (FR-20) is meaningful precisely
because the positions differ.
