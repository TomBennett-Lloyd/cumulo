/**
 * Faiman module (cell) temperature — how much hotter than the surrounding air a module
 * runs, given the irradiance falling on it and the wind cooling it.
 *
 * Hand-ported to TypeScript per ADR 0003: the physics runs in one language, and pvlib
 * stays the correctness authority offline, through committed golden fixtures.
 *
 * Model: D. Faiman, "Assessing the outdoor operating temperature of photovoltaic
 * modules", Progress in Photovoltaics 16(4), 307–315 (2008):
 *
 *     Tcell = Tair + poa / (u0 + u1 · wind)
 *
 * The default coefficients are pvlib v0.15.2's `temperature.faiman` defaults
 * (u0 = 25.0 W/m²K, u1 = 6.84 W·s/m³K), which the fixture generator passes explicitly,
 * so port and generator are the same named model.
 *
 * Pinned v1 choice: the wind speed is the weather feed's **10 m** wind, used
 * unadjusted. Faiman's coefficients were fitted against wind measured at module height,
 * so a hub-height correction is defensible — but ADR 0003 requires such an adjustment to
 * be pinned rather than assumed, and v1 pins "none". Revisiting it is a knob to evaluate
 * against hindcast error (#16), not a silent change: the golden fixtures encode this
 * choice too.
 */

/** Irradiance and weather at the module for a single cell-temperature evaluation. */
export interface FaimanCellTemperatureInput {
  /** Total plane-of-array irradiance on the module, W/m². */
  readonly poaTotalWm2: number;
  /** Ambient air temperature at 2 m, °C. */
  readonly temperature2mC: number;
  /** Wind speed at 10 m, m/s, used unadjusted (see the module doc comment). */
  readonly windSpeed10mMs: number;
  /** Faiman's u0, the still-air heat-loss coefficient, W/m²K. */
  readonly u0?: number;
  /** Faiman's u1, the wind-proportional heat-loss coefficient, W·s/m³K. */
  readonly u1?: number;
}

/** pvlib `temperature.faiman` default for u0, W/m²K (Faiman 2008). */
const FAIMAN_U0_DEFAULT_WM2K = 25.0;

/** pvlib `temperature.faiman` default for u1, W·s/m³K (Faiman 2008). */
const FAIMAN_U1_DEFAULT_WSM3K = 6.84;

/**
 * Module cell temperature in °C by the Faiman model.
 *
 * Pure: every input is a parameter, so the same input always gives the same output
 * (architecture rule 3). With no irradiance the module sits at air temperature, which is
 * why night-time fixture cases expect `Tcell === temperature2mC` exactly.
 */
export const faimanCellTemperatureC = (input: FaimanCellTemperatureInput): number => {
  const {
    poaTotalWm2,
    temperature2mC,
    windSpeed10mMs,
    u0 = FAIMAN_U0_DEFAULT_WM2K,
    u1 = FAIMAN_U1_DEFAULT_WSM3K,
  } = input;

  const heatLossCoefficient = u0 + u1 * windSpeed10mMs;

  return temperature2mC + poaTotalWm2 / heatLossCoefficient;
};
