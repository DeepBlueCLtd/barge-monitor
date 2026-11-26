# ADR 0009: Replay is the display client's own; models process each dataset on import

**Status:** accepted, 2026-11-26 (SRD 4.7 §8.6, FR-35, FR-35b, C4; interfaces §8 and §10.2;
decisions D-220, D-227, D-228). Supersedes ADR 0006.

**Context.** ADR 0006 put a replay controller on the data server: a system with a `replay`
control stream, a `state` datastream with `models_ready`, and a `log`. Models followed its
clock, and the slowest model bounded the rate. In the first 4.6 build this was the source
of much of the complexity: models racing the clock, a readiness handshake, a restart hold
(D-186), rate rejections, and one shared "now" for everyone. The owner's review asked for
replay to be managed in the client.

**Decision.**

1. **Each display client holds its own replay clock**: current dataset, time, rate, playing.
   Open, play, pause, rate and seek change only that clock; no command is sent.
2. **Models process each dataset as soon as it is imported**, the whole dataset, in fixed
   windows aligned to its start. They find datasets in the importer's catalogue.
3. Every model publishes **`runs__{ds}`** with each run's `status`, `done_until` and `pct`.
   The client shows the **latest complete run**, and says "results being prepared" while
   processing, reading `runs__{ds}` generically.
4. The client **reads only up to its replay time** (FR-63b), although the server holds the
   whole dataset and all its results.
5. Rates are 0.1, 0.5, 1, 10 and 100×, with **no model bound**.

**Consequences.**

* One component (the replay controller), one control stream, two datastreams and a service
  account are gone, and so are `models_ready`, `max_rate` and the restart hold.
* Results never depend on replay. AT-34 becomes "identical however processed".
* Several clients can replay the same dataset independently (AT-70). FR-89 (one analyst at a
  time) remains a demonstrator exclusion, but replay no longer depends on it.
* Results for a newly imported dataset arrive after processing finishes, not as replay
  reaches them. The client shows that.
* "Replay at any rate with standard commands" is no longer part of C4. Replay is ordinary
  client behaviour over standard reads.
* The models do more work at import: every model processes every dataset. That is a
  bounded, one-off cost per dataset.

**Alternatives.** Keep the replay controller (ADR 0006). The client sends its replay time to
the models as commands (rejected: two clients would conflict). Models run "live" as the
client plays (rejected: results would depend on each client's rate and position).
