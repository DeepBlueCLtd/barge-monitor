"""Is a unit code UCUM? (D-195)

OpenSensorHub checks every ``uom.code`` in a datastream's or control stream's schema against
UCUM, strictly, and refuses the resource otherwise (400 "Invalid UCUM code 'ppm'"). The stand-ins
refuse the same codes, so that a client's slip shows in the browser and not only against
OpenSensorHub. This is UCUM's grammar (products, quotients, exponents, factors, parentheses,
annotations) over the atoms a weather or process model plausibly uses; an atom outside that table
is refused, as an unknown atom is by OpenSensorHub. The twin is ``web/src/standin/ucum.ts``.
"""
from __future__ import annotations

import re

PREFIXES = ("da", "Ki", "Mi", "Gi", "Ti", "Y", "Z", "E", "P", "T", "G", "M", "k", "h", "d", "c", "m", "u", "n", "p",
            "f", "a", "z", "y")
# Atoms that take a metric prefix.
METRIC = {
    "m", "s", "g", "rad", "K", "cd", "C", "mol", "sr", "Hz", "N", "Pa", "J", "W", "A", "V", "F", "Ohm", "S", "Wb",
    "Cel", "T", "H", "lm", "lx", "Bq", "Gy", "Sv", "l", "L", "ar", "t", "bar", "u", "eV", "pc", "gf", "Ky", "Gal",
    "dyn", "erg", "P", "St", "Mx", "G", "Oe", "Gb", "sb", "Lmb", "ph", "Ci", "R", "RAD", "REM", "cal", "bit", "By",
    "Bd", "mho", "osm", "eq", "B", "Np", "m[Hg]", "m[H2O]", "B[SPL]", "B[V]", "B[mV]", "B[uV]", "B[W]", "B[kW]",
    "[iU]", "[IU]", "Ao", "b", "mo_s",
}
# Atoms that do not.
PLAIN = {
    "10*", "10^", "[pi]", "%", "[ppth]", "[ppm]", "[ppb]", "[pptr]", "min", "h", "d", "a", "wk", "mo", "a_t", "a_j",
    "a_g", "mo_j", "mo_g", "deg", "gon", "'", "''", "[degF]", "[degR]", "[degRe]", "atm", "[psi]", "[in_i]",
    "[ft_i]", "[yd_i]", "[mi_i]", "[nmi_i]", "[kn_i]", "[lb_av]", "[oz_av]", "[gal_us]", "[gal_br]", "[mi_us]",
    "[ft_us]", "[in_i'Hg]", "[in_i'H2O]", "[Btu]", "[HP]", "[pH]", "[S]", "[hp'_X]", "[beaufort]", "Np", "B",
    "[knk'U]", "[acr_us]", "[sft_i]", "[sin_i]", "[cft_i]", "[cin_i]", "[cyd_i]", "[mil_i]", "[ly]", "[c]", "[h]",
    "[k]", "[e]", "[G]", "[g]", "[m_e]", "[m_p]", "[eps_0]", "[mu_0]", "AU", "tex", "[den]", "[car_m]", "[car_Au]",
}
_EXP = re.compile(r"^(.*?)([+-]?\d+)$")


def _simple(s: str) -> bool:
    if s in PLAIN or s in METRIC:
        return True
    return any(s.startswith(p) and s[len(p):] in METRIC for p in PREFIXES)


def _component(s: str) -> bool:
    s = re.sub(r"\{[^{}]*\}$", "", s) if s.endswith("}") else s
    if s == "":
        return True  # an annotation alone
    if s.isdigit():
        return True  # a factor
    if _simple(s):
        return True
    m = _EXP.match(s)
    return bool(m and m.group(1) and _simple(m.group(1)))


def is_ucum(code) -> bool:
    if not isinstance(code, str) or not code or any(c.isspace() for c in code):
        return False

    def term(s: str) -> bool:
        if s.startswith("/"):
            s = s[1:]
        parts, depth, brace, cur = [], 0, False, ""
        for ch in s:
            if brace:
                brace = ch != "}"
                cur += ch
                continue
            if ch == "{":
                brace = True
            elif ch == "(":
                depth += 1
            elif ch == ")":
                depth -= 1
                if depth < 0:
                    return False
            if depth == 0 and ch in "./":
                parts.append(cur)
                cur = ""
                continue
            cur += ch
        if depth or brace:
            return False
        parts.append(cur)
        for p in parts:
            if p.startswith("(") and p.endswith(")"):
                if not term(p[1:-1]):
                    return False
            elif "(" in p or ")" in p or not p or not _component(p):
                return False
        return True

    return term(code)


def bad_codes(x) -> list[str]:
    """Every ``uom.code`` in a schema (any depth) that is not UCUM."""
    out: list[str] = []

    def walk(v):
        if isinstance(v, dict):
            u = v.get("uom")
            if isinstance(u, dict) and "code" in u and not is_ucum(u["code"]):
                out.append(str(u["code"]))
            for w in v.values():
                walk(w)
        elif isinstance(v, list):
            for w in v:
                walk(w)
    walk(x)
    return out
