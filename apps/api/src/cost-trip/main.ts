import { ApiGatewayV2Client, UpdateStageCommand } from '@aws-sdk/client-apigatewayv2';

import { parseCostTripEnv, tripCostGuard } from './trip';

const client = new ApiGatewayV2Client({});

/**
 * The cost-trip function's entry point (ADR 0010), bundled to its own
 * `dist/cost-trip.zip` so the trip never carries the API's bundle. `console.log`
 * is correct here because this module is the process boundary
 * `docs/standards/error-handling.md` rule 4 reserves it for.
 */
export const handler = (event: unknown): Promise<void> =>
  tripCostGuard(
    {
      updateStage: (input) => client.send(new UpdateStageCommand(input)),
      log: (entry) => {
        console.log(JSON.stringify(entry));
      },
    },
    parseCostTripEnv(process.env),
    event,
  );
