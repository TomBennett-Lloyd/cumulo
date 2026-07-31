#!/usr/bin/env python3
"""Generate the pvlib golden reference fixtures for the TypeScript PV physics port.

ADR 0003 decides that the PV physics runs in TypeScript and that pvlib is the
correctness authority, used *offline*: this script is run by a human, on demand,
and its output — ``packages/forecast/fixtures/pvlib-golden.json`` — is committed.
pvlib is never installed in CI, never on the deploy path, and never at runtime.
Nothing under ``tools/`` is in any deployable's build graph.

Model pins (issue #12's plan fixes one variant per step so that the fixtures and
the port are the same physics; the exact calls are recorded verbatim in the
fixture file's ``provenance.models`` block):

* solar position   — ``pvlib.solarposition.spa_python`` (NREL SPA), delta_t=67.0 s,
                     altitude 0 m, pressure 101325 Pa, temperature 12 degC
* evaluation time  — ``validTime`` minus 30 minutes. Open-Meteo radiation values
                     are preceding-hour means (the average over the hour *ending*
                     at ``validTime``), so the solar geometry that represents that
                     hour is evaluated at its midpoint.
* extraterrestrial — ``pvlib.irradiance.get_extra_radiation`` method 'spencer',
                     solar constant 1366.1 W/m^2
* angle of incidence — ``pvlib.irradiance.aoi``
* transposition    — ``pvlib.irradiance.get_total_irradiance`` model 'haydavies'
                     (anisotropic sky diffuse) with isotropic ground reflection
                     from the case albedo
* cell temperature — ``pvlib.temperature.faiman`` u0=25.0, u1=6.84, with the 10 m
                     wind used unadjusted (a pinned v1 choice, not an assumption:
                     ADR 0003 flags the hub-height adjustment as needing a pin)
* DC power         — ``pvlib.pvsystem.pvwatts_dc`` gamma_pdc=-0.004/K, temp_ref
                     25 degC, pdc0 = nameplate DC capacity (capacityKw * 1000 W)
* AC power         — ``min(dcKw * 0.96, capacityKw)``; 0.96 is the PVWatts nominal
                     inverter efficiency and ``capacityKw`` is the clipping level

Determinism: output is UTF-8 JSON with ``indent=2``, ``sort_keys=True`` and a
trailing newline; cases are sorted by ``id``; floats are emitted at 12
significant digits (far below every ADR 0003 tolerance) so that a regeneration
diff is reviewable. Two runs with the same ``SOURCE_DATE_EPOCH`` on the same
pinned dependency set produce byte-identical files.

Usage::

    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
    SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) .venv/bin/python generate_fixtures.py

``SOURCE_DATE_EPOCH`` is taken from the commit being generated from, never
hardcoded: a literal epoch outlives the plan that chose it and ends up claiming
the fixtures were generated a year before the commit they record.

See README.md in this directory.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path

import numpy as np
import pandas as pd
import pvlib

# --- Pinned model constants -------------------------------------------------

SOLAR_CONSTANT_WM2 = 1366.1
DELTA_T_SECONDS = 67.0
SPA_ALTITUDE_M = 0.0
SPA_PRESSURE_PA = 101325.0
SPA_TEMPERATURE_C = 12.0
FAIMAN_U0 = 25.0
FAIMAN_U1 = 6.84
GAMMA_PDC_PER_C = -0.004
TEMP_REF_C = 25.0
INVERTER_EFFICIENCY = 0.96
EVALUATION_OFFSET_MINUTES = 30

# Synthetic clear-sky weather. Explicit rather than relying on pvlib's defaults,
# so that a future pvlib default change cannot silently move the inputs.
SOLIS_AOD700 = 0.1
SOLIS_PRECIPITABLE_WATER_CM = 1.0
SOLIS_PRESSURE_PA = 101325.0
SOLIS_DNI_EXTRA_WM2 = 1364.0

# Weather inputs are written to the fixture at this precision and the whole chain
# is computed from the rounded values, so the fixture records exactly what pvlib
# was given.
WEATHER_DECIMALS = 4
# Significant digits for computed outputs.
OUTPUT_SIG_DIGITS = 12

# `weatherReadingSchema` / `siteSchema` bounds in @cumulo/shared. The generator
# refuses to emit a case the TypeScript side could not parse.
IRRADIANCE_MAX_WM2 = 1500.0
TEMPERATURE_MIN_C = -90.0
TEMPERATURE_MAX_C = 60.0
WIND_MAX_MS = 120.0
CAPACITY_MAX_KW = 50.0

OUTPUT_PATH = (
    Path(__file__).resolve().parents[2]
    / "packages"
    / "forecast"
    / "fixtures"
    / "pvlib-golden.json"
)

# --- Case specification -----------------------------------------------------


@dataclass(frozen=True)
class CaseSpec:
    """One fixture case before the physics is run."""

    id: str
    description: str
    latitude: float
    longitude: float
    tilt_degrees: float
    azimuth_degrees: float
    valid_time: str
    temperature_2m_c: float
    wind_speed_10m_ms: float = 3.0
    capacity_kw: float = 4.0
    albedo: float = 0.2
    # How the irradiance triple is produced: {"mode": "clearsky"} (simplified
    # Solis at the evaluation instant, zero below the horizon), {"mode": "zero"},
    # {"mode": "fixed", "ghi": …, "dni": …, "dhi": …}, or {"mode": "beam",
    # "dni": …, "dhi": …} where GHI is derived as dhi + dni * cos(zenith).
    irradiance: dict[str, object] = field(default_factory=lambda: {"mode": "clearsky"})


GRID_SITES = (
    ("dublin", 53.3498, -6.2603),
    ("london", 51.5072, -0.1276),
    ("edinburgh", 55.9533, -3.1883),
)
GRID_DATES = ("2026-03-20", "2026-06-21", "2026-09-22", "2026-12-21")
GRID_HOURS = (4, 8, 10, 12, 16, 20)
GRID_GEOMETRIES = ((20.0, 90.0), (35.0, 180.0), (50.0, 270.0), (30.0, 135.0))
GRID_TEMPERATURES_C = {
    "2026-03-20": 8.0,
    "2026-06-21": 16.0,
    "2026-09-22": 13.0,
    "2026-12-21": 3.0,
}

POLAR_LAT, POLAR_LON = 68.5, 18.95
DUBLIN_LAT, DUBLIN_LON = 53.3498, -6.2603
LONDON_LAT, LONDON_LON = 51.5072, -0.1276
EDINBURGH_LAT, EDINBURGH_LON = 55.9533, -3.1883


def grid_cases() -> list[CaseSpec]:
    """The everyday domain: 3 sites x 4 dates x 6 hours x 4 geometries."""
    cases: list[CaseSpec] = []
    for slug, lat, lon in GRID_SITES:
        for date in GRID_DATES:
            for hour in GRID_HOURS:
                for tilt, azimuth in GRID_GEOMETRIES:
                    cases.append(
                        CaseSpec(
                            id=(
                                f"grid-{slug}-{date}-{hour:02d}00z"
                                f"-tilt{int(tilt):02d}-az{int(azimuth):03d}"
                            ),
                            description=(
                                f"{slug.capitalize()} {date} {hour:02d}:00Z, "
                                f"tilt {int(tilt)} deg azimuth {int(azimuth)} deg, "
                                "clear-sky irradiance"
                            ),
                            latitude=lat,
                            longitude=lon,
                            tilt_degrees=tilt,
                            azimuth_degrees=azimuth,
                            valid_time=f"{date}T{hour:02d}:00:00Z",
                            temperature_2m_c=GRID_TEMPERATURES_C[date],
                        )
                    )
    return cases


def edge_cases() -> list[CaseSpec]:
    """The edge cases ADR 0003 requires, plus the ones issue #12's plan names."""
    cases: list[CaseSpec] = [
        CaseSpec(
            id="edge-polar-low-sun",
            description="Polar latitude (68.5N) with a low summer sun — the regime where transposition error is largest",
            latitude=POLAR_LAT,
            longitude=POLAR_LON,
            tilt_degrees=35.0,
            azimuth_degrees=180.0,
            valid_time="2026-06-21T09:00:00Z",
            temperature_2m_c=10.0,
        ),
        CaseSpec(
            id="edge-midnight-sun",
            description="Midnight sun: 68.5N at local midnight on the solstice, sun above the horizon, outputs strictly positive",
            latitude=POLAR_LAT,
            longitude=POLAR_LON,
            tilt_degrees=35.0,
            azimuth_degrees=180.0,
            valid_time="2026-06-21T23:00:00Z",
            temperature_2m_c=8.0,
        ),
        CaseSpec(
            id="edge-night-mid-latitude",
            description="Ordinary night at a mid-latitude site — POA, DC and AC exactly zero, no negative POA",
            latitude=DUBLIN_LAT,
            longitude=DUBLIN_LON,
            tilt_degrees=35.0,
            azimuth_degrees=180.0,
            valid_time="2026-01-15T23:00:00Z",
            temperature_2m_c=5.0,
            irradiance={"mode": "zero"},
        ),
        CaseSpec(
            id="edge-twilight-diffuse",
            description="Twilight: diffuse-only sky with the sun below the horizon — beam exactly zero, sky diffuse positive",
            latitude=DUBLIN_LAT,
            longitude=DUBLIN_LON,
            tilt_degrees=35.0,
            azimuth_degrees=180.0,
            valid_time="2026-06-21T22:00:00Z",
            temperature_2m_c=12.0,
            irradiance={"mode": "fixed", "ghi": 5.0, "dni": 0.0, "dhi": 5.0},
        ),
        CaseSpec(
            id="edge-sun-behind-panel",
            description="Sun behind the panel (AOI > 90 deg on a north-facing vertical array) — beam exactly zero, sky and ground positive",
            latitude=DUBLIN_LAT,
            longitude=DUBLIN_LON,
            tilt_degrees=90.0,
            azimuth_degrees=0.0,
            valid_time="2026-06-21T12:00:00Z",
            temperature_2m_c=16.0,
        ),
        CaseSpec(
            id="edge-sunrise-boundary",
            description="Sunrise boundary hour: solar zenith close to 90 deg at the evaluation midpoint",
            latitude=DUBLIN_LAT,
            longitude=DUBLIN_LON,
            tilt_degrees=35.0,
            azimuth_degrees=180.0,
            valid_time="2026-03-20T07:00:00Z",
            temperature_2m_c=8.0,
        ),
        CaseSpec(
            id="edge-sunset-boundary",
            description="Sunset boundary hour: solar zenith close to 90 deg at the evaluation midpoint",
            latitude=DUBLIN_LAT,
            longitude=DUBLIN_LON,
            tilt_degrees=35.0,
            azimuth_degrees=180.0,
            valid_time="2026-03-20T19:00:00Z",
            temperature_2m_c=8.0,
        ),
        CaseSpec(
            id="edge-tilt-0",
            description="Geometric extreme the schema permits: horizontal array (tilt 0) — ground-reflected term exactly zero",
            latitude=LONDON_LAT,
            longitude=LONDON_LON,
            tilt_degrees=0.0,
            azimuth_degrees=180.0,
            valid_time="2026-06-21T12:00:00Z",
            temperature_2m_c=18.0,
        ),
        CaseSpec(
            id="edge-tilt-90-south",
            description="Geometric extreme the schema permits: vertical south-facing array",
            latitude=LONDON_LAT,
            longitude=LONDON_LON,
            tilt_degrees=90.0,
            azimuth_degrees=180.0,
            valid_time="2026-06-21T12:00:00Z",
            temperature_2m_c=18.0,
        ),
        CaseSpec(
            id="edge-tilt-90-north",
            description="Geometric extreme the schema permits: vertical north-facing array",
            latitude=LONDON_LAT,
            longitude=LONDON_LON,
            tilt_degrees=90.0,
            azimuth_degrees=0.0,
            valid_time="2026-06-21T12:00:00Z",
            temperature_2m_c=18.0,
        ),
        CaseSpec(
            id="edge-southern-hemisphere",
            description="Southern hemisphere (Melbourne) with a north-facing array — exercises the clockwise-from-north azimuth convention in both hemispheres",
            latitude=-37.8136,
            longitude=144.9631,
            tilt_degrees=30.0,
            azimuth_degrees=0.0,
            valid_time="2026-01-15T02:00:00Z",
            temperature_2m_c=24.0,
        ),
        CaseSpec(
            id="edge-equator-equinox-noon",
            description="Near-overhead sun at the equator around an equinox, where solar azimuth changes fast and can flip",
            latitude=0.0,
            longitude=0.0,
            tilt_degrees=10.0,
            azimuth_degrees=90.0,
            valid_time="2026-03-20T12:00:00Z",
            temperature_2m_c=28.0,
        ),
        CaseSpec(
            id="edge-clipping",
            description="Inverter clipping: DC x 0.96 exceeds nameplate, so AC is exactly capacityKw",
            latitude=EDINBURGH_LAT,
            longitude=EDINBURGH_LON,
            tilt_degrees=35.0,
            azimuth_degrees=180.0,
            valid_time="2026-04-15T12:00:00Z",
            temperature_2m_c=2.0,
            wind_speed_10m_ms=6.0,
            capacity_kw=2.0,
            irradiance={"mode": "beam", "dni": 900.0, "dhi": 120.0},
        ),
        CaseSpec(
            id="edge-snow-albedo",
            description="High ground albedo (snow, 0.8) — the ground-reflected term is the one most often dropped silently",
            latitude=EDINBURGH_LAT,
            longitude=EDINBURGH_LON,
            tilt_degrees=50.0,
            azimuth_degrees=180.0,
            valid_time="2026-12-21T12:00:00Z",
            temperature_2m_c=-2.0,
            albedo=0.8,
        ),
        CaseSpec(
            id="edge-anisotropy-above-one",
            description=(
                "Anisotropy index above 1: DNI (1450) exceeds the early-January "
                "extraterrestrial normal irradiance, as noisy measured data can, so the "
                "Hay-Davies isotropic sky term is negative before clipping — pvlib clips "
                "each sky component at zero separately, and a port that clipped only "
                "their sum would agree everywhere else"
            ),
            latitude=0.0,
            longitude=0.0,
            tilt_degrees=20.0,
            azimuth_degrees=180.0,
            valid_time="2026-01-05T12:30:00Z",
            temperature_2m_c=25.0,
            irradiance={"mode": "fixed", "ghi": 1460.0, "dni": 1450.0, "dhi": 120.0},
        ),
    ]

    # Polar winter night: a whole day where the sun never rises. Exactly zero
    # throughout, every hour.
    for hour in range(24):
        cases.append(
            CaseSpec(
                id=f"edge-polar-winter-night-h{hour:02d}",
                description=f"Polar winter night at 68.5N, {hour:02d}:00Z — sun never rises, POA/DC/AC exactly zero",
                latitude=POLAR_LAT,
                longitude=POLAR_LON,
                tilt_degrees=35.0,
                azimuth_degrees=180.0,
                valid_time=f"2026-12-21T{hour:02d}:00:00Z",
                temperature_2m_c=-5.0,
                irradiance={"mode": "zero"},
            )
        )

    # Ireland's clock change (2026-03-29, UTC+0 -> UTC+1 at 01:00 UTC). The
    # physics is a function of the instant alone; these four cases straddle the
    # transition in UTC and must show nothing unusual.
    for hour, mode, temperature in (
        (1, {"mode": "zero"}, 5.0),
        (2, {"mode": "zero"}, 5.0),
        (11, {"mode": "clearsky"}, 9.0),
        (12, {"mode": "clearsky"}, 10.0),
    ):
        cases.append(
            CaseSpec(
                id=f"edge-dst-h{hour:02d}",
                description=f"Ireland clock change 2026-03-29 {hour:02d}:00Z — local offset shifts, the instant does not",
                latitude=DUBLIN_LAT,
                longitude=DUBLIN_LON,
                tilt_degrees=35.0,
                azimuth_degrees=180.0,
                valid_time=f"2026-03-29T{hour:02d}:00:00Z",
                temperature_2m_c=temperature,
                irradiance=mode,
            )
        )

    return cases


