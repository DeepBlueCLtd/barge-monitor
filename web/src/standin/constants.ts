// Declared constants of the stand-in back end. Each one mirrors the Python
// reference (backend/barge/config.py, dialect.py): PR-06, the Python back end
// is the reference, so a constant that differs here is a stand-in bug.

/** Simulation epoch, 2031-04-07T00:00:00Z (config.SIM_EPOCH_UNIX). */
export const SIM_EPOCH_UNIX = 1933286400;
/** The CSV dialect's epoch, 1994-01-01T00:00:00Z, counted in half-seconds (dialect.py, FR-17). */
export const LOGGER_EPOCH_UNIX = 757382400;
export const SENSORS = ['bow', 'stern'] as const;
export type Sensor = (typeof SENSORS)[number];

// --- Connected Systems server (FR-25, FR-30, FR-47) ---------------------------------
export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 100_000;

// --- CSV importer (interfaces §5, §7) ----------------------------------------------------
/** One knot in m/s: the dialect writes apparent wind speed in knots (dialect.KNOT). */
export const KNOT = 0.514444;
/** One captured bulk-write message per this many rows (config.ROWS_PER_MESSAGE, FR-67). */
export const BULK_ROWS = 1000;

// --- Models (FR-33..FR-37) ------------------------------------------------------------

export const SOSA = 'http://www.w3.org/ns/sosa/';
export const URN = 'urn:x-barge:';
export const DEF = 'https://deepbluecltd.github.io/barge-monitor/def/';
export const PROFILE_URI = 'https://deepbluecltd.github.io/barge-monitor/profile/v4';
