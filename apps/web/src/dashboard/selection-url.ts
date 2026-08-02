/**
 * The selection, as a URL — read on the way in, written on the way out.
 *
 * Deliberately two functions over `URLSearchParams` rather than a router: the
 * app has one page, and the only thing a routing library would buy here is a
 * link that opens on a site. `docs/design/dashboard-composition.md` ("No
 * router") records that decision and what it costs.
 */

/** The one query parameter this module owns. */
const SITE_PARAM = 'site';

/**
 * The site id a query string names, or `null` if it names none.
 *
 * The return is a plain `string`, not `Site['id']`: this is text a visitor
 * pasted, and nothing here can vouch that a site by that id exists. Turning it
 * into a selection — or clearing it — is the fleet listing's job, which is
 * where `Dashboard`'s stale-id guard lives. So the parse stops at "there is a
 * value", and an empty `?site=` counts as no value, because it names a site
 * exactly as much as an absent parameter does.
 */
export const readSiteIdFromSearch = (search: string): string | null => {
  const value = new URLSearchParams(search).get(SITE_PARAM);

  return value === null || value === '' ? null : value;
};

/**
 * Puts the current selection in the address bar.
 *
 * `history.replaceState`, never `pushState`, and that choice is the whole
 * design of this module. Selection is not navigation: a reader who clicked six
 * markers has not visited six pages, and a Back button that replayed those six
 * clicks one at a time before finally leaving is a worse Back button than one
 * that just leaves. Replacing keeps the URL shareable without turning history
 * into a log of everything the reader glanced at.
 *
 * Parameters this module does not own are carried through rather than rebuilt
 * away — the query string may belong partly to somebody else (a campaign tag, a
 * later feature), and a writer that owns one key has no business dropping the
 * rest. The pushed state is `null` because nothing in this app writes history
 * state: with no router, there is none to preserve.
 */
export const writeSiteIdToUrl = (siteId: string | null): void => {
  const params = new URLSearchParams(window.location.search);

  if (siteId === null) {
    params.delete(SITE_PARAM);
  } else {
    params.set(SITE_PARAM, siteId);
  }

  const query = params.toString();
  const { pathname, hash } = window.location;

  window.history.replaceState(null, '', `${pathname}${query === '' ? '' : `?${query}`}${hash}`);
};
