import { HOUR_MIDPOINT_OFFSET_MS, solarPosition } from '@cumulo/forecast';
import {
  canonicalFleetSeed,
  generateFleet,
  locationId,
  siteSchema,
  type GeoCoordinates,
  type Site,
} from '@cumulo/shared';
import { describe, expect, it } from 'vitest';

import { fleetNightClassifier, isNightAt, NIGHT_ZENITH_MIN_DEG } from './fleet-night';

/*
 * Two things are proved here, and they are different kinds of claim.
 *
 * The first is ordinary behaviour: the classifier calls midday day and midnight night, agrees with
 * itself as an evening deepens, shades nothing for a fleet that is nowhere, and — the claim the
 * whole definition rests on — calls an hour night only when *every* site is dark, never when one
 * is. That last pair is deliberately a pair: a fleet where one site is dark and one is lit, and the
 * same fleet with both dark. `some` is the plausible wrong answer, and only the contrast kills it.
 *
 * The second is the *design premise* — that "dark everywhere" is a definition this fleet can
 * actually satisfy, and a narrower one than any single site's night. Neither is an opinion this
 * suite can assert; both are quantities, so they are measured against the real demo fleet. If the
 * fleet widens — a site in Vancouver, a site in Tromsø — the intersection thins towards empty and
 * the layer would quietly draw nothing at all. That goes red here instead.
 */

const demoFleet = generateFleet(canonicalFleetSeed);

const isNight = fleetNightClassifier(demoFleet);

/** The fleet's first site, for the per-location assertions: a real input, not a stand-in for one. */
const dublinSite = ((): Site => {
  const site = demoFleet[0];
  if (site === undefined) {
    throw new Error('the demo fleet is empty, which would make every assertion below vacuous');
  }
  return site;
})();

const zenithAtMs = (location: GeoCoordinates, timeUtcMs: number): number =>
  solarPosition({
    latitudeDeg: location.latitude,
    longitudeDeg: location.longitude,
    timeUtcMs,
  }).apparentZenithDeg;

/** The sun at an instant, degrees from vertical — raw geometry, no hour convention applied. */
const zenithAt = (location: GeoCoordinates, instantIso: string): number =>
  zenithAtMs(location, Date.parse(instantIso));

/**
 * The sun `isNightAt` judges an hour by: `validTime` is hour-ending, so the instant that belongs
 * with it is the hour's midpoint. The offset is imported from the module that owns it rather than
 * respelled here, so this helper cannot drift from the code it is explaining.
 */
const zenithJudging = (location: GeoCoordinates, hourEndingIso: string): number =>
  zenithAtMs(location, Date.parse(hourEndingIso) - HOUR_MIDPOINT_OFFSET_MS);

