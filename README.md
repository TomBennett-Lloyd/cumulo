# Cumulo ☁️

**Forecasting the output of a virtual power plant made of rooftop solar.**

As grids take on more renewables, they need _flexibility_ — the ability to predict and shape supply and demand in near-real time. Thousands of small rooftop solar installations, aggregated, behave like one large power station: a virtual power plant (VPP). But their output is only as predictable as the sky above them. Cumulo forecasts per-site solar generation using open weather data and PV physics, corrects those forecasts with a machine-learning layer trained on historical errors, and rolls everything up into a fleet-level forecast with honest uncertainty bands.

The name: cumulus clouds are the antagonist — the thing between the sun and the panels, and the source of the uncertainty the ML layer exists to correct. Named after the problem.

## Status

🚧 Bootstrap phase — tooling, standards, and the agentic build workflow are in place; the platform itself is being built issue by issue. Watch the [issues](../../issues) and PR history to see the process.

## Data sources

- Weather and solar irradiance data by [Open-Meteo.com](https://open-meteo.com/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Open-Meteo blends models and reanalysis data (ERA5, ERA5-Land) from national weather services; see their [data sources](https://open-meteo.com/en/docs) for the underlying providers.
- Basemap tiles and styles by [OpenFreeMap](https://openfreemap.org/), rendering map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) ([ODbL](https://opendatacommons.org/licenses/odbl/)). Both credits are also shown in the app itself, beneath the map — the tile credit and the Open-Meteo credit are separate obligations and neither substitutes for the other.
- Reference values for the PV physics model are generated offline with [pvlib python](https://pvlib-python.readthedocs.io/) ([BSD-3-Clause](https://github.com/pvlib/pvlib-python/blob/main/LICENSE)) and committed as golden fixtures. pvlib is **not** a runtime or CI dependency — per [ADR 0003](docs/adr/0003-pv-model-runtime.md) the physics itself is a hand-written TypeScript port, validated against those fixtures. The generator and its regeneration instructions live in [`tools/pvlib-fixtures/`](tools/pvlib-fixtures/).

## Local checks

Fresh clone:

```bash
pnpm install            # installs dependencies and points git at .githooks
brew install gitleaks   # required: the pre-commit hook hard-fails without it
brew install shellcheck # required: pnpm verify's lint:sh gate hard-fails without it
```

`pnpm install` runs the root `prepare` script, which sets `core.hooksPath=.githooks` — the hook is committed and version-controlled, so there is nothing to copy into `.git/hooks` by hand.

Three layers guard the same rules at different moments, deliberately redundant but with no duplicated work:

| Layer                              | Runs                                   | Owns                                                                                                                                                               |
| ---------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.claude/hooks/post-edit-check.sh` | after an agent edits a TypeScript file | ESLint on that one file, working-tree content — the fast inner loop                                                                                                |
| `.githooks/pre-commit`             | `git commit`                           | the only check that sees exactly the **staged** content: gitleaks on the staged diff, then ESLint + `prettier --check` on staged files                             |
| `.github/workflows/ci.yml`         | every push and pull request            | the unskippable backstop: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format:check` across the whole repo, plus a full-history gitleaks scan — authoritative |

Notes:

- **Staged files only, and no typecheck or tests in the hook.** Whole-project `tsc` and vitest on every commit is how `--no-verify` becomes a habit. CI owns those gates.
- **Check-only.** The hook never rewrites your files: formatting violations are reported, not fixed. Run `pnpm format` and re-stage.
- **The hook's ESLint run uses `--cache`** (stored under `node_modules/.cache/eslint-precommit/`) purely for speed. Type-aware lint results for one file can change when a _different_ file changes, without invalidating the cache — so the cache is hook-only. `pnpm lint` and CI remain uncached and authoritative.
- **Missing gitleaks is a hard failure**, not a warning. A silently skipped secret scanner is indistinguishable from a passing one, and a leaked credential is the one mistake a follow-up commit cannot undo.
- **`--no-verify` skips all of this**, and pretending otherwise would be dishonest. It only moves the failure somewhere more expensive: CI cannot be skipped, and a secret that reaches a remote has to be rotated regardless of what happens to the history.

One more local surface, and only local: the **design-token gallery**. Run `pnpm --filter @cumulo/web dev` and open <http://localhost:5173/tokens.html> to see every token in `@cumulo/ui` on screen in both themes. It is deliberately absent from the production build — `vite build` reads `index.html` alone, so `tokens.html` and everything under `apps/web/src/preview/` are zero bytes of the shipped app.

## How this repo is built

This project is built with an agentic workflow (Claude Code) under tight human direction — and the workflow itself is part of the portfolio. Plans live in issue bodies, architecture decisions in [`docs/adr/`](docs/adr/), engineering standards in [`docs/standards/`](docs/standards/), design records in [`docs/design/`](docs/design/) (argued like ADRs, but reversible — the reasoning behind a component's numbers rather than a binding decision), and the agent/skill definitions in [`.claude/`](.claude/). Tech debt and process friction are tracked honestly in [`docs/tech-debt.md`](docs/tech-debt.md) and [`docs/friction-log.md`](docs/friction-log.md) and periodically converted into root-cause issues.
