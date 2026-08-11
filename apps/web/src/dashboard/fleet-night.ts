import { HOUR_MIDPOINT_OFFSET_MS, solarPosition } from '@cumulo/forecast';
import type { GeoCoordinates, Site } from '@cumulo/shared';

/*
 * Whose night? — the fleet-level answer, derived and never fetched.
 *
 * ## No request is spent on this
 *
 * Open-Meteo's daily endpoint would hand us sunrise and sunset outright, and that is exactly what
 * the API-frugality constraint (CLAUDE.md) exists to refuse: a chart layer that costs a metered
 * request per render, for a quantity that is not weather at all. Where the sun is at an instant is
 * arithmetic over a latitude, a longitude and a clock reading, and this repo already owns that
 * arithmetic — `@cumulo/forecast`'s `solarPosition`, the NREL SPA port the physics chain runs on
 * (ADR 0003). Night here is that function and nothing else: no fetch, no key, no quota.
 *
 * That import is why `apps/web` declares `@cumulo/forecast` as a dependency of its own rather than
 * reaching it through `@cumulo/shared`. pnpm's isolated `node_modules` refuses an undeclared
 * transitive import, correctly, and `architecture.md` rule 1 wants the app→package edge visible in
 * the manifest rather than inherited by accident.
 *
 * ## One night for a fleet that has several
 *
 * A fleet spans locations, so it has no single sunset, and any fleet-level shading has to pick a
 * definition and own it. This one is the intersection: **the fleet's night is the hours when no
 * site in the fleet is receiving light**, each site judged by civil twilight
 * ({@link NIGHT_ZENITH_MIN_DEG}).
 *
 * The decisive constraint is that the band is drawn *behind the fleet sum curve*. Fleet output is
 * non-zero while any single site still has light, so any definition that can call an hour dark
 * while a western site is still generating would assert darkness in the same column where the
 * curve above it is visibly non-zero. A context layer that contradicts the series it sits behind
 * is worse than no layer. The intersection cannot do that: it sits strictly inside the true
 * rolloff, so its error is always in the direction of claiming *less* darkness than there is —
 * hours that are dark for most of the fleet go unshaded, and no shaded hour is contradicted.
 *
 * The obvious alternative — the night at the fleet's centroid — was measured and rejected, and it
 * should not be re-proposed without re-measuring. It is defensible only for a geographically tight
 * fleet, and this one is not: `@cumulo/shared`'s `fleet.ts` places clusters across Ireland *and*
 * Great Britain, spanning enough longitude that the fleet's own sites disagree about nightfall by
 * more than a plotted hour. Both figures — the span, and the disagreement between the earliest and
 * latest site — are asserted over the real fleet in `fleet-night.test.ts` rather than written down
 * here (`architecture.md` rule 9: `fleet.ts` owns the coordinates, that test computes with them,
 * and this comment restates neither). A single point standing in for all of them lands its edge
 * inside the fleet's own rolloff, which is precisely the contradiction above.
 *
 * What the layer is *for* is what makes the under-claim tolerable: it says "the PV series is flat
 * here because the sun is down", which is a claim about the diurnal cause of a shape the reader is
 * already looking at. It is not a sunset clock, and nothing reads a boundary off it. A treatment
 * that showed the fleet's rolloff itself would need a different data model than one flag per
 * fleet-hour — an earliest-to-latest gradient rather than a hard edge — and that is a design
 * decision above this module.
 *
 * ## Pure, and takes its clock as an argument
 *
 * Nothing here reads `Date.now()`. The instant is a parameter at every level, which is what makes
 * the classifier testable at a pinned solstice instead of only on the day the suite happens to run
 * (`architecture.md` rule 3).
 */