const siteId = (digit: string): string =>
  `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;

/**
 * A site at chosen coordinates. Parsed rather than hand-built so a fixture can never carry a
 * coordinate `siteSchema` would refuse; the non-geographic fields are fixed because nothing in this
 * module reads them.
 */
const siteAt = (digit: string, coordinates: GeoCoordinates): Site =>
  siteSchema.parse({
    id: siteId(digit),
    name: `Site ${digit}`,
    ...coordinates,
    tiltDegrees: 35,
    azimuthDegrees: 180,
    capacityKw: 4,
  });

describe('fleetNightClassifier', () => {
  it('calls an hour night only when every site is dark, not when merely one is', () => {
    // The hour ending 18:00Z on the midwinter solstice, with the two sites 30° of longitude apart —
    // two hours of solar time. The eastern site is far past civil twilight for that hour while the
    // western one has not reached it, which is exactly the hour where "dark somewhere" and "dark
    // everywhere" disagree, and so exactly the hour a laxer definition would start shading while
    // the western site still counts as lit.
    const dusk = '2026-12-21T18:00:00Z';
    const west = siteAt('1', { latitude: 53, longitude: -20 });
    const east = siteAt('2', { latitude: 53, longitude: 10 });

    expect(isNightAt(west, dusk)).toBe(false);
    expect(isNightAt(east, dusk)).toBe(true);
    expect(fleetNightClassifier([west, east])(dusk)).toBe(false);
  });

  it('calls the hour night once the last of those sites is dark too', () => {
    // The mirror of the case above, one hour later, when the western site has caught up. Without
    // this half the test above would also pass for a classifier that always answered false.
    const laterDusk = '2026-12-21T19:00:00Z';
    const west = siteAt('1', { latitude: 53, longitude: -20 });
    const east = siteAt('2', { latitude: 53, longitude: 10 });

    expect(isNightAt(west, laterDusk)).toBe(true);
    expect(isNightAt(east, laterDusk)).toBe(true);
    expect(fleetNightClassifier([west, east])(laterDusk)).toBe(true);
  });

  it('calls midsummer midday day, at a sun nowhere near the horizon', () => {
    // Stated as the zenith as well as the verdict, so a reader can see the verdict is not marginal:
    // the sun is ~30° from vertical, and no threshold anyone would argue for reaches it.
    expect(zenithJudging(dublinSite, '2026-06-21T12:00:00Z')).toBeLessThan(45);
    expect(isNight('2026-06-21T12:00:00Z')).toBe(false);
  });

  it('calls the small hours after midsummer night', () => {
    expect(isNight('2026-06-21T23:30:00Z')).toBe(true);
  });

  it('calls midwinter midday day, when the sun barely clears the roofs', () => {
    // The other end of the year, and the one that would catch a sign error a June test cannot: at
    // this latitude the midwinter sun is only ~13° up, far closer to the threshold than June noon.
    expect(zenithJudging(dublinSite, '2026-12-21T12:00:00Z')).toBeGreaterThan(70);
    expect(isNight('2026-12-21T12:00:00Z')).toBe(false);
  });

  it('stays night as a midsummer evening deepens rather than flickering back to day', () => {
    // Monotonicity across the hours the chart actually plots: once the fleet's evening has crossed
    // into night it does not un-cross before midnight.
    expect(isNight('2026-06-21T23:00:00Z')).toBe(true);
    expect(isNight('2026-06-21T23:30:00Z')).toBe(true);
  });

  it('reports no night at all for an empty fleet rather than shading a location nobody has', () => {
    // The guard that `[].every(…) === true` makes necessary: without it a fleet with no sites is
    // night at every hour of the year — the widest claim available from no evidence at all.
    const nowhere = fleetNightClassifier([]);

    expect(nowhere('2026-06-21T23:30:00Z')).toBe(false);
    expect(nowhere('2026-12-21T02:00:00Z')).toBe(false);
    expect(nowhere('2026-06-21T12:00:00Z')).toBe(false);
  });

  it('reports a malformed hour as day, so a garbled point is unshaded rather than mis-shaded', () => {
    expect(isNight('not a timestamp')).toBe(false);
  });
});

describe('isNightAt', () => {
  it('waits for civil twilight instead of calling it night the moment the sun sets', () => {
    // The hour ending 22:00Z on the June solstice at a Dublin site: judged at its midpoint the sun
    // is geometrically below the horizon and the panels are nearly done, but there is still usable
    // light. This is the hour that makes NIGHT_ZENITH_MIN_DEG's value load-bearing — at the
    // geometric horizon it would be night.
    const dusk = '2026-06-21T22:00:00Z';
    const zenith = zenithJudging(dublinSite, dusk);

    expect(zenith).toBeGreaterThan(90);
    expect(zenith).toBeLessThan(NIGHT_ZENITH_MIN_DEG);
    expect(isNightAt(dublinSite, dusk)).toBe(false);
  });

  it('is night once the sun is further down than that', () => {
    const deepDusk = '2026-06-21T23:00:00Z';

    expect(zenithJudging(dublinSite, deepDusk)).toBeGreaterThan(NIGHT_ZENITH_MIN_DEG);
    expect(isNightAt(dublinSite, deepDusk)).toBe(true);
  });

  it('reads the sun at the hour’s midpoint, not at the label that ends it', () => {
    // `validTime` is hour-ending, and the same hour straddles civil twilight depending on which
    // instant of it you ask about: at 22:00Z itself the sun is already past NIGHT_ZENITH_MIN_DEG,
    // at the 21:30 midpoint it is not. The midpoint is the sun that produced this sample's kW —
    // `@cumulo/forecast`'s physics chain evaluates its geometry there — so classifying by the label
    // would shade a column whose power came from a higher sun. This case is the pin: drop the
    // offset from `isNightAt` and the verdict below flips to `true`.
    const hourEndingAtDusk = '2026-06-21T22:00:00Z';

    expect(zenithAt(dublinSite, hourEndingAtDusk)).toBeGreaterThan(NIGHT_ZENITH_MIN_DEG);
    expect(zenithJudging(dublinSite, hourEndingAtDusk)).toBeLessThan(NIGHT_ZENITH_MIN_DEG);
    expect(isNightAt(dublinSite, hourEndingAtDusk)).toBe(false);
  });
});

/** One representative site per weather bucket: `fleet.ts` co-locates 5 sites per cluster centre. */
const distinctLocations = (sites: readonly Site[]): readonly Site[] => {
  const byBucket = new Map<string, Site>();
  for (const site of sites) {
    const bucket = locationId(site);
    if (!byBucket.has(bucket)) {
      byBucket.set(bucket, site);
    }
  }
  return [...byBucket.values()];
};

const demoClusters = distinctLocations(demoFleet);

const MINUTES_PER_DAY = 1440;
const MS_PER_MINUTE = 60_000;
/** 12:00Z — broad daylight everywhere this fleet is, so it separates the day's two darknesses. */
const MIDDAY_MINUTE = MINUTES_PER_DAY / 2;
const LAST_MINUTE = MINUTES_PER_DAY - 1;

/** One instant of a UTC day — minute resolution, so a window has a width the plotted hours hide. */
const minuteOfDay = (dayStartIso: string, minute: number): string =>
  new Date(Date.parse(dayStartIso) + minute * MS_PER_MINUTE).toISOString();

/**
 * One UTC day's darkness for one predicate, held as the two minutes it turns over on.
 *
 * At these latitudes such a day reads night → light → night, so the entire dark set is
 * `[0, lastDarkOfMorning] ∪ [firstDarkOfEvening, 1439]` and this pair is all of it.
 */
interface DarkWindow {
  readonly lastDarkOfMorning: number;
  readonly firstDarkOfEvening: number;
}

/**
 * The last minute still dark, walking from a minute known dark towards a minute known lit.
 *
 * Bisection rather than a scan, and the difference is cost alone: `dark` flips exactly once
 * between those two ends, so ~11 probes converge on the very minute a 720-minute sweep would have
 * stopped at. Every figure below is therefore exact, not sampled. Sweeping instead — 1440 minutes
 * across twelve locations and two solstices — is what made this file a five-second test that timed
 * out under a loaded `pnpm verify` while passing in isolation (#323).
 *
 * Takes the probe as a parameter rather than reaching for one (`structure.md` rule 1), and runs in
 * either direction: the morning's dark end and midday walks forwards, the evening's dark end and
 * midday walks backwards to the first dark minute of the evening.
 */
const lastDarkMinute = (
  dark: (minute: number) => boolean,
  knownDark: number,
  knownLit: number,
): number => {
  let stillDark = knownDark;
  let alreadyLit = knownLit;
  while (Math.abs(alreadyLit - stillDark) > 1) {
    const probe = Math.trunc((stillDark + alreadyLit) / 2);
    if (dark(probe)) {
      stillDark = probe;
    } else {
      alreadyLit = probe;
    }
  }
  return stillDark;
};

/**
 * Where one UTC day's darkness ends and where it begins again, for any per-instant predicate.
 *
 * Refuses rather than answers when the day is not dark, light, then dark again: a fleet reaching
 * far enough north to hold civil twilight through the small hours has no such pair of edges, and a
 * plausible-looking wrong minute count is a worse outcome here than a red test. That widening is
 * the very thing this suite exists to catch, so it surfaces loudly instead of quietly.
 */
const darkWindowOf = (dayStartIso: string, dark: (at: string) => boolean): DarkWindow => {
  const at = (minute: number): boolean => dark(minuteOfDay(dayStartIso, minute));
  if (!at(0) || !at(LAST_MINUTE) || at(MIDDAY_MINUTE)) {
    throw new Error(
      `${dayStartIso} is not dark, then light, then dark again for this predicate — its night no longer has a single pair of edges, so a minute count bisected from them would be fiction`,
    );
  }
  return {
    lastDarkOfMorning: lastDarkMinute(at, 0, MIDDAY_MINUTE),
    firstDarkOfEvening: lastDarkMinute(at, LAST_MINUTE, MIDDAY_MINUTE),
  };
};

/** How many minutes of the day a window covers. */
const minutesIn = (darkWindow: DarkWindow): number =>
  darkWindow.lastDarkOfMorning + 1 + (MINUTES_PER_DAY - darkWindow.firstDarkOfEvening);

/** Each of those minutes, for the assertion that needs every one rather than the count. */
const eachMinuteIn = (dayStartIso: string, darkWindow: DarkWindow): readonly string[] => {
  const minutes: string[] = [];
  for (let minute = 0; minute <= darkWindow.lastDarkOfMorning; minute += 1) {
    minutes.push(minuteOfDay(dayStartIso, minute));
  }
  for (let minute = darkWindow.firstDarkOfEvening; minute < MINUTES_PER_DAY; minute += 1) {
    minutes.push(minuteOfDay(dayStartIso, minute));
  }
  return minutes;
};

const darkMinutes = (dayStartIso: string, dark: (at: string) => boolean): number =>
  minutesIn(darkWindowOf(dayStartIso, dark));

/**
 * How many minutes of one UTC day are dark *everywhere* in the fleet — the width of the band this
 * layer actually draws.
 *
 * Minute resolution rather than the chart's hourly one on purpose: the hourly figure would depend
 * on where the samples happen to fall relative to dusk, and the honest quantity is the width of the
 * window itself.
 */
const darkEverywhereMinutes = (dayStartIso: string): number => darkMinutes(dayStartIso, isNight);

/** The wider window: minutes dark *somewhere*, whose far edge is where the fleet's rolloff ends. */
const darkSomewhereMinutes = (dayStartIso: string): number =>
  darkMinutes(dayStartIso, (at) => demoClusters.some((site) => isNightAt(site, at)));

/** The most night minutes any one site has of that day — the widest single-site answer available. */
const longestSiteNightMinutes = (dayStartIso: string): number =>
  demoClusters.reduce(
    (longest, site) =>
      Math.max(
        longest,
        darkMinutes(dayStartIso, (at) => isNightAt(site, at)),
      ),
    0,
  );

/*
 * The instrument, proved before the measurements that lean on it.
 *
 * Every figure in the describe below is now bisected out of a day rather than walked, which is
 * sound only while the two agree. One real site on one real solstice, swept minute by minute and
 * compared, costs a fortieth of a second and keeps that agreement a measurement rather than an
 * assurance in a comment.
 */
describe('measuring a day of darkness by bisection', () => {
  it('counts the same minutes an exhaustive minute-by-minute sweep counts', () => {
    const midsummer = '2026-06-21T00:00:00Z';
    const dublinIsDark = (at: string): boolean => isNightAt(dublinSite, at);
    const swept = Array.from({ length: MINUTES_PER_DAY }, (_, minute) =>
      minuteOfDay(midsummer, minute),
    ).filter(dublinIsDark).length;

    // Asserted first so the equality below cannot be satisfied by two agreeing zeroes.
    expect(swept).toBeGreaterThan(120);
    expect(darkMinutes(midsummer, dublinIsDark)).toBe(swept);
  });
});

/*
 * The premise, as a measurement.
 *
 * These bounds are the argument for the whole design, so they are asserted rather than written in
 * a comment. `fleet.ts` owns the coordinates (`architecture.md` rule 9); this suite computes with
 * them, which is why it is the one place that holds figures derived from them.
 */
describe('one night for a fleet that has many', () => {
  it('is defined for a fleet spanning degrees, not for a single city', () => {
    const latitudes = demoFleet.map((site) => site.latitude);
    const longitudes = demoFleet.map((site) => site.longitude);

    // The demo fleet is Ireland *and* Great Britain — twelve clusters from Galway to London and
    // from Bristol to Edinburgh, not a tight Irish group. Asserted as a floor because the width is
    // the reason a single point — the fleet's centroid — was rejected as the definition of night.
    expect(Math.max(...longitudes) - Math.min(...longitudes)).toBeGreaterThan(8);
    expect(Math.max(...latitudes) - Math.min(...latitudes)).toBeGreaterThan(4);
  });

  it('spans sites that disagree about nightfall by more than a plotted hour', () => {
    // The width of the fleet's own rolloff: minutes when it is dark somewhere but not everywhere.
    // More than one hourly sample wide, at both solstices, which is what makes a single-point
    // definition unusable — its edge would land inside the rolloff, asserting darkness in a column
    // where the fleet sum above it is still visibly non-zero.
    expect(
      darkSomewhereMinutes('2026-06-21T00:00:00Z') - darkEverywhereMinutes('2026-06-21T00:00:00Z'),
    ).toBeGreaterThan(60);
    expect(
      darkSomewhereMinutes('2026-12-21T00:00:00Z') - darkEverywhereMinutes('2026-12-21T00:00:00Z'),
    ).toBeGreaterThan(60);
  });

  it('still leaves hours dark everywhere at midsummer, when they are scarcest', () => {
    // The failure mode this definition has and the centroid did not: a fleet spread wide enough
    // that no hour is dark at all of it would make this layer draw nothing, silently. Midsummer is
    // where that bites first — the northern edge barely gets astronomical darkness — so the band
    // is measured there, in minutes and again on the hourly grid the chart actually plots.
    expect(darkEverywhereMinutes('2026-06-21T00:00:00Z')).toBeGreaterThan(120);

    const plottedNightHours = Array.from({ length: 24 }, (_, hour) =>
      isNight(`2026-06-21T${hour.toString().padStart(2, '0')}:00:00Z`),
    ).filter(Boolean).length;
    expect(plottedNightHours).toBeGreaterThanOrEqual(2);
  });

  it('shades fewer minutes than the site with the longest night of its own, never more', () => {
    // The direction of the error, pinned, and it is the property that lets this band sit behind the
    // fleet sum curve: every minute the fleet calls night is night at every site, and the band is
    // strictly narrower than the widest single-site night — so it always under-claims darkness and
    // can never assert dark in a column where the curve above it is still non-zero.
    const midsummer = '2026-06-21T00:00:00Z';
    const shaded = eachMinuteIn(midsummer, darkWindowOf(midsummer, isNight));

    // Still every shaded minute against every location, not a sample of them: the subset claim is
    // the one that licenses drawing this band behind a non-zero curve, and the minutes it ranges
    // over are the fleet's own night — a few hundred, so exhaustive here is cheap.
    expect(shaded.every((at) => demoClusters.every((site) => isNightAt(site, at)))).toBe(true);
    expect(shaded.length).toBeLessThan(longestSiteNightMinutes(midsummer));
  });
});