REQUIRED_EDGE_IDS = frozenset(
    {
        "edge-polar-low-sun",
        "edge-midnight-sun",
        "edge-night-mid-latitude",
        "edge-twilight-diffuse",
        "edge-sun-behind-panel",
        "edge-sunrise-boundary",
        "edge-sunset-boundary",
        "edge-tilt-0",
        "edge-tilt-90-south",
        "edge-tilt-90-north",
        "edge-southern-hemisphere",
        "edge-equator-equinox-noon",
        "edge-clipping",
        "edge-snow-albedo",
        "edge-anisotropy-above-one",
        "edge-dst-h01",
        "edge-dst-h02",
        "edge-dst-h11",
        "edge-dst-h12",
    }
    | {f"edge-polar-winter-night-h{hour:02d}" for hour in range(24)}
)

# --- Numeric helpers --------------------------------------------------------


def to_float(value: object) -> float:
    """Unwrap a numpy/pandas scalar to a plain float, normalising -0.0 to 0.0.

    A negative zero would serialise as ``-0.0`` and fail the TypeScript side's
    exact-zero assertions (ADR 0003: zero is a correctness property, never a
    tolerance). ``+ 0.0`` is the identity for every other float.
    """
    result = float(np.asarray(value).item()) + 0.0
    if not math.isfinite(result):
        raise ValueError(f"non-finite value in fixture chain: {value!r}")
    return result


