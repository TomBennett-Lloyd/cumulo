# Cumulo ☁️

**Forecasting the output of a virtual power plant made of rooftop solar.**

As grids take on more renewables, they need _flexibility_ — the ability to predict and shape supply and demand in near-real time. Thousands of small rooftop solar installations, aggregated, behave like one large power station: a virtual power plant (VPP). But their output is only as predictable as the sky above them. Cumulo forecasts per-site solar generation using open weather data and PV physics, corrects those forecasts with a machine-learning layer trained on historical errors, and rolls everything up into a fleet-level forecast with honest uncertainty bands.

The name: cumulus clouds are the antagonist — the thing between the sun and the panels, and the source of the uncertainty the ML layer exists to correct. Named after the problem.

## Status

🚧 Bootstrap phase — tooling, standards, and the agentic build workflow are in place; the platform itself is being built issue by issue. Watch the [issues](../../issues) and PR history to see the process.

## Data sources

- Weather and solar irradiance data by [Open-Meteo.com](https://open-meteo.com/), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Open-Meteo blends models and reanalysis data (ERA5, ERA5-Land) from national weather services; see their [data sources](https://open-meteo.com/en/docs) for the underlying providers.

## How this repo is built

This project is built with an agentic workflow (Claude Code) under tight human direction — and the workflow itself is part of the portfolio. Plans live in issue bodies, architecture decisions in [`docs/adr/`](docs/adr/), engineering standards in [`docs/standards/`](docs/standards/), and the agent/skill definitions in [`.claude/`](.claude/). Tech debt and process friction are tracked honestly in [`docs/tech-debt.md`](docs/tech-debt.md) and [`docs/friction-log.md`](docs/friction-log.md) and periodically converted into root-cause issues.
