/**
 * The slice of the OpenAPI 3.0 object model this API actually emits, as types.
 *
 * Hand-written rather than pulled from a package, for the reason
 * `docs/standards/typing.md` rule 2 gives: the published `openapi-types` union
 * models every OpenAPI version at once, so `document.paths['/v1/sites']?.get`
 * arrives as a union that needs an assertion to use — and an assertion is a lint
 * error here. Twelve interfaces that describe exactly what this document
 * contains cost less than one suppression, and they are checked by the same
 * `swagger-cli validate` run that checks the document itself.
 *
 * Everything is `readonly` and every optional property is genuinely optional:
 * under `exactOptionalPropertyTypes` an operation without parameters *omits*
 * `parameters` rather than setting it to `undefined`, which is also the shape
 * the JSON should have.
 */

/**
 * An OpenAPI 3.0 Schema Object, including the `{ $ref: … }` form.
 *
 * Deliberately opaque. Every schema in this document is *generated* — by
 * `z.toJSONSchema` from a `@cumulo/shared` zod schema — or is a `$ref` to one,
 * so a hand-written structural type here would be a second, weaker statement of
 * what those schemas contain and would have to grow a case every time zod
 * learned a new keyword. What the compiler needs to know is "this is a JSON
 * object that goes in a schema position", and that is what this says. What
 * makes references safe is not this type but `componentRef`, which will not
 * build one for a component name that does not exist.
 */
export type SchemaObject = Readonly<Record<string, unknown>>;

export interface MediaTypeObject {
  readonly schema: SchemaObject;
}

/** Keyed by media type: `application/json`, `text/html`, … */
export type ContentObject = Readonly<Record<string, MediaTypeObject>>;

export interface ResponseObject {
  readonly description: string;
  /** Absent for a response with no body — `204 No Content` from `DELETE`. */
  readonly content?: ContentObject;
}

/** Keyed by status code as a string, per the spec (`'200'`, `'404'`). */
export type ResponsesObject = Readonly<Record<string, ResponseObject>>;

export interface ParameterObject {
  readonly name: string;
  readonly in: 'path' | 'query';
  readonly required: boolean;
  readonly description: string;
  readonly schema: SchemaObject;
}

export interface RequestBodyObject {
  readonly description: string;
  readonly required: boolean;
  readonly content: ContentObject;
}

export interface OperationObject {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly parameters?: readonly ParameterObject[];
  readonly requestBody?: RequestBodyObject;
  readonly responses: ResponsesObject;
}

/**
 * The HTTP methods this API answers, lower-cased as OpenAPI keys them.
 *
 * A closed union rather than `string`, so the test that walks the route table
 * and looks each route up in `paths` is looking up something the type system
 * agrees could be there.
 */
export type OperationMethod = 'get' | 'post' | 'put' | 'delete';

export type PathItemObject = Readonly<Partial<Record<OperationMethod, OperationObject>>>;

/** Keyed by templated path: `/v1/sites/{siteId}`. */
export type PathsObject = Readonly<Record<string, PathItemObject>>;

export interface InfoObject {
  readonly title: string;
  readonly version: string;
  readonly description: string;
}

export interface ComponentsObject {
  readonly schemas: Readonly<Record<string, SchemaObject>>;
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: InfoObject;
  readonly paths: PathsObject;
  readonly components: ComponentsObject;
}
