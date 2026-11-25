"""Declared constants of the demonstrator (SRD Version 4.6).

Bounds, limits and budgets are declared here once. Clients never hold bounds of
their own: they read them from the server's schemas.
"""

GENERATOR_VERSION = "4.0.0"

# --- Declared fictional location (FR-01) ---------------------------------
# Used only to place the diurnal cycle and to draw the canal for scoring; the barge
# records no position (FR-10).
ORIGIN_LAT = -1.25
ORIGIN_LON = -24.75

# The world's epoch: a fictional future date. The world (world.py, truth.py) counts
# seconds from here; everything served is absolute UTC (docs/v4-interfaces.md §4):
# world seconds = Unix seconds - SIM_EPOCH_UNIX.
SIM_EPOCH_ISO = "2031-04-07T00:00:00Z"
SIM_EPOCH_UNIX = 1933286400

RUN_DAYS = 35  # the timetable is declared beyond the data folder's 21 days

# --- Boat ------------------------------------------------------------------
SENSOR_SEPARATION_M = 20.0
SPEED_LIMIT_MS = 2.0
CRUISE_SPEED_MS = 1.8
SLOW_SPEED_MS = 0.9

# --- Connected Systems server (FR-26, FR-30, FR-31) ---------------------------
DEFAULT_LIMIT = 1000  # observations per page when no limit is given
MAX_LIMIT = 100_000  # declared; a larger limit is served, not refused (docs/v4-interfaces.md §9.1)
QUERY_BUDGET_MS = {  # FR-31 declared queries (AT-04)
    "last-hour-each-sensor": 1500,  # raw records of both sensors, the last hour at replay time
    "one-field-whole-dataset-summary": 1000,  # one field over a whole dataset, from a summary datastream
}
START_S = 1.0  # a server start refuses connections for about this long (§9.1)
COMMAND_HOLD_S = 5.0  # the sender's POST of a command is answered after this long (§9.1)

# --- Replay (FR-86) ----------------------------------------------------------------
RATES = [0.1, 0.5, 1.0, 10.0, 100.0]
STATE_EVERY_S = 1.0  # real seconds between state observations while playing
MODEL_READY_TIMEOUT_S = 10.0  # a model that has not registered for a dataset by then is skipped

# --- Import (FR-67) -------------------------------------------------------------------
ROWS_PER_MESSAGE = 1000  # one I message per thousand rows written