/**
 * The apparent solar zenith, in degrees from vertical, past which this chart calls it night.
 *
 * 96° is civil twilight: the sun 6° below the horizon, the conventional line past which there is
 * too little light to read by outdoors. Chosen over the geometric horizon (90°) because the
 * quantity being explained is PV output, which does not stop at sunset — a panel is still making a
 * little power through the bright part of dusk, so shading from 90° would put the shaded edge
 * inside the part of the curve that is still visibly generating.
 */
export const NIGHT_ZENITH_MIN_DEG = 96;

/**
 * Whether it is night at one point on the planet for one hour of the series.
 *
 * Top-level and fully parameterised rather than nested inside the classifier below, so it reads on
 * its own and can be tested on its own (`structure.md` rule 1).
 *
 * **The hour is hour-*ending*, so the sun is read at its midpoint.** `validTime` labels the hour
 * that ends at it, not the hour that starts there — the convention is `@cumulo/shared`'s, stated on
 * `forecastSchema` and `generationReadingSchema` — and the physics chain that produced the kW being
 * explained already settled what that means for solar geometry: it evaluates at `validTime` minus
 * {@link HOUR_MIDPOINT_OFFSET_MS}, because evaluating at `validTime` itself puts the sun half an
 * hour too late, visibly so at sunrise and sunset. `@cumulo/forecast`'s `physics-forecast.ts`
 * module doc owns that reasoning and the constant, which is imported here rather than respelled.
 * This classifier subtracts the same offset for the same reason, and the agreement is what the
 * layer's safety argument needs: an hour is judged by the very sun that produced its power, so the
 * wash cannot shade a column whose kW came from a higher sun than the one that classified it.
 *
 * An unparseable timestamp yields `NaN` from `Date.parse`, which survives the subtraction as `NaN`,
 * propagates to a `NaN` zenith, and `NaN > 96` is `false` — so a garbled hour is reported as day.
 * That is the deliberate direction: this layer's whole contract is that absence of the flag means
 * "draw nothing" (see `ForecastChartPoint.night`), and a malformed hour is exactly a case where
 * drawing nothing is right. It shades no hour it cannot justify.
 */
export const isNightAt = (location: GeoCoordinates, validTimeIso: string): boolean =>
  solarPosition({
    latitudeDeg: location.latitude,
    longitudeDeg: location.longitude,
    timeUtcMs: Date.parse(validTimeIso) - HOUR_MIDPOINT_OFFSET_MS,
  }).apparentZenithDeg > NIGHT_ZENITH_MIN_DEG;

/**
 * A predicate over hours for one fleet: given the fleet's sites, answer whether an hour is night
 * for **every** one of them.
 *
 * Returns a function rather than taking the hour directly because where the sites are is a property
 * of the fleet and not of the hour: a caller stamping a flag onto every point of a series settles
 * once whether it has a fleet to answer about at all, then asks only the per-hour question. Only the site array is captured, and the
 * predicate it is handed to is {@link isNightAt}, which is top-level and takes its location
 * explicitly; this is not a closure factory in `structure.md` rule 2's sense (no object of
 * functions, no state a reader has to trace).
 *
 * `every` short-circuits, and that is the cost model: a daylight hour — the majority of what any
 * chart plots — stops at the first site that still has light, usually the first site tried, so it
 * costs one solar position rather than one per site. Only the hours that really are dark
 * everywhere pay for the whole fleet. Nothing is precomputed, cached or sorted here, because doing
 * so would trade that short-circuit away for work on hours the answer never needed.
 *
 * The empty fleet is guarded explicitly and must stay that way: `[].every(…)` is `true`, so
 * deleting the guard would report *every* hour as night for a fleet with no sites — the widest
 * possible claim from the least possible evidence. A fleet that is nowhere gets no shading at all,
 * which agrees with what the panel does with an empty fleet everywhere else: it asks nothing and
 * claims nothing.
 */
export const fleetNightClassifier = (
  sites: readonly Site[],
): ((validTimeIso: string) => boolean) =>
  sites.length === 0
    ? () => false
    : (validTimeIso) => sites.every((site) => isNightAt(site, validTimeIso));
