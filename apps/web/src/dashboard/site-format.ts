import type { Site } from '@cumulo/shared';

/**
 * How the dashboard spells the domain's numbers.
 *
 * One module rather than a formatter beside each component: the site's card on
 * the map and the header's search results display the same capacity for the same
 * site to the same reader, so a capacity that gained a decimal place in one and
 * not the other would be a defect, not a variation (`structure.md` rule 7). The
 * fleet's own table was a third consumer until it left the page on 2026-08-12,
 * which changes the count and not the argument. Units are named once here and
 * nowhere else, which is also what keeps "kW" from drifting into "kw".
 *
 * It is named for the dashboard and read from `header/` as well, which is the
 * shape a shared formatter takes when a second surface starts showing the same
 * number: one owner, imported, rather than a copy that agrees today.
 *
 * Every function is total and takes what it formats — no dates, no locale, no
 * clock. Locale-sensitive formatting is deliberately avoided: `toLocaleString`
 * would make the rendered output depend on the machine running the test.
 */

/** Nameplate DC capacity is a one-decimal quantity everywhere it appears. */
const CAPACITY_DECIMALS = 1;

/**
 * Four decimals is ~11 m at these latitudes — finer than the ~2 km jitter that
 * separates two sites in the same cluster, so no two rows ever read alike.
 */
const COORDINATE_DECIMALS = 4;

export const capacityLabel = (capacityKw: number): string =>
  `${capacityKw.toFixed(CAPACITY_DECIMALS)} kW`;

export const angleLabel = (degrees: number): string => `${String(degrees)}°`;

export const coordinatesLabel = (site: Pick<Site, 'latitude' | 'longitude'>): string =>
  `${site.latitude.toFixed(COORDINATE_DECIMALS)}, ${site.longitude.toFixed(COORDINATE_DECIMALS)}`;
