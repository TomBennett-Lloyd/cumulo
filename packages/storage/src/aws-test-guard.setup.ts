/**
 * Neutralises ambient AWS state for every vitest run that loads it (#128).
 *
 * **This file is env mutation at import time.** It has no exports and takes
 * effect purely by being loaded, so it must never be imported by production
 * code or re-exported from any `index.ts` — it is wired in exclusively as a
 * vitest `setupFiles` entry (`packages/storage/vitest.config.ts`, and the same
 * path from the AWS-touching apps). That places it in the same category as
 * `./recording-http-handler.ts`: test support living in `src/` and absent from
 * `index.ts` on purpose. #112 is the ticket that will rule on where test-support
 * modules belong; this file migrates with that convention when it lands.
 *
 * **Why env rather than a mock.** The AWS SDK resolves credentials and endpoints
 * lazily, on the first `send`. A unit test whose mock or endpoint override slips
 * therefore promotes silently into a live call on whatever identity the machine
 * happens to hold. Pinning credentials to recognisable fakes and the endpoint to
 * a loopback port nothing listens on makes such a call fail fast, loudly, and
 * offline. `setupFiles` re-runs per test file in every worker, so the guard
 * re-heals after any cross-file mutation of these variables — which is why it
 * *sets* the critical variables rather than only deleting the dangerous ones.
 *
 * **Stated residual — SQS `SendMessage`.** SQS routes `SendMessage` by the host
 * in its `QueueUrl`, not by the client endpoint (verified in-tree against
 * `apps/ingestion/src/publisher/sqs-deadline.test.ts`, whose fixture queue URL
 * carries a local host and is reached despite the endpoint sentinel). A test
 * aiming a `SendMessage` at a real `amazonaws.com` queue URL therefore still
 * opens a socket: the endpoint sentinel does not cover that command. The
 * credential sentinel is the layer that holds there — the request can leave, but
 * it cannot authenticate, mutate anything, or bill anything. Closing the socket
 * half needs network-level enforcement and is tracked as its own issue.
 *
 * **Tests that need real environment values.** They set and restore their own
 * values over these, which is exact rather than approximate. In particular
 * `client.test.ts`'s deadline tests point the SDK at a local fixture server with
 * `AWS_ENDPOINT_URL_DYNAMODB`: the service-specific variable deliberately
 * outranks the generic sentinel below (verified against the installed SDK), and
 * that precedence is the mechanism those tests rely on. It is also why every
 * inherited `AWS_ENDPOINT_URL_*` is deleted here — a leaked service-specific
 * endpoint would outrank the sentinel exactly the same way and punch a hole
 * through the guard.
 */

// Recognisable fakes: env credentials win the SDK's default provider chain, so
// setting them stops resolution before it can reach a profile, a role, or IMDS.
// The literals are duplicated in `aws-test-guard.test.ts` on purpose — drift
// between the two fails loud instead of passing silently.
process.env.AWS_ACCESS_KEY_ID = 'cumulo-test-sentinel-access-key-id';
process.env.AWS_SECRET_ACCESS_KEY = 'cumulo-test-sentinel-secret-access-key';

// Every other route to an identity or an endpoint, removed. `Reflect.deleteProperty`
// rather than `delete process.env[key]`: the endpoint keys are only knowable at
// runtime, and a dynamic `delete` is banned outright (`@typescript-eslint/no-dynamic-delete`)
// — reflection states the same intent without a suppression.
for (const key of [
  'AWS_SESSION_TOKEN',
  'AWS_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  ...Object.keys(process.env).filter((name) => name.startsWith('AWS_ENDPOINT_URL_')),
]) {
  Reflect.deleteProperty(process.env, key);
}

// Defence in depth behind the credential sentinels above: an empty-but-readable
// config beats a nonexistent path, which would only add ENOENT noise.
process.env.AWS_CONFIG_FILE = '/dev/null';
process.env.AWS_SHARED_CREDENTIALS_FILE = '/dev/null';
process.env.AWS_EC2_METADATA_DISABLED = 'true';

// Port 1 is reserved and never listened on: a connection attempt is refused
// immediately, so an unmocked send dies in milliseconds and never leaves the host.
process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:1';

// Supplied so a client built without an explicit region still resolves one —
// otherwise the failure would be a region error rather than the refused socket
// this guard is here to produce.
process.env.AWS_REGION = 'eu-west-1';