def round_output(value: float) -> float:
    """Round to OUTPUT_SIG_DIGITS significant digits for a reviewable diff.

    Significant digits rather than decimal places: rounding a genuinely tiny
    value to zero would turn a tolerance comparison into an exact-zero assertion
    on the TypeScript side and manufacture a failure. Exact zeros stay exact.
    """
    return float(f"{value:.{OUTPUT_SIG_DIGITS}g}") + 0.0


def round_weather(value: float) -> float:
    return round(value, WEATHER_DECIMALS) + 0.0


def evaluation_instant(valid_time: str) -> pd.Timestamp:
    """``validTime`` minus 30 minutes — the midpoint of the hour the means cover."""
    return pd.Timestamp(valid_time) - pd.Timedelta(minutes=EVALUATION_OFFSET_MINUTES)


# --- The chain --------------------------------------------------------------


def compute_case(spec: CaseSpec) -> dict[str, object]:
    """Run the pinned pvlib chain for one case and return its JSON object."""
    instant = evaluation_instant(spec.valid_time)
    times = pd.DatetimeIndex([instant])

    solar_position = pvlib.solarposition.spa_python(
        times,
        spec.latitude,
        spec.longitude,
        altitude=SPA_ALTITUDE_M,
        pressure=SPA_PRESSURE_PA,
        temperature=SPA_TEMPERATURE_C,
        delta_t=DELTA_T_SECONDS,
    )
    apparent_zenith = to_float(solar_position["apparent_zenith"].iloc[0])
    solar_azimuth = to_float(solar_position["azimuth"].iloc[0])

    dni_extra = to_float(
        np.asarray(
            pvlib.irradiance.get_extra_radiation(
                times, method="spencer", solar_constant=SOLAR_CONSTANT_WM2
            )
        )[0]
    )

    ghi, dni, dhi = weather_irradiance(spec, apparent_zenith)

    aoi = to_float(
        pvlib.irradiance.aoi(
            spec.tilt_degrees, spec.azimuth_degrees, apparent_zenith, solar_azimuth
        )
    )

    total = pvlib.irradiance.get_total_irradiance(
        spec.tilt_degrees,
        spec.azimuth_degrees,
        apparent_zenith,
        solar_azimuth,
        dni=dni,
        ghi=ghi,
        dhi=dhi,
        dni_extra=dni_extra,
        albedo=spec.albedo,
        model="haydavies",
    )
    poa_beam = to_float(total["poa_direct"])
    poa_sky_diffuse = to_float(total["poa_sky_diffuse"])
    poa_ground = to_float(total["poa_ground_diffuse"])
    poa_total = to_float(total["poa_global"])

    cell_temperature = to_float(
        pvlib.temperature.faiman(
            poa_total,
            spec.temperature_2m_c,
            spec.wind_speed_10m_ms,
            u0=FAIMAN_U0,
            u1=FAIMAN_U1,
        )
    )

    dc_power_kw = (
        to_float(
            pvlib.pvsystem.pvwatts_dc(
                poa_total,
                cell_temperature,
                pdc0=spec.capacity_kw * 1000.0,
                gamma_pdc=GAMMA_PDC_PER_C,
                temp_ref=TEMP_REF_C,
            )
        )
        / 1000.0
    )
    ac_power_kw = min(dc_power_kw * INVERTER_EFFICIENCY, spec.capacity_kw)

    case = {
        "id": spec.id,
        "description": spec.description,
        "site": {
            "latitude": spec.latitude,
            "longitude": spec.longitude,
            "tiltDegrees": spec.tilt_degrees,
            "azimuthDegrees": spec.azimuth_degrees,
            "capacityKw": spec.capacity_kw,
        },
        "validTime": spec.valid_time,
        "weather": {
            "ghiWm2": ghi,
            "dniWm2": dni,
            "dhiWm2": dhi,
            "temperature2mC": spec.temperature_2m_c,
            "windSpeed10mMs": spec.wind_speed_10m_ms,
        },
        "params": {"albedo": spec.albedo},
        "expected": {
            "apparentZenithDeg": round_output(apparent_zenith),
            "azimuthDeg": round_output(solar_azimuth),
            "aoiDeg": round_output(aoi),
            "poaBeamWm2": round_output(poa_beam),
            "poaSkyDiffuseWm2": round_output(poa_sky_diffuse),
            "poaGroundWm2": round_output(poa_ground),
            "poaTotalWm2": round_output(poa_total),
            "cellTemperatureC": round_output(cell_temperature),
            "dcPowerKw": round_output(dc_power_kw),
            "acPowerKw": round_output(ac_power_kw),
        },
    }
    check_case(spec, case, dni_extra)
    return case


