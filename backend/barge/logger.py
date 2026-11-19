"""The logger stand-in (B-C05): a deliberately awkward, append-only store.

FR-13. This is how an old data logger's archive looks, not a tidy store with an
old label:

* fixed-width text records, one file per sensor per day (``BOW_YYYYMMDD.DAT``,
  ``STN_YYYYMMDD.DAT``), rolling over at midnight UTC;
* time as a count of **half-seconds since 1994-01-01T00:00:00Z** (the logger's
  epoch), ten zero-padded digits;
* position as a raw NMEA ``$GPGGA`` sentence, padded to a fixed width; inside
  the tunnel the receiver has no fix and the sentence carries empty fields;
* coded values: temperatures in tenths with ``M`` for minus (``M012`` is
  -1.2 °C), wind direction ``VRB`` when the wind is too light to have one,
  ``/`` filling a missing value;
* no index, and records are appended while being read. The logger flushes in
  chunks, so a reader can see the start of a record before its end.

FR-14: only the sensors write here and only the store adapter reads it.

Record layout (117 bytes including the newline)::

    0   10  ticks      half-seconds since the logger epoch
    11  1   status     A = normal
    13  70  position   $GPGGA sentence, space padded
    84  4   air T      tenths °C, METAR sign
    89  3   RH         whole %
    93  5   pressure   tenths hPa
    99  3   wind speed tenths m/s (apparent)
    103 3   wind dir   whole degrees relative to bow, or VRB
    107 4   solar      whole W/m²
    112 4   water T    tenths °C, METAR sign
"""
from __future__ import annotations

import datetime as _dt

from . import config as C

LOGGER_EPOCH_UNIX = 757382400  # 1994-01-01T00:00:00Z
TICKS_PER_SECOND = 2
REC_LEN = 117
GPS_WIDTH = 70
FILE_PREFIX = {"bow": "BOW", "stern": "STN"}
# Hold back this many bytes on each flush, so a reader sometimes sees a
# record that has started but not finished.
_FLUSH_HOLDBACK = 41

FIELDS = {  # name: (offset, width)
    "ticks": (0, 10),
    "status": (11, 1),
    "gps": (13, GPS_WIDTH),
    "air_temperature": (84, 4),
    "relative_humidity": (89, 3),
    "pressure": (93, 5),
    "apparent_wind_speed": (99, 3),
    "apparent_wind_direction": (103, 3),
    "solar_irradiance": (107, 4),
    "water_temperature": (112, 4),
}


def sim_to_ticks(t_sim: float) -> int:
    return int(round((C.SIM_EPOCH_UNIX + t_sim - LOGGER_EPOCH_UNIX) * TICKS_PER_SECOND))


def file_name(sensor: str, t_sim: float) -> str:
    d = _dt.datetime.fromtimestamp(C.SIM_EPOCH_UNIX + t_sim, tz=_dt.timezone.utc)
    return f"{FILE_PREFIX[sensor]}_{d:%Y%m%d}.DAT"


def _checksum(body: str) -> str:
    cs = 0
    for ch in body:
        cs ^= ord(ch)
    return f"{cs:02X}"


def gga(t_sim: float, lat: float | None, lon: float | None, alt: float) -> str:
    d = _dt.datetime.fromtimestamp(C.SIM_EPOCH_UNIX + t_sim, tz=_dt.timezone.utc)
    hms = f"{d:%H%M%S}.00"
    if lat is None:
        body = f"GPGGA,{hms},,,,,0,00,,,M,,M,,"
    else:
        la, lo = abs(lat), abs(lon)
        lat_s = f"{int(la):02d}{(la - int(la)) * 60:07.4f}"
        lon_s = f"{int(lo):03d}{(lo - int(lo)) * 60:07.4f}"
        body = (f"GPGGA,{hms},{lat_s},{'N' if lat >= 0 else 'S'},{lon_s},{'E' if lon >= 0 else 'W'},"
                f"1,08,0.9,{alt:05.1f},M,0.0,M,,")
    return f"${body}*{_checksum(body)}".ljust(GPS_WIDTH)


def _metar(v: float) -> str:
    if v != v:
        return "////"
    n = int(round(v * 10))
    return f"M{min(-n, 999):03d}" if n < 0 else f"{min(n, 9999):04d}"


def _int(v: float, width: int, scale: float = 1.0) -> str:
    if v != v:
        return "/" * width
    n = max(0, min(int(round(v * scale)), 10 ** width - 1))
    return f"{n:0{width}d}"


def format_record(t_sim, lat, lon, alt, values: dict, status: str = "A") -> str:
    wd = values["apparent_wind_direction"]
    ws = values["apparent_wind_speed"]
    wd_s = "VRB" if (ws == ws and ws < 0.5) else _int(wd % 360.0 if wd == wd else wd, 3)
    if wd_s == "360":
        wd_s = "000"
    rec = " ".join([
        f"{sim_to_ticks(t_sim):010d}",
        status,
        gga(t_sim, lat, lon, alt),
        _metar(values["air_temperature"]),
        _int(values["relative_humidity"], 3),
        _int(values["pressure"], 5, 10.0),
        _int(ws, 3, 10.0),
        wd_s,
        _int(values["solar_irradiance"], 4),
        _metar(values["water_temperature"]),
    ]) + "\n"
    assert len(rec) == REC_LEN, (len(rec), rec)
    return rec


class Logger:
    """In-memory files, append-only. See the module docstring for the format."""

    def __init__(self):
        self._files: dict[str, bytearray] = {}
        self._held: dict[str, bytes] = {}

    def append(self, name: str, data: bytes) -> None:
        buf = self._files.setdefault(name, bytearray())
        data = self._held.pop(name, b"") + data
        if len(data) > _FLUSH_HOLDBACK:
            buf += data[:-_FLUSH_HOLDBACK]
            self._held[name] = data[-_FLUSH_HOLDBACK:]
        else:
            self._held[name] = data

    def close(self, name: str) -> None:
        """A file is complete (day rollover): write out anything held back."""
        if name in self._held:
            self._files[name] += self._held.pop(name)

    def flush(self) -> None:
        for name, data in list(self._held.items()):
            self._files[name] += data
        self._held.clear()

    def list_files(self) -> list[tuple[str, int]]:
        return sorted((n, len(b)) for n, b in self._files.items())

    def read(self, name: str, offset: int = 0) -> bytes:
        return bytes(self._files[name][offset:])

    def total_bytes(self) -> int:
        return sum(len(b) for b in self._files.values())
