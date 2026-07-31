# Hindcast fixtures

## `archive-response.json`

A verbatim, unedited Open-Meteo **archive** (ERA5) response, captured once so that
every test in this package runs against the provider's real wire format without
touching the network (`docs/standards/testing.md` rule 3).

|                    |                                                                                             |
| ------------------ | ------------------------------------------------------------------------------------------- |
| Captured           | 2026-07-31                                                                                  |
| Endpoint           | `https://archive-api.open-meteo.com/v1/archive`                                             |
| Location requested | `latitude=53.35`, `longitude=-6.26` (Dublin — the repo's standing probe coordinate)         |
| Days requested     | `start_date=2026-06-01`, `end_date=2026-06-03` (3 whole UTC days, 72 hourly rows)           |
| Other parameters   | `wind_speed_unit=ms`, `timezone=UTC`, and the seven variables of `ARCHIVE_HOURLY_VARIABLES` |

Two properties of this capture are load-bearing, so do not "tidy" them:

- The echoed `latitude`/`longitude` (`53.391914`, `-6.171417`) are **not** the
  requested ones — Open-Meteo snapped the request to its model grid and reported
  the cell centre, several kilometres away. `open-meteo-archive.test.ts` asserts
  that parsed readings carry the requested pair, and that assertion is vacuous
  against a fixture whose two pairs agree.
- Every hourly column is complete (no `null`s) and covers exactly three whole
  days. Tests that need missing or truncated data derive a variant from this
  fixture in the test file, so the committed copy stays a faithful capture.

Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).