def weather_irradiance(spec: CaseSpec, apparent_zenith: float) -> tuple[float, float, float]:
    """Produce the (GHI, DNI, DHI) triple this case feeds the transposition."""
    mode = spec.irradiance["mode"]
    if mode == "zero":
        return 0.0, 0.0, 0.0
    if mode == "fixed":
        return (
            round_weather(float(spec.irradiance["ghi"])),
            round_weather(float(spec.irradiance["dni"])),
            round_weather(float(spec.irradiance["dhi"])),
        )
    if mode == "beam":
        dni = round_weather(float(spec.irradiance["dni"]))
        dhi = round_weather(float(spec.irradiance["dhi"]))
        cos_zenith = max(math.cos(math.radians(apparent_zenith)), 0.0)
        return round_weather(dhi + dni * cos_zenith), dni, dhi
    if mode != "clearsky":
        raise ValueError(f"unknown irradiance mode: {mode!r}")

    apparent_elevation = 90.0 - apparent_zenith
    if apparent_elevation <= 0.0:
        # Sun below the horizon: an exact-zero case, not a near-zero one.
        return 0.0, 0.0, 0.0
    clearsky = pvlib.clearsky.simplified_solis(
        apparent_elevation,
        aod700=SOLIS_AOD700,
        precipitable_water=SOLIS_PRECIPITABLE_WATER_CM,
        pressure=SOLIS_PRESSURE_PA,
        dni_extra=SOLIS_DNI_EXTRA_WM2,
    )
    return (
        round_weather(to_float(clearsky["ghi"])),
        round_weather(to_float(clearsky["dni"])),
        round_weather(to_float(clearsky["dhi"])),
    )


