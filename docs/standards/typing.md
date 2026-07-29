# Typing standards

**Trigger:** writing or changing TypeScript types; tempted to reach for `any`, a type assertion, or a loosely shaped object.

## Rules

1. **Model the domain, not the transport.** A type describes what a value _is_, not what shape happened to arrive. Meaningful primitives get named types — `SiteId`, `Watts`, `ForecastHorizonHours` — not bare `string`/`number` passed four layers deep. Where confusion is plausible (IDs, physical units), use branded types so the compiler catches unit mistakes:

   ```ts
   type Watts = number & { readonly __unit: 'W' };
   ```

2. **No `any`, no unchecked assertions.** `as` is only acceptable when narrowing something already proven by a runtime check the compiler can't follow — and that's rare; prefer a type guard the compiler _can_ follow. The linter enforces this (suppression comments are themselves lint errors). If you're fighting the type checker, the type model is wrong: fix the model, don't silence the checker.

3. **Zod schemas are the single source of truth at boundaries.** External data — HTTP bodies, queue/stream messages, DB rows, Open-Meteo responses, env vars — is `unknown` until parsed by a schema. Derive the static type with `z.infer<typeof schema>`. Never hand-write a type that duplicates a schema; never trust a cast where a parse belongs.

4. **Discriminated unions over optional-field bags.** If a value has modes, encode them:

   ```ts
   // ❌ what does { forecast: undefined, error: undefined, loading: false } mean?
   type Result = { loading: boolean; forecast?: Forecast; error?: string };

   // ✅ impossible states are unrepresentable
   type Result =
     | { status: 'loading' }
     | { status: 'ready'; forecast: Forecast }
     | { status: 'failed'; error: ForecastError };
   ```

5. **The strict compiler flags stay on.** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are non-negotiable in `tsconfig.base.json`. Code that's awkward under them is usually code with a hidden bug — restructure rather than loosen.

## Why

This project's domain is full of same-shaped numbers (degrees of tilt vs azimuth, kW vs kWh vs W/m², lat vs lon). Structural typing makes these silently interchangeable unless we name and brand them. Descriptive types are also the cheapest documentation we have — every agent (and human reviewer) reads them before any prose.
