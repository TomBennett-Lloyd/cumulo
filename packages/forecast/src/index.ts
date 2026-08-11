/**
 * `@cumulo/forecast` — the pure PV physics core (ADR 0003).
 *
 * The surface is deliberate, and layered from the chain's answer down to its parts:
 * `createPhysicsForecast` is what a service calls, `runPhysicsChain` is what a hindcast
 * harness or a diagnostic calls when the intermediates matter, and the individual model
 * functions are exported so each stage can be exercised — and compared against pvlib —
 * on its own. Everything here is a pure function of its arguments: no clock, no I/O, no
 * environment (architecture rule 3).
 */

export {
  createPhysicsForecast,
  runPhysicsChain,
  defaultPhysicsParams,
  HOUR_MIDPOINT_OFFSET_MS,
  type PhysicsParams,
  type PhysicsChainResult,
  type PhysicsForecastResult,
} from './physics-forecast';
export { solarPosition, type SolarPosition } from './solar-position';
export {
  extraterrestrialNormalIrradiance,
  angleOfIncidence,
  poaIrradiance,
  type PoaIrradiance,
} from './irradiance';
export { faimanCellTemperatureC } from './cell-temperature';
export { pvwattsDcPowerKw, acPowerKw } from './power';
