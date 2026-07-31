import type { Forecast, Site } from '@cumulo/shared';

/**
 * How the dashboard spells the domain's numbers.
 *
 * One module rather than a formatter beside each component: the site list and
 * the detail panel display the same capacity for the same site to the same
 * reader, so a capacity that gained a decimal place in one and not the other
 * would be a defect, not a variation (`structure.md` rule 7). Units are named
 * once here and nowhere else, which is also what keeps "kW" from drifting into
 * "kw" across two files.
 *
 * Every function is total and takes what it formats — no dates, no locale, no
 * clock. Locale-sensitive formatting is deliberately avoided: `toLocaleString`
 * would make the rendered output depend on the machine running the test.
 */

/** Nameplate DC capacity is a one-decimal quantity everywhere it appears. */
const CAPACITY_DECIMALS = 1;

/** Forecast output is two decimals: the demo fleet's smallest sites peak near 1 kW. */
const POWER_DECIMALS = 2;

/**
 * Four decimals is ~11 m at these latitudes — finer than the ~2 km jitter that
 * separates two sites in the same cluster, so no two rows ever read alike.
 */
const COORDINATE_DECIMALS = 4;

export const capacityLabel = (capacityKw: number): string =>
  `${capacityKw.toFixed(CAPACITY_DECIMALS)} kW`;

export const acPowerLabel = (acPowerKw: number): string => acPowerKw.toFixed(POWER_DECIMALS);

export const angleLabel = (degrees: number): string => `${String(degrees)}°`;

export const coordinatesLabel = (site: Pick<Site, 'latitude' | 'longitude'>): string =>
  `${site.latitude.toFixed(COORDINATE_DECIMALS)}, ${site.longitude.toFixed(COORDINATE_DECIMALS)}`;

/**
 * The hour a forecast is for, as `HH:MM`.
 *
 * Sliced out of the fixed-width UTC timestamp rather than parsed into a `Date`
 * and re-rendered: the schema guarantees the width (`utcIsoTimestampSchema`),
 * and going through a `Date` would silently shift the hour into the viewer's
 * zone, which is not the zone the forecast is stated in. The column header
 * carries the "UTC" so the unit is said once rather than on every row.
 */
export const hourLabel = (validTime: Forecast['validTime']): string => validTime.slice(11, 16);

/** An em dash, not a blank: "this hour has no band" is information. */
const NO_RANGE = '—';

export const uncertaintyRangeLabel = (band: Forecast['uncertainty']): string =>
  band === undefined
    ? NO_RANGE
    : `${acPowerLabel(band.p10AcPowerKw)}–${acPowerLabel(band.p90AcPowerKw)}`;
