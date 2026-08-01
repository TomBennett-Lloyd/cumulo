import { DemoFleetDataSource } from './demo-fleet-data-source';
import type { FleetDataSource } from './fleet-data-source';
import { HttpFleetDataSource } from './http-fleet-data-source';

/**
 * The name of the variable, written once.
 *
 * Every message below quotes it, because whoever reads the failure is looking
 * at a `.env` file or a CI variable and needs the key to search for.
 */
const ENV_VAR = 'VITE_API_BASE_URL';

/** The two schemes `fetch` can talk over. An `ftp:`/`file:` base URL is a typo, not a mode. */
const ALLOWED_PROTOCOLS: readonly string[] = ['http:', 'https:'];

const rejection = (detail: string): string =>
  `${ENV_VAR} must be an http(s) origin. ${detail} Leave it empty to use the demo fleet.`;

/**
 * The Fleet API's origin, canonicalised, or a thrown error if it cannot be one.
 *
 * `HttpFleetDataSource` trims a trailing slash of its own accord and this trims
 * one too — incidental duplication (`structure.md` rule 7): the adapter's
 * tolerance is its contract with every caller, while this is the boundary
 * making one canonical string out of whatever a `.env` file held. Neither
 * becomes wrong if the other changes.
 */
const parseBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch (thrown: unknown) {
    throw new Error(rejection(`"${value}" is not a URL.`), { cause: thrown });
  }

  if (!ALLOWED_PROTOCOLS.includes(url.protocol)) {
    throw new Error(rejection(`"${value}" has scheme "${url.protocol}".`));
  }

  return value.replace(/\/$/, '');
};

/**
 * Which fleet the app talks to, decided from the build's environment.
 *
 * Empty or absent is the default everywhere the variable is not set — local
 * dev, every test, and any build that has not been pointed at a deployment —
 * and selects the deterministic in-memory fleet. A value selects the HTTP
 * source over the deployed Fleet API.
 *
 * A malformed value **throws** rather than falling back to the demo fleet: a
 * build configured with a typo'd origin is a violated invariant
 * (`error-handling.md` rule 1), and the fallback would be the worst outcome
 * available — a page that looks like it works while showing invented sites no
 * deployment has.
 *
 * Takes the raw value as a parameter rather than reading `import.meta.env`
 * itself, so the decision is testable without a build (`structure.md` rule 1);
 * `App.tsx` is the one place that read happens.
 */
export const selectFleetDataSource = (rawBaseUrl: string | undefined): FleetDataSource => {
  const trimmed = rawBaseUrl?.trim() ?? '';
  if (trimmed === '') {
    return new DemoFleetDataSource();
  }

  return new HttpFleetDataSource({ baseUrl: parseBaseUrl(trimmed) });
};
