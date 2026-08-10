import {
  apiErrorSchema,
  attributionSchema,
  createSiteInputSchema,
  fleetActualsResponseSchema,
  fleetForecastResponseSchema,
  fleetSiteSchema,
  forecastSchema,
  generationReadingSchema,
  listSitesResponseSchema,
  siteForecastResponseSchema,
  siteSeriesResponseSchema,
} from '@cumulo/shared';
import { z } from 'zod';

import type { SchemaObject } from './openapi-types';

/**
 * `components.schemas`, generated from the zod schemas the API actually parses.
 *
 * **There is no spec file in this repo.** Every schema below is produced at
 * module load by `z.toJSONSchema(…, { target: 'openapi-3.0' })` from the same
 * object the handler validates against, which is the only arrangement in which
 * "the document describes the API" is a fact rather than an intention. A
 * checked-in YAML spec would be a second definition of every domain concept,
 * which `docs/standards/architecture.md` rule 2 exists to prevent.
 *
 * The conversion runs over a zod **registry** rather than schema by schema:
 * given ids, zod emits `$ref`s between the generated schemas, so `Forecast`
 * appears once and the two response wrappers point at it. Converting each
 * schema on its own would inline a copy of `Forecast` into every wrapper — the
 * document would still be correct, and it would still be a place a reader could
 * find two definitions and have to work out which one binds.
 *
 * Every component carries a `description`, because a generated document is
 * otherwise a shape with no reasons in it. The `Forecast` entry is the
 * load-bearing one: see its text below.
 */

/**
 * The named map `components.schemas` is built from ten schemas in
 * `@cumulo/shared`: six domain schemas, and the four response wrappers composed
 * from them.
 *
 * The wrappers live in the shared package rather than here because they are a
 * two-app contract — the web client parses responses through the same objects
 * this service answers with. That does not weaken what the document promises:
 * `jsonResponse` parses every body through its wrapper before it reaches the
 * wire, so the document still describes exactly what the response validation
 * enforces.
 *
 * `as const` is what lets {@link componentRef} check a component name at compile
 * time: the literal names survive into the type below, so a renamed component
 * breaks the reference to it rather than emitting a dangling `$ref`.
 */