def check_case(spec: CaseSpec, case: dict[str, object], dni_extra: float) -> None:
    """Assert the properties each case exists to pin, before it reaches the file.

    A fixture that silently stopped exercising its edge — a clipping case that no
    longer clips, a snow case whose ground term is zero — is worse than a missing
    one, because it still looks like coverage.

    ``dni_extra`` is passed in because one property — the Hay-Davies anisotropy
    index — is a ratio against a quantity the fixture file does not record.
    """
    weather = case["weather"]
    expected = case["expected"]

    for name in ("ghiWm2", "dniWm2", "dhiWm2"):
        value = weather[name]
        if not 0.0 <= value <= IRRADIANCE_MAX_WM2:
            raise ValueError(f"{spec.id}: {name}={value} outside weatherReadingSchema bounds")
    if not TEMPERATURE_MIN_C <= weather["temperature2mC"] <= TEMPERATURE_MAX_C:
        raise ValueError(f"{spec.id}: temperature outside weatherReadingSchema bounds")
    if not 0.0 <= weather["windSpeed10mMs"] <= WIND_MAX_MS:
        raise ValueError(f"{spec.id}: wind speed outside weatherReadingSchema bounds")
    if not 0.0 < spec.capacity_kw <= CAPACITY_MAX_KW:
        raise ValueError(f"{spec.id}: capacityKw outside siteSchema bounds")

    for name in (
        "poaBeamWm2",
        "poaSkyDiffuseWm2",
        "poaGroundWm2",
        "poaTotalWm2",
        "dcPowerKw",
        "acPowerKw",
    ):
        if expected[name] < 0.0:
            raise ValueError(f"{spec.id}: {name} is negative ({expected[name]})")

    zero_irradiance = (
        weather["ghiWm2"] == 0.0 and weather["dniWm2"] == 0.0 and weather["dhiWm2"] == 0.0
    )
    if zero_irradiance:
        for name in ("poaBeamWm2", "poaSkyDiffuseWm2", "poaGroundWm2", "poaTotalWm2",
                     "dcPowerKw", "acPowerKw"):
            if expected[name] != 0.0:
                raise ValueError(f"{spec.id}: zero irradiance but {name}={expected[name]}")
        if expected["cellTemperatureC"] != spec.temperature_2m_c:
            raise ValueError(f"{spec.id}: zero POA must leave cell temperature at ambient")

    if spec.id == "edge-midnight-sun":
        if expected["apparentZenithDeg"] >= 90.0:
            raise ValueError("edge-midnight-sun: sun is not above the horizon")
        for name in ("poaTotalWm2", "dcPowerKw", "acPowerKw"):
            if expected[name] <= 0.0:
                raise ValueError(f"edge-midnight-sun: {name} must be positive")
    if spec.id == "edge-twilight-diffuse":
        if expected["poaBeamWm2"] != 0.0 or expected["poaSkyDiffuseWm2"] <= 0.0:
            raise ValueError("edge-twilight-diffuse: expected zero beam and positive sky diffuse")
    if spec.id == "edge-sun-behind-panel":
        if expected["aoiDeg"] <= 90.0:
            raise ValueError("edge-sun-behind-panel: AOI is not above 90 deg")
        if expected["poaBeamWm2"] != 0.0:
            raise ValueError("edge-sun-behind-panel: beam must be exactly zero")
        if expected["poaSkyDiffuseWm2"] <= 0.0 or expected["poaGroundWm2"] <= 0.0:
            raise ValueError("edge-sun-behind-panel: sky and ground terms must stay positive")
    if spec.id == "edge-tilt-0" and expected["poaGroundWm2"] != 0.0:
        raise ValueError("edge-tilt-0: a horizontal array has no ground-reflected term")
    if spec.id in ("edge-sunrise-boundary", "edge-sunset-boundary"):
        if abs(expected["apparentZenithDeg"] - 90.0) > 2.0:
            raise ValueError(f"{spec.id}: zenith is not near 90 deg at the evaluation midpoint")
    if spec.id == "edge-clipping":
        if expected["dcPowerKw"] * INVERTER_EFFICIENCY <= spec.capacity_kw:
            raise ValueError(
                "edge-clipping: DC x 0.96 does not exceed capacity, so the case does not clip"
            )
        if expected["acPowerKw"] != spec.capacity_kw:
            raise ValueError("edge-clipping: AC must be exactly capacityKw")
    if spec.id == "edge-snow-albedo" and expected["poaGroundWm2"] <= 0.0:
        raise ValueError("edge-snow-albedo: ground-reflected term must be positive")
    if spec.id == "edge-anisotropy-above-one":
        if weather["dniWm2"] <= dni_extra:
            raise ValueError(
                f"edge-anisotropy-above-one: DNI {weather['dniWm2']} does not exceed "
                f"dni_extra {dni_extra}, so the anisotropy index is not above 1"
            )
        view_factor = 0.5 * (1.0 + math.cos(math.radians(spec.tilt_degrees)))
        unclipped_isotropic = (
            weather["dhiWm2"] * (1.0 - weather["dniWm2"] / dni_extra) * view_factor
        )
        if unclipped_isotropic >= 0.0:
            raise ValueError(
                "edge-anisotropy-above-one: the isotropic sky term is not negative before "
                "clipping, so the per-component clip is not exercised"
            )
        if expected["poaSkyDiffuseWm2"] <= 0.0:
            raise ValueError(
                "edge-anisotropy-above-one: sky diffuse must stay positive — the "
                "circumsolar term survives the clip that removes the isotropic one"
            )
        if expected["poaBeamWm2"] <= 0.0:
            raise ValueError("edge-anisotropy-above-one: the sun must be in front of the panel")


