import type { UpdateStageCommandInput } from '@aws-sdk/client-apigatewayv2';
import { describe, expect, it } from 'vitest';

import {
  costTripCompletedEvent,
  costTripStartedEvent,
  parseCostTripEnv,
  tripCostGuard,
  type CostTripConfig,
} from './trip';

const config: CostTripConfig = {
  apiId: 'abc123',
  stageName: '$default',
  routeKeys: ['POST /v1/sites', 'PUT /v1/sites/{siteId}', 'DELETE /v1/sites/{siteId}'],
};

const zero = { ThrottlingRateLimit: 0, ThrottlingBurstLimit: 0 };

const recording = (outcome: () => Promise<unknown> = () => Promise.resolve({})) => {
  const sent: UpdateStageCommandInput[] = [];
  const logged: Record<string, unknown>[] = [];
  return {
    sent,
    logged,
    deps: {
      updateStage: (input: UpdateStageCommandInput) => {
        sent.push(input);
        return outcome();
      },
      log: (entry: Record<string, unknown>) => {
        logged.push(entry);
      },
    },
  };
};

describe('tripCostGuard', () => {
  it('zeroes the stage default and every overriding route in one UpdateStage', async () => {
    const { deps, sent } = recording();

    await tripCostGuard(deps, config, { alarmData: { alarmName: 'cumulo-api-dev-cost-trip' } });

    expect(sent).toEqual([
      {
        ApiId: 'abc123',
        StageName: '$default',
        DefaultRouteSettings: zero,
        RouteSettings: {
          'POST /v1/sites': zero,
          'PUT /v1/sites/{siteId}': zero,
          'DELETE /v1/sites/{siteId}': zero,
        },
      },
    ]);
  });

  it('trips on an event it does not recognise', async () => {
    const { deps, sent } = recording();

    await tripCostGuard(deps, config, 'not an alarm payload');

    expect(sent).toHaveLength(1);
  });

  it('propagates a failed patch after logging only the start, so the invoke is retried', async () => {
    const { deps, logged } = recording(() => Promise.reject(new Error('AccessDenied')));

    await expect(tripCostGuard(deps, config, {})).rejects.toThrow('AccessDenied');

    expect(logged.map((entry) => entry.event)).toEqual([costTripStartedEvent]);
  });

  it('logs completion once the patch has landed', async () => {
    const { deps, logged } = recording();

    await tripCostGuard(deps, config, {});

    expect(logged.map((entry) => entry.event)).toEqual([
      costTripStartedEvent,
      costTripCompletedEvent,
    ]);
  });
});

describe('parseCostTripEnv', () => {
  it('splits the route keys on commas, keeping their spaces and braces', () => {
    expect(
      parseCostTripEnv({
        COST_TRIP_API_ID: 'abc123',
        COST_TRIP_STAGE_NAME: '$default',
        COST_TRIP_ROUTE_KEYS: 'DELETE /v1/sites/{siteId},POST /v1/sites',
      }),
    ).toEqual({
      apiId: 'abc123',
      stageName: '$default',
      routeKeys: ['DELETE /v1/sites/{siteId}', 'POST /v1/sites'],
    });
  });

  it('refuses a missing setting rather than tripping nothing', () => {
    expect(() =>
      parseCostTripEnv({ COST_TRIP_API_ID: 'abc123', COST_TRIP_STAGE_NAME: '$default' }),
    ).toThrow('cost-trip: invalid environment');
  });

  it('refuses an empty key between commas', () => {
    expect(() =>
      parseCostTripEnv({
        COST_TRIP_API_ID: 'abc123',
        COST_TRIP_STAGE_NAME: '$default',
        COST_TRIP_ROUTE_KEYS: 'POST /v1/sites,,PUT /v1/sites/{siteId}',
      }),
    ).toThrow('cost-trip: invalid environment');
  });
});
