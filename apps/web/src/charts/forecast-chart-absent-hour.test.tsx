// @vitest-environment jsdom

import type { Site } from '@cumulo/shared';
import { cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { fleetChartAggregate } from '../dashboard/fleet-series';
import { siteOverlaySeries } from '../dashboard/site-overlay';
import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type { FleetSourceResult } from '../data/fleet-data-source';
import type { ForecastChartPoint } from './ForecastChart';
import {
  banded,
  bare,
  isoHour,
  marks,
  renderChart,
  renderChartWithOverlay,
} from './forecast-chart-test-fixture';

/*
 * An hour absent from the series breaks every mark, as a null does (#537;
 * `docs/design/chart-treatment.md`, the gap bullet).
 */

afterEach(cleanup);

/** Hourly from 00:00 to 05:00 with 03:00 missing outright — no row, not a null. */
const HOLED: readonly ForecastChartPoint[] = [0, 1, 2, 4, 5].map((hour) => banded(hour, 4, 3));

describe('ForecastChart over a series missing an interior hour', () => {
  it.each([
    ['.forecast-chart-median', 2],
    ['.forecast-chart-band', 2],
    ['.forecast-chart-band-bound', 4],
    ['.forecast-chart-actuals', 2],
  ])('draws %s once per side of the hole', (selector, count) => {
    expect(marks(renderChart(HOLED), selector)).toHaveLength(count);
  });

  it('breaks the overlay at the hour the main series lacks', () => {
    const container = renderChartWithOverlay(
      [0, 1, 2, 4, 5].map((hour) => bare(hour, 4, null)),
      {
        label: 'Baseline',
        points: [0, 1, 2, 3, 4, 5].map((hour) => ({ validTimeIso: isoHour(hour), kw: 2 })),
      },
    );

    expect(marks(container, '.forecast-chart-overlay')).toHaveLength(2);
  });
});

const valueOf = <T,>(result: FleetSourceResult<T>): T => {
  if (result.kind !== 'ok') {
    throw new Error(`demo source failed: ${result.error.message}`);
  }
  return result.value;
};

describe('ForecastChart over the demo source’s series with an hour taken out', () => {
  const RANGE = 24;

  const demoSeries = async (): Promise<{
    readonly points: readonly ForecastChartPoint[];
    readonly site: Site;
  }> => {
    const source = new DemoFleetDataSource();
    const sites = valueOf(await source.listSites());
    const { points } = fleetChartAggregate(
      valueOf(await source.fleetForecasts(RANGE)),
      valueOf(await source.fleetActuals(RANGE)),
      sites,
      'kw',
    );
    const [site] = sites;
    if (site === undefined) {
      throw new Error('demo source listed no sites');
    }
    return { points, site };
  };

  /** Three hours before the last measured one: forecast and measured, inside both runs. */
  const withoutInteriorHour = (
    points: readonly ForecastChartPoint[],
  ): readonly ForecastChartPoint[] => {
    const hole = points.findLastIndex((point) => point.actualKw !== null) - 3;
    return points.filter((_, index) => index !== hole);
  };

  it.each(['.forecast-chart-median', '.forecast-chart-actuals'])(
    'draws one more %s path than over the whole series',
    async (selector) => {
      const { points } = await demoSeries();
      const whole = marks(renderChart(points), selector).length;
      cleanup();

      expect(marks(renderChart(withoutInteriorHour(points)), selector)).toHaveLength(whole + 1);
    },
  );

  it('draws one more site-overlay path than over the whole series', async () => {
    const { points, site } = await demoSeries();
    const source = new DemoFleetDataSource();
    const overlay = siteOverlaySeries(
      site,
      valueOf(await source.siteForecasts(site.id, RANGE)),
      valueOf(await source.siteActuals(site.id, RANGE)),
      'kw',
    );
    const whole = marks(renderChartWithOverlay(points, overlay), '.forecast-chart-overlay').length;
    cleanup();

    expect(
      marks(
        renderChartWithOverlay(withoutInteriorHour(points), overlay),
        '.forecast-chart-overlay',
      ),
    ).toHaveLength(whole + 1);
  });
});
