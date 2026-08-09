import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Route } from '../http/router';

import { componentSchemaNames } from './components';
import { openApiDocument, openApiDocumentResponse } from './document';
import type { OperationObject, ResponseObject } from './openapi-types';

/**
 * What a document generated from the code can still get wrong is the *joins*:
 * an operation for a route nobody registered, a route nobody documented, a
 * `$ref` to a component that was renamed, a keyword that makes the whole
 * document fail validation. Those are what this file tests.
 *
 * The completeness test compares against the **live route table** imported from
 * the composition root, not a list typed into a test. A list typed into a test
 * proves the author wrote it down twice; the route table is what the gateway
 * actually invokes.
 */

/** The document as one string, for the structural scans below. */
const documentJson = JSON.stringify(openApiDocument);

const apiErrorRef = '#/components/schemas/ApiError';

/** `GET /v1/sites/{siteId}` — one spelling for a route and for a documented operation. */
const describeRoute = (route: Route): string => {
  const path = route.segments
    .map((segment) => (typeof segment === 'string' ? segment : `{${segment.param}}`))
    .join('/');
  return `${route.method} /${path}`;
};

const documentedOperations = (): string[] =>
  Object.entries(openApiDocument.paths).flatMap(([path, item]) =>
    Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
  );

const allOperations = (): OperationObject[] =>
  Object.values(openApiDocument.paths).flatMap((item) => Object.values(item));

const jsonSchemaOf = (response: ResponseObject): unknown =>
  response.content?.['application/json']?.schema;

let routes: readonly Route[] = [];

beforeAll(async () => {
  // The composition root builds its adapters at module scope, so it needs an
  // environment; none of that performs I/O (`main.test.ts` makes the same
  // point). What this file wants from it is the one export a test cannot fake:
  // the routes the deployed function will actually serve.
  vi.stubEnv('CUMULO_ENV', 'test');
  const main = await import('../main');
  routes = main.routes;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe('the OpenAPI document', () => {
  it('declares OpenAPI 3.0 and an info block', () => {
    expect(openApiDocument.openapi).toMatch(/^3\.0\.\d+$/);
    expect(openApiDocument.info.title).toBe('Cumulo Fleet API');
    expect(openApiDocument.info.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(openApiDocument.info.description).toContain('Open-Meteo');
  });

  it('documents every registered route, and documents nothing else', () => {
    expect(documentedOperations().sort()).toEqual(routes.map(describeRoute).sort());
  });

  it('gives every component a description, and generates one for every source schema', () => {
    expect(Object.keys(openApiDocument.components.schemas).sort()).toEqual(
      [...componentSchemaNames].sort(),
    );
    for (const [name, schema] of Object.entries(openApiDocument.components.schemas)) {
      expect(schema.description, `${name} has no description`).toEqual(expect.any(String));
    }
  });

  it('carries no $id anywhere, which is what OpenAPI 3.0 validation rejects', () => {
    // zod stamps `$id` on every schema it generates from a registry, and
    // OpenAPI 3.0's Schema Object admits no unknown keyword — a document
    // carrying one fails `swagger-cli validate` at the component and at every
    // position that references it. `components.ts` strips it; this notices if
    // that ever stops happening, anywhere in the document.
    expect(documentJson).not.toContain('"$id"');
  });

  it('resolves every $ref to a component that exists', () => {
    const references = [...documentJson.matchAll(/"\$ref":"([^"]+)"/g)].map((match) => match[1]);

    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      const name = String(reference).replace('#/components/schemas/', '');
      expect(Object.keys(openApiDocument.components.schemas), reference).toContain(name);
    }
  });
});

describe('the documented error contract', () => {
  it('answers every non-2xx with the ApiError component, except the gateway 429', () => {
    for (const operation of allOperations()) {
      for (const [status, response] of Object.entries(operation.responses)) {
        if (status.startsWith('2') || status === '429') {
          continue;
        }
        expect(jsonSchemaOf(response), `${operation.operationId} ${status}`).toEqual({
          $ref: apiErrorRef,
        });
      }
    }
  });

  it('documents the 429 as the gateway-shaped body it really is', () => {
    // The exception is deliberate and is the reason the test above excludes it:
    // API Gateway generates throttled responses before this Lambda runs, so the
    // body is the gateway's `{ "message": … }` and nothing here can shape it.
    // Documenting an ApiError for it would be documenting a lie.
    for (const operation of allOperations()) {
      const throttled = operation.responses['429'];

      expect(throttled, `${operation.operationId} documents no 429`).toBeDefined();
      expect(jsonSchemaOf(throttled ?? { description: '' })).not.toEqual({ $ref: apiErrorRef });
      expect(throttled?.description).toContain('gateway');
    }
  });

  it('documents a 500 on every operation, because the boundary can answer one anywhere', () => {
    for (const operation of allOperations()) {
      expect(jsonSchemaOf(operation.responses['500'] ?? { description: '' })).toEqual({
        $ref: apiErrorRef,
      });
    }
  });
});

describe('the contracts the document exists to publish', () => {
  it('states the p10 ≤ p90 relation that JSON Schema cannot express', () => {
    const forecast = openApiDocument.components.schemas.Forecast;

    expect(String(forecast?.description)).toContain('p10AcPowerKw');
    expect(String(forecast?.description)).toContain('p90AcPowerKw');
  });

  it('states that an empty forecast array is a 200 rather than a 404', () => {
    // #17's "first forecast" poll keys on exactly this distinction, and a poll
    // written against the document has to be able to read it there.
    const forecastOperation = openApiDocument.paths['/v1/sites/{siteId}/forecast']?.get;

    expect(forecastOperation?.description).toContain('200');
    expect(forecastOperation?.description).toContain('empty');
    expect(forecastOperation?.responses['404']).toBeDefined();
  });

  it('binds the attribution object to every weather-derived response', () => {
    // The list is exhaustive on purpose: attribution is a CC BY 4.0 obligation, so a new
    // weather-derived wrapper that forgets it must fail here rather than ship. Fleet actuals
    // are on the list because a simulated reading is still derived from a weather-driven
    // forecast (`simulated-actual.ts`, #264).
    for (const name of [
      'SiteForecastResponse',
      'SiteSeriesResponse',
      'FleetActualsResponse',
      'FleetForecastResponse',
    ]) {
      const schema = openApiDocument.components.schemas[name];

      expect(schema?.required, name).toContain('attribution');
      expect(schema?.properties, name).toMatchObject({
        attribution: { $ref: '#/components/schemas/Attribution' },
      });
    }
  });
});

describe('GET /openapi.json', () => {
  it('serves the document as JSON a client can parse back', () => {
    const response = openApiDocumentResponse();

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/json');
    expect(JSON.parse(response.body ?? '')).toEqual(openApiDocument);
  });
});
