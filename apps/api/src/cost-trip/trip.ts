import type { UpdateStageCommandInput } from '@aws-sdk/client-apigatewayv2';
import { z } from 'zod';

import { describeZodIssues } from '../http/response';

/**
 * The throttle a trip writes: zero sustained, zero burst, which the gateway
 * answers with a 429 before any request reaches the API function (ADR 0010).
 */
export const TRIPPED_THROTTLE = { ThrottlingRateLimit: 0, ThrottlingBurstLimit: 0 } as const;

/** Emitted once before the stage is patched and once after, so a failed patch reads as a lone first line. */
export const costTripStartedEvent = 'cost-trip.started';
export const costTripCompletedEvent = 'cost-trip.completed';

/**
 * Where the trip points, from the environment `infra/api/cost-guard.tf` sets.
 * The route keys arrive comma-separated: an API Gateway route key holds a space,
 * slashes and braces but never a comma.
 */
export const costTripEnvSchema = z.object({
  COST_TRIP_API_ID: z.string().min(1),
  COST_TRIP_STAGE_NAME: z.string().min(1),
  COST_TRIP_ROUTE_KEYS: z
    .string()
    .min(1)
    .transform((keys) => keys.split(','))
    .pipe(z.array(z.string().min(1))),
});

export interface CostTripConfig {
  readonly apiId: string;
  readonly stageName: string;
  /** Every route carrying its own `route_settings` entry on the stage. */
  readonly routeKeys: readonly string[];
}

export const parseCostTripEnv = (source: Record<string, string | undefined>): CostTripConfig => {
  const parsed = costTripEnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`cost-trip: invalid environment — ${describeZodIssues(parsed.error)}`);
  }
  return {
    apiId: parsed.data.COST_TRIP_API_ID,
    stageName: parsed.data.COST_TRIP_STAGE_NAME,
    routeKeys: parsed.data.COST_TRIP_ROUTE_KEYS,
  };
};

/**
 * The one `UpdateStage` a trip sends. The route overrides are zeroed with the
 * default because a `route_settings` entry outranks `default_route_settings`
 * (`infra/api/gateway.tf`), so a default-only trip leaves those routes open.
 */
export const costTripRequest = (config: CostTripConfig): UpdateStageCommandInput => ({
  ApiId: config.apiId,
  StageName: config.stageName,
  DefaultRouteSettings: { ...TRIPPED_THROTTLE },
  RouteSettings: Object.fromEntries(config.routeKeys.map((key) => [key, { ...TRIPPED_THROTTLE }])),
});

export interface CostTripDeps {
  readonly updateStage: (input: UpdateStageCommandInput) => Promise<unknown>;
  /** Structured-logging sink (`docs/standards/error-handling.md` rule 4). */
  readonly log: (entry: Record<string, unknown>) => void;
}

/**
 * Trips the stage. Every invocation trips, whatever the event holds: who may
 * invoke is decided by the function's two permissions in
 * `infra/api/cost-guard.tf`, so the event is logged for the reader and never
 * parsed — a payload this code failed to recognise must not be a reason not to
 * trip. A failed patch propagates, so the asynchronous invoke is retried.
 */
export const tripCostGuard = async (
  deps: CostTripDeps,
  config: CostTripConfig,
  event: unknown,
): Promise<void> => {
  const request = costTripRequest(config);
  deps.log({ event: costTripStartedEvent, request, invokedBy: event });
  await deps.updateStage(request);
  deps.log({ event: costTripCompletedEvent, apiId: config.apiId, stageName: config.stageName });
};