const componentSources = [
  {
    name: 'ApiError',
    schema: apiErrorSchema,
    description: [
      'The body of every error this service generates. `code` is the contract and the',
      'status line follows from it — one status per code, so the two can never',
      'disagree. `details` is present when the failure was field-level, and names',
      'fields of the request the caller sent. A 429 has two producers and only one of',
      'them speaks this schema: API Gateway’s throttles answer before this service is',
      'invoked, with the gateway’s own body, while this service’s per-IP limiter answers',
      'with code `rate_limited` in the shape below. That is why clients map on the',
      'status code rather than on the body.',
    ].join(' '),
  },
  {
    name: 'Attribution',
    schema: attributionSchema,
    description: [
      'The credit that must be displayed wherever the accompanying weather-derived',
      'data is shown. Open-Meteo publishes under CC BY 4.0 and this project treats',
      'the attribution as non-negotiable, so it travels in the payload rather than',
      'being left for each client to hard-code.',
    ].join(' '),
  },
  {
    name: 'CreateSiteInput',
    schema: createSiteInputSchema,
    description: [
      'A site as a caller may describe one. Four fields of a fleet site are absent',
      'because the server assigns them: `id` (one supplied by the caller is stripped,',
      'never honoured), `origin` (always `user` for a site created over HTTP),',
      '`createdAt`, and `active`. The generated `id` comes back in the 201 body,',
      'which is the only place a caller can learn it.',
    ].join(' '),
  },
  {
    name: 'FleetActualsResponse',
    schema: fleetActualsResponseSchema,
    description: [
      'Every fleet site’s actuals over one look-back window, in one array rather than',
      'one per site — the point of the endpoint is that a dashboard reads the whole',
      'fleet in a single request. **These readings are simulated**: the demo fleet has',
      'no inverters, so they are synthesized from the stored physics forecast. The shape',
      'is the shape a real meter would fill, which is why the simulation is stated here',
      'and not encoded as a field. Carries the Open-Meteo attribution that must be',
      'displayed alongside them.',
    ].join(' '),
  },
  {
    name: 'FleetForecastResponse',
    schema: fleetForecastResponseSchema,
    description: [
      'Every fleet site’s forecast points over one forward horizon, in one array rather',
      'than one per site — the point of the endpoint, as with the actuals above, is that',
      'a dashboard reads the whole fleet in a single request. An empty `forecasts` array',
      'is a normal 200 for `SiteForecastResponse`’s reason applied to a whole fleet: the',
      'points appear when the next forecast cycle writes them. Carries the Open-Meteo',
      'attribution that must be displayed alongside them.',
    ].join(' '),
  },
  {
    name: 'FleetSite',
    schema: fleetSiteSchema,
    description:
      'A site in the fleet as stored: the caller-supplied geometry plus the four server-assigned fields.',
  },
  {
    name: 'Forecast',
    schema: forecastSchema,
    description: [
      'One forecast point for one site at one valid time. `weatherSource` is the',
      'stored provenance of the weather this point was derived from — this API makes',
      'no upstream weather calls on any path.',
      '**A constraint that JSON Schema cannot express:** when `uncertainty` is',
      'present, `p10AcPowerKw` never exceeds `p90AcPowerKw`. The API enforces it as a',
      'zod refinement, which is a predicate rather than a keyword, so it is stated',
      'here rather than generated into the schema below.',
      '**The band is simulated in this deployment** (issue 295): a deterministic',
      'envelope around the physics estimate, widened by cloud-cover variability and',
      'forecast lead time. No field says so, for the reason `GenerationReading` states',
      'below — the shape is the one model-fitted quantiles would fill either way, and',
      'those arrive with the ML layer (issue 20).',
    ].join(' '),
  },
  {
    name: 'GenerationReading',
    schema: generationReadingSchema,
    description: [
      'One AC power reading for one site at one valid time — the "actual" a forecast is',
      'scored against. **Simulated in this deployment**, and there is deliberately no',
      'field saying so: the demo fleet has no telemetry, so every reading is synthesized',
      'from the stored physics forecast for the same hour, and the shape is the one a',
      'real meter would fill either way.',
    ].join(' '),
  },
  {
    name: 'ListSitesResponse',
    schema: listSitesResponseSchema,
    description: [
      'The whole fleet, unpaginated. An object rather than a bare array, because a',
      'top-level array cannot grow a sibling field — a cursor, a count — without',
      'breaking every client.',
    ].join(' '),
  },
  {
    name: 'SiteForecastResponse',
    schema: siteForecastResponseSchema,
    description: [
      'Forecast points for one site, with the Open-Meteo attribution that must be',
      'displayed alongside them. An empty `forecasts` array is a normal 200: a site',
      'created moments ago has no points until the next forecast cycle writes them.',
    ].join(' '),
  },
  {
    name: 'SiteSeriesResponse',
    schema: siteSeriesResponseSchema,
    description: [
      'Forecasts and actuals over one window, split from a single stored',
      'series so the two can be plotted against each other, with the Open-Meteo',
      'attribution that must be displayed alongside them.',
    ].join(' '),
  },
] as const;

export type ComponentSchemaName = (typeof componentSources)[number]['name'];

export const componentSchemaNames: readonly ComponentSchemaName[] = componentSources.map(
  (source) => source.name,
);

const schemaRefPath = (name: string): string => `#/components/schemas/${name}`;

/**
 * A `$ref` to one of the generated components, keyed by a name the compiler
 * checks. Every schema position in `paths.ts` goes through here.
 */
export const componentRef = (name: ComponentSchemaName): SchemaObject => ({
  $ref: schemaRefPath(name),
});

const registry = z.registry<{ id: string }>();

for (const source of componentSources) {
  registry.add(source.schema, { id: source.name });
}

const generated = z.toJSONSchema(registry, { target: 'openapi-3.0', uri: schemaRefPath });

/**
 * One generated component: the JSON Schema zod produced, minus the `$id` it
 * stamps on each registry entry, plus the description above.
 *
 * The strip is not cosmetic. OpenAPI 3.0's Schema Object closes itself to
 * unknown keywords, so a component carrying `$id` fails validation — verified
 * against `@apidevtools/swagger-cli` 4, which reports "must NOT have additional
 * properties" for the component and for every position that `$ref`s it, and
 * passes once `$id` is gone. `document.test.ts` asserts the absence, so the
 * document cannot quietly regress into an invalid one.
 *
 * A missing entry throws rather than degrading (`error-handling.md` rule 1):
 * the registry was populated from this very list moments earlier, so an absence
 * is a broken invariant — and it surfaces at module load, before the Lambda
 * answers anything.
 */
const componentSchemaFor = (source: (typeof componentSources)[number]): SchemaObject => {
  const schema = generated.schemas[source.name];
  if (schema === undefined) {
    throw new Error(`openapi: no schema was generated for the ${source.name} component`);
  }

  return {
    ...Object.fromEntries(Object.entries(schema).filter(([keyword]) => keyword !== '$id')),
    description: source.description,
  };
};

export const componentSchemas: Readonly<Record<string, SchemaObject>> = Object.fromEntries(
  componentSources.map((source) => [source.name, componentSchemaFor(source)]),
);
