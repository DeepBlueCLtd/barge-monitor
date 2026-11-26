# ADR 0006: Replay is a controller on the data server, driven by commands

**Status:** accepted, 2026-11-26 (SRD 4.6 FR-86..FR-90, interfaces §8; decisions D-125, D-126, D-129, D-131, D-136).

**Context.** From 4.5 the demonstrator replays recorded missions instead of simulating a
live boat. Something must own replay time. If each client kept its own clock, the models
and every display would disagree on "now", and models could not be held to one rate.

**Decision.**

1. A **replay controller** is a system on the data server (`urn:x-barge:replay`). It is
   controlled only through its `replay` **control stream** (`load`, `play`, `pause`,
   `seek`, with dataset, rate and position). It publishes a `state` datastream (dataset,
   time, rate, playing, `models_ready`) and a `log`.
2. Replay time is **absolute UTC, as in each file** (D-125). Each load starts a run
   `r-<dataset>-<n>`; the display client shows the latest run on its return to a dataset.
3. Rates are 0.1, 0.5, 1, 10 and 100×, **bounded by the slowest model's declared
   `max_rate`**. A rate above it is rejected, naming the bound and the model.
4. Models process **whole windows aligned to the dataset's start**, up to the replay time
   (D-126, D-129: `[t0, t1)`), so results are the same at any rate (AT-34). A model that
   has not registered for a dataset within `MODEL_READY_TIMEOUT_S` is skipped and named in
   the log (D-131).
5. The display client polls `state` once per real second, and never holds a clock.

**Consequences.** Every client sees one time. Rates are honest about model speed. A paused
client polls nothing, so it does not notice a server restart until it plays again
(FR-63a). The stand-in's illustrative models use `(t0, t1]` windows; parity is required of
the Python models only.

**Alternatives.** A client-side clock (rejected: there is no shared "now"). Server-sent
time over a push subscription (rejected: only service accounts subscribe, D-147).
