# pvlib golden-fixture generator

Generates `packages/forecast/fixtures/pvlib-golden.json` — the reference values the
TypeScript PV physics port in `@cumulo/forecast` is tested against.

[ADR 0003](../../docs/adr/0003-pv-model-runtime.md) decides that the physics runs in
TypeScript and that [pvlib](https://pvlib-python.readthedocs.io/) is the correctness
authority, used **offline**. This directory is the whole of the Python in this repo:

- it is under `tools/`, so it is in no deployable's build graph and outside `pnpm lint`,
  `pnpm typecheck` and `pnpm test`;
- pvlib is never installed in CI, never on the deploy path, never at runtime;
- the only thing that crosses the language boundary is the committed JSON, validated by a
  zod schema when the tests load it.

## Interpreter and dependencies

Generated with **CPython 3.14.6** (Homebrew `python@3.14`) on macOS arm64. That was the
machine default at the time; pvlib 0.15.2 needs ≥ 3.10, and wheels for all of
numpy/pandas/scipy/h5py exist for 3.14, so no older interpreter was needed. The exact
interpreter is recorded in the fixture file's `provenance.pythonVersion` alongside the
pvlib, numpy and pandas versions — if a future regeneration uses a different one, the diff
says so.

`requirements.txt` pins **every** dependency, transitive ones included, because scipy
(reached through `pvlib.clearsky`) and pandas/numpy all move fixture values.

## Regenerating

```bash
cd tools/pvlib-fixtures
python3.14 -m venv .venv
.venv/bin/pip install --only-binary=:all: -r requirements.txt
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) .venv/bin/python generate_fixtures.py
```

`--only-binary=:all:` is deliberate: without it, pip falls back to building numpy/pandas
from source, which takes many minutes and can produce a subtly different build.

The generator writes 330 cases — a 288-case grid over site, season, hour and array
geometry, plus the 42 edge cases ADR 0003 requires (polar low sun, midnight sun, a full
polar-winter night, ordinary night, twilight, sun behind the panel, sunrise/sunset
boundaries, tilt 0 and vertical both ways, southern hemisphere with a north-facing array,
equatorial equinox noon, inverter clipping, snow albedo, and a DST transition expressed in
UTC). It asserts the property each edge case exists to pin — a clipping case that stops
clipping, or a snow case whose ground term is zero, fails the run rather than quietly
becoming decoration.

**Determinism.** Output is `json.dumps(..., indent=2, sort_keys=True)` plus a trailing
newline, cases sorted by `id`, floats at 12 significant digits. Two runs with the same
`SOURCE_DATE_EPOCH` and the same pinned dependencies produce byte-identical files, so a
regeneration diff shows only what actually moved:

```bash
SOURCE_DATE_EPOCH=1753833600 .venv/bin/python generate_fixtures.py
shasum ../../packages/forecast/fixtures/pvlib-golden.json
SOURCE_DATE_EPOCH=1753833600 .venv/bin/python generate_fixtures.py
shasum ../../packages/forecast/fixtures/pvlib-golden.json   # same hash
```

`generatedAt` is the only field that varies with when you run it, and `SOURCE_DATE_EPOCH`
pins that too. `gitCommit` records the commit the fixtures were generated from, with a
`-dirty` suffix when the working tree had uncommitted changes.

## Regeneration is a human act, never CI

Nothing regenerates these fixtures automatically. Frozen numbers are the point: they are
what an implementation nobody here wrote said the answer was, and a job that refreshed
them on every run would turn the test suite into a mirror. Regenerate deliberately when
you change the pinned models, add cases, or move to a new pvlib — and expect to justify
the diff in review.

## Reviewing the diff

1. **Check the provenance block first.** A changed `pvlibVersion`, `numpyVersion`,
   `pandasVersion`, `pythonVersion` or `models` entry explains a whole-file diff; an
   unchanged provenance block with hundreds of changed floats does not, and is the signal
   ADR 0003 calls "fixture drift we cannot explain".
2. **`scriptSha256` must match the committed `generate_fixtures.py`.** Verify with
   `shasum -a 256 tools/pvlib-fixtures/generate_fixtures.py`. A mismatch means the file was
   regenerated from a script that is not the one in the diff.
3. **Read the added and removed case ids**, not the floats: a case that disappeared is
   coverage that disappeared.
4. **For changed values, look at the intermediates.** Every case records solar position,
   AOI, all three POA components, cell temperature and DC as well as AC. A change confined
   to `poaSkyDiffuseWm2` is a transposition change; one that moves every field from
   `apparentZenithDeg` down is a solar-position or evaluation-instant change.
5. **Zeros are load-bearing.** A `0.0` that became `1e-15` is a real regression: ADR 0003
   asserts zero cases exactly, never within a tolerance.
6. **Tolerances and fixture numbers may not be edited to make a failing test pass.** That
   is review-blocking, and it is the specific failure this whole arrangement exists to
   prevent.

## Pinned models

Recorded verbatim per file in `provenance.models`; the TypeScript port must implement the
same named model, or the comparison measures the difference between two valid models
rather than the fidelity of the port.

| Step               | Call                                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Solar position     | `pvlib.solarposition.spa_python(..., altitude=0, pressure=101325, temperature=12, delta_t=67.0)`                                   |
| Evaluation instant | `validTime` − 30 min (radiation inputs are preceding-hour means)                                                                   |
| Extraterrestrial   | `pvlib.irradiance.get_extra_radiation(method='spencer', solar_constant=1366.1)`                                                    |
| Angle of incidence | `pvlib.irradiance.aoi(...)`                                                                                                        |
| Transposition      | `pvlib.irradiance.get_total_irradiance(model='haydavies', ...)` with per-case albedo                                               |
| Cell temperature   | `pvlib.temperature.faiman(..., u0=25.0, u1=6.84)`, 10 m wind unadjusted                                                            |
| DC power           | `pvlib.pvsystem.pvwatts_dc(..., gamma_pdc=-0.004, temp_ref=25.0)`, `pdc0 = capacityKw × 1000`                                      |
| AC power           | `min(dcKw × 0.96, capacityKw)`                                                                                                     |
| Clear-sky weather  | `pvlib.clearsky.simplified_solis(aod700=0.1, precipitable_water=1.0, pressure=101325.0, dni_extra=1364.0)`, zero below the horizon |

The clear-sky call synthesises the weather _inputs_ for most cases; those inputs are written
into each fixture case, so the comparison never depends on reproducing it.

pvlib is BSD-3-Clause licensed and credited in the root [README](../../README.md).
