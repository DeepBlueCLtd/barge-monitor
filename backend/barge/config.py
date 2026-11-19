"""Declared constants of the demonstrator.

Everything a reader or a test needs to know about bounds, limits and budgets is
declared here once. The display never holds bounds of its own (FR-34); it reads
them from the backend's statements, which are built from these values.
"""

GENERATOR_VERSION = "0.1.0"

# --- Declared fictional location (FR-01) ---------------------------------
# Open ocean in the equatorial Atlantic: no coordinate here is a place where
# anyone lives. The canal is drawn around this origin in local metres.
ORIGIN_LAT = -1.25
ORIGIN_LON = -24.75

# Simulation epoch: a fictional future date. Simulated time is UTC.
SIM_EPOCH_ISO = "2031-04-07T00:00:00Z"
SIM_EPOCH_UNIX = 1933286400  # seconds since 1970-01-01 for SIM_EPOCH_ISO

RUN_DAYS = 35  # the timetable is declared for five weeks

# --- Clock (FR-11) ---------------------------------------------------------
# Rate = simulated seconds per real second. 0 pauses. At the highest rate a
# week (604800 s) passes in 604800 / 600 = 1008 s, under an hour.
CLOCK_RATES = [0, 1, 10, 60, 180, 600]
CLOCK_DEFAULT_RATE = 60
# Warm start: the run begins this far into simulated time so the first view
# is not empty. The logger holds everything from t=0.
WARM_START_S = 3 * 3600
# A tick never generates more than this many simulated seconds; if the host
# falls behind (background tab), simulated time slips rather than bursts.
MAX_TICK_SIM_S = 1200

# --- Boat ------------------------------------------------------------------
SENSOR_SEPARATION_M = 20.0  # bow to stern, along the boat
SPEED_LIMIT_MS = 2.0
CRUISE_SPEED_MS = 1.8
SLOW_SPEED_MS = 0.9  # bridges and the tunnel

# --- EDR facade (FR-16..FR-19) ----------------------------------------------
MAX_RESPONSE_POINTS = 200_000  # per response (FR-18b)
TRAJECTORY_TOLERANCE_M = 75.0  # how far a reading may sit from a queried path
QUERY_BUDGET_MS = {  # FR-18a declared queries
    "last-hour-along-route": 1500,
    "one-reach-all-passes": 4000,
}

# --- Analysis bounds (FR-23); the service owns them ---------------------------
ANALYSIS_BOUNDS = {
    "window_hours": {"minimum": 0.25, "maximum": 168.0, "default": 12.0},
    "clusters": {"minimum": 2, "maximum": 8, "default": 4},
    "sensitivity": {"minimum": 1.0, "maximum": 10.0, "default": 5.0},
}
