/**
 * PV power conversion: plane-of-array irradiance and cell temperature to DC power, then
 * DC to inverter-clipped AC power.
 *
 * Hand-ported to TypeScript per ADR 0003: the physics runs in one language, and pvlib
 * stays the correctness authority offline, through committed golden fixtures.
 *
 * Model: the NREL PVWatts v5 DC module (A. P. Dobos, "PVWatts Version 5 Manual",
 * NREL/TP-6A20-62641, 2014), as implemented by pvlib v0.15.2 `pvsystem.pvwatts_dc`:
 *
 *     Pdc = (poa / 1000 W/m²) · Pdc0 · (1 + γ · (Tcell − 25 °C))
 *
 * followed by a constant-efficiency inverter clipped at nameplate.
 *
 * Unit convention: **kilowatts** throughout, both DC and AC — matching `siteSchema`'s
 * `capacityKw` and `forecastSchema`'s `acPowerKw`. `capacityKw` is nameplate **DC**
 * capacity: it is Pdc0 in the equation above, and it is also the AC ceiling, so a site is
 * modelled as having an inverter sized to its array (v1 pins a DC/AC ratio of 1.0).
 *
 * Neither function clamps at zero, because pvlib does not: above roughly 275 °C the
 * temperature factor turns negative and DC power goes with it. No *plausible* weather puts
 * a cell there — but a schema-valid one can, so this is not an unreachable branch. A
 * near-grazing sun on a vertical array aimed at it drives the Hay-Davies circumsolar term
 * to Rb (~57.3, capped) times the anisotropy index — 62.4x DHI at the measured worst case
 * (`irradiance.ts`) — and with the irradiance fields at their 1500 W/m² caps
 * the resulting POA reaches ~95 200 W/m², putting the cell near 3870 °C and both DC and AC
 * below zero. Clamping here would hide that input rather than reject it, and would also
 * diverge from the fixtures; `createPhysicsForecast`'s final `forecastSchema.parse` is the
 * layer that refuses to store such a number, and its doc comment carries the detail.
 */

/** Operating point of the array for a single DC-power evaluation. */
export interface PvwattsDcPowerInput {
  /** Total plane-of-array irradiance on the module, W/m². */
  readonly poaTotalWm2: number;
  /** Module cell temperature, °C. */
  readonly cellTemperatureC: number;
  /** Nameplate DC capacity of the array, kW. */
  readonly capacityKw: number;
  /** Temperature coefficient of power, fraction per °C (negative: hot cells lose power). */
  readonly gammaPerC?: number;
}

/** DC output and inverter sizing for a single AC-power evaluation. */
export interface AcPowerInput {
  /** DC power leaving the array, kW. */
  readonly dcPowerKw: number;
  /** Nameplate capacity of the array, kW — also the AC ceiling (see the module doc). */
  readonly capacityKw: number;
  /** Inverter efficiency as a fraction in (0, 1]. */
  readonly inverterEfficiency?: number;
}

/** Reference irradiance at standard test conditions, W/m². */
const STC_IRRADIANCE_WM2 = 1000;

/** Reference cell temperature at standard test conditions, °C (pvlib `temp_ref`). */
const STC_CELL_TEMPERATURE_C = 25.0;

/**
 * PVWatts default temperature coefficient of power for crystalline silicon, per °C
 * (Dobos 2014; pvlib `pvwatts_dc` documents the same −0.004 default).
 */
const PVWATTS_GAMMA_DEFAULT_PER_C = -0.004;

/**
 * PVWatts default nominal inverter efficiency (Dobos 2014, §"Inverter Model": the
 * default nominal efficiency is 96 %).
 */
const PVWATTS_INVERTER_EFFICIENCY_DEFAULT = 0.96;

/**
 * DC power in kW by the PVWatts v5 DC model.
 *
 * Pure: every input is a parameter (architecture rule 3). At standard test conditions —
 * 1000 W/m² on the plane of array, cells at 25 °C — this returns `capacityKw` exactly,
 * which is what nameplate capacity means.
 */
export const pvwattsDcPowerKw = (input: PvwattsDcPowerInput): number => {
  const {
    poaTotalWm2,
    cellTemperatureC,
    capacityKw,
    gammaPerC = PVWATTS_GAMMA_DEFAULT_PER_C,
  } = input;

  const temperatureFactor = 1 + gammaPerC * (cellTemperatureC - STC_CELL_TEMPERATURE_C);

  return (poaTotalWm2 / STC_IRRADIANCE_WM2) * capacityKw * temperatureFactor;
};

/**
 * AC power in kW: the inverter's constant efficiency applied to DC power, clipped at the
 * site's nameplate capacity.
 *
 * Pure: every input is a parameter (architecture rule 3). Clipping is what makes a
 * bright, cold hour report exactly `capacityKw` rather than the array's higher DC output.
 */
export const acPowerKw = (input: AcPowerInput): number => {
  const { dcPowerKw, capacityKw, inverterEfficiency = PVWATTS_INVERTER_EFFICIENCY_DEFAULT } = input;

  return Math.min(dcPowerKw * inverterEfficiency, capacityKw);
};