# --- Provenance and output --------------------------------------------------


def git_commit() -> str:
    here = Path(__file__).resolve().parent
    commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=here, capture_output=True, text=True, check=True
    ).stdout.strip()
    status = subprocess.run(
        ["git", "status", "--porcelain"], cwd=here, capture_output=True, text=True, check=True
    ).stdout.strip()
    return f"{commit}-dirty" if status else commit


def generated_at() -> str:
    """UTC timestamp, from SOURCE_DATE_EPOCH when set — the only run-varying field."""
    epoch = os.environ.get("SOURCE_DATE_EPOCH")
    moment = (
        datetime.fromtimestamp(int(epoch), UTC) if epoch else datetime.now(UTC)
    )
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


def provenance() -> dict[str, object]:
    script = Path(__file__).resolve()
    return {
        "pvlibVersion": pvlib.__version__,
        "numpyVersion": np.__version__,
        "pandasVersion": pd.__version__,
        "pythonVersion": ".".join(str(part) for part in sys.version_info[:3]),
        "scriptSha256": hashlib.sha256(script.read_bytes()).hexdigest(),
        "gitCommit": git_commit(),
        "generatedAt": generated_at(),
        "models": {
            "solarPosition": (
                "pvlib.solarposition.spa_python(times, latitude, longitude, altitude=0, "
                "pressure=101325, temperature=12, delta_t=67.0)"
            ),
            "evaluationInstant": "validTime minus 30 minutes",
            "extraterrestrial": (
                "pvlib.irradiance.get_extra_radiation(times, method='spencer', "
                "solar_constant=1366.1)"
            ),
            "aoi": (
                "pvlib.irradiance.aoi(tiltDegrees, azimuthDegrees, apparent_zenith, azimuth)"
            ),
            "skyDiffuse": (
                "pvlib.irradiance.get_total_irradiance(model='haydavies', dni_extra=spencer)"
            ),
            "groundDiffuse": (
                "pvlib.irradiance.get_total_irradiance isotropic ground term, "
                "ghi * albedo * (1 - cos(tilt)) / 2"
            ),
            "cellTemperature": (
                "pvlib.temperature.faiman(poa_global, temp_air, wind_speed, u0=25.0, u1=6.84) "
                "with 10 m wind used unadjusted"
            ),
            "dcPower": (
                "pvlib.pvsystem.pvwatts_dc(poa_global, temp_cell, pdc0=capacityKw*1000, "
                "gamma_pdc=-0.004, temp_ref=25.0) / 1000"
            ),
            "acPower": "min(dcKw * 0.96, capacityKw)",
            "clearSkyWeather": (
                "pvlib.clearsky.simplified_solis(apparent_elevation, aod700=0.1, "
                "precipitable_water=1.0, pressure=101325.0, dni_extra=1364.0); zero below "
                "the horizon"
            ),
        },
    }


def main() -> None:
    specs = grid_cases() + edge_cases()

    ids = [spec.id for spec in specs]
    duplicates = {case_id for case_id in ids if ids.count(case_id) > 1}
    if duplicates:
        raise ValueError(f"duplicate case ids: {sorted(duplicates)}")
    missing = REQUIRED_EDGE_IDS - set(ids)
    if missing:
        raise ValueError(f"required edge cases missing: {sorted(missing)}")

    cases = sorted((compute_case(spec) for spec in specs), key=lambda case: case["id"])
    if len(cases) < 300:
        raise ValueError(f"expected at least 300 cases, built {len(cases)}")

    document = {"provenance": provenance(), "cases": cases}
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print(f"wrote {len(cases)} cases to {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
