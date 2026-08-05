import type { CreateSiteInput, Site } from '@cumulo/shared';
import { OpenMeteoAttribution } from '@cumulo/ui';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AddSiteDialog } from '../add-site/AddSiteDialog';
import type { CreationRefusal } from '../add-site/creation-throttle';
import { CreationThrottle } from '../add-site/creation-throttle';
import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type { FleetDataSource } from '../data/fleet-data-source';
import { useFirstForecast } from '../data/use-first-forecast';
import type { MapPosition } from '../map/MapView';
import type { Theme } from '../theme';
import { FleetPanel } from './FleetPanel';
import { LazyMapRegion } from './LazyMapRegion';
import type { MapRegionComponent } from './MapRegion';
import { PanelError, PanelPending } from './panel-states';
import { readSiteIdFromSearch, writeSiteIdToUrl } from './selection-url';
import { SiteList } from './SiteList';
import { SitePanel } from './SitePanel';
import { fleetListFailureMessage, LOADING_FLEET_LABEL } from './state-copy';

/**
 * How the one-off fleet listing went.
 *
 * The sites this session *created* are deliberately not in here — they live in
 * their own state and are concatenated during render. The listing is a request
 * that succeeded or failed once; a created site is a fact that outlives it.
 * Folding the two together would mean either a `failed` arm carrying sites
 * anyway, or a re-listing quietly dropping a site added while it was in flight.
 */
type FleetLoad =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly sites: readonly Site[] }
  | { readonly status: 'failed'; readonly message: string };

/**
 * Where the add-site flow has got to.
 *
 * A union rather than three loose fields (`typing.md` rule 4): a creation cannot
 * be in flight *and* refused, and `AddSiteForm` renders exactly one of these at
 * a time. `editing` covers both "nothing attempted yet" and "attempted, and the
 * visitor has moved on" — the form's own field-level messages are its business,
 * not the dashboard's.
 */
type CreationState =
  | { readonly status: 'editing' }
  | { readonly status: 'submitting' }
  | { readonly status: 'refused'; readonly refusal: CreationRefusal }
  | { readonly status: 'failed'; readonly message: string };

/**
 * The fleet the app runs against unless the build selects the HTTP source (#14, #150).
 *
 * One instance for the module rather than one per render: `useFirstForecast`
 * takes the source as an effect dependency, so a source rebuilt every render
 * would tear down and restart the forecast poll every render.
 */
const demoFleetDataSource = new DemoFleetDataSource();

/**
 * Identity for a draft site: where the visitor clicked.
 *
 * `AddSiteForm` reads the coordinates once, at mount, so a second map click has
 * to *remount* it — otherwise the previous location's generated name would still
 * be sitting in the name field. Keying on the position is how that happens
 * without an effect choreographing a reset (`react.md` rule 1).
 */
const draftKey = (position: MapPosition): string =>
  `${String(position.latitude)},${String(position.longitude)}`;

const loadedSites = (load: FleetLoad): readonly Site[] =>
  load.status === 'ready' ? load.sites : [];

interface FleetSectionProps {
  readonly load: FleetLoad;
  /** Everything known: the listing, plus anything created since. */
  readonly sites: readonly Site[];
  readonly selectedSiteId: Site['id'] | null;
  readonly onSelectSite: (siteId: Site['id']) => void;
  readonly onRetryLoad: () => void;
}

/**
 * The Sites section's contents: the list, or an honest account of why there is
 * no list.
 *
 * A failed listing shows the reason and a retry rather than an empty list
 * (`error-handling.md` rule 5) — and still lists any site created since, because
 * that site exists, and hiding it would be the dishonest half of the same rule.
 *
 * Both off-happy-path arms are the column's shared primitives rather than markup
 * of their own (`react.md`, "Async surface convention"). The waiting arm in
 * particular used to be a `role="status"` mounted with its text already inside
 * it, which announces nothing — it has no change to report — and only looked
 * accessible; `PanelPending` is a plain `aria-busy` container instead. That
 * leaves this section mounting exactly one live region of its own: the failure's
 * `role="alert"`, which really does arrive as a change. The chart readout that
 * now sits a panel above (`.forecast-chart-readout`, mounted empty with the
 * chart and filled only when a reader moves its selection) is *that* panel's
 * single region rather than a second one here — `react.md`'s live-region bullet
 * budgets per panel, which is exactly why the two stacked in one column compose.
 */
const FleetSection = ({
  load,
  sites,
  selectedSiteId,
  onSelectSite,
  onRetryLoad,
}: FleetSectionProps): ReactElement => {
  if (load.status === 'loading') {
    return <PanelPending label={LOADING_FLEET_LABEL} />;
  }

  return (
    <>
      {load.status === 'failed' && (
        <PanelError message={fleetListFailureMessage(load.message)} onRetry={onRetryLoad} />
      )}

      {sites.length > 0 && (
        <SiteList sites={sites} selectedSiteId={selectedSiteId} onSelectSite={onSelectSite} />
      )}
    </>
  );
};

export interface DashboardProps {
  readonly theme: Theme;
  /** Where the fleet lives. Defaults to the in-memory demo fleet. */
  readonly dataSource?: FleetDataSource;
  /**
   * The map half. Defaults to the real one, loaded on demand — see
   * {@link MapRegionComponent} for the seam and `LazyMapRegion` for why the
   * default arrives behind a `Suspense` boundary rather than in the entry
   * chunk.
   */
  readonly mapRegion?: MapRegionComponent;
}

/**
 * The fleet dashboard: the map as a full-width canvas across the top, the
 * reading beneath it, and the flow that turns a click on the map into a site
 * with a forecast.
 *
 * This is where the pieces meet, and it owns exactly the state they share.
 * `selectedSiteId` is the clearest case — the markers, the list rows and the
 * context panel all render from that one value, which is what makes selecting a
 * site on the map and selecting it in the list the same act rather than two
 * views that agree by luck. That one value is also what `?site=` addresses:
 * `selection-url.ts` is the whole of the deep link, and the dashboard reads it
 * once at mount and writes it whenever the selection moves.
 *
 * The top of that reading is a context swap, not a set of stacked slots: one
 * region shows the fleet's story or one site's, and which one is a function of
 * state rather than of a page the reader navigated to. Placing a site is the
 * one thing that is *not* in that region — it opens as a modal over the whole
 * page (`add-site/AddSiteDialog.tsx`), which is why the swap has two occupants
 * rather than three. `docs/design/dashboard-composition.md` records the rule
 * and what it is buying.
 *
 * Two things it deliberately never does. It never re-lists the fleet: the
 * listing is a mount-time request, and a dashboard that polled it would fan out
 * across every site's storage partition every few seconds (ADR 0002's review of
 * this ticket — ~25 read units a time, against a per-site forecast poll's ~0.5).
 * And it never invents a site id: the id it watches for a forecast is the one
 * `createSite` returned, because a locally predicted id addresses a site that
 * does not exist.
 */
export const Dashboard = ({
  theme,
  dataSource = demoFleetDataSource,
  mapRegion: MapRegionSlot = LazyMapRegion,
}: DashboardProps): ReactElement => {
  const [load, setLoad] = useState<FleetLoad>({ status: 'loading' });
  /** Bumping this is how the retry button asks the listing effect to run again. */
  const [listAttempt, setListAttempt] = useState(0);
  const [createdSites, setCreatedSites] = useState<readonly Site[]>([]);
  /**
   * The selection, which the URL is allowed to open on.
   *
   * Read once, in the lazy initialiser, because the address bar is the initial
   * value's *source* rather than something to keep re-reading: after mount the
   * flow runs the other way, and the sync effect below is what keeps the two
   * level. An id that names no site is not filtered here — nothing is loaded
   * yet — it is cleared by the guard in the listing effect.
   */
  const [selectedSiteId, setSelectedSiteId] = useState<Site['id'] | null>(() =>
    readSiteIdFromSearch(window.location.search),
  );
  const [draft, setDraft] = useState<MapPosition | null>(null);
  const [creation, setCreation] = useState<CreationState>({ status: 'editing' });
  /**
   * Whether the next click on the basemap drops a draft.
   *
   * Here rather than inside the map region because it is the *dashboard's*
   * click handler that has to obey it: the map reports every basemap click it
   * receives, and what a click means is this component's question. It is also
   * why the flag can be single-shot without the map knowing — opening a draft
   * clears it below, so placing a site is one deliberate act rather than a mode
   * a reader can forget they left on and then be handed a form by.
   */
  const [addSiteArmed, setAddSiteArmed] = useState(false);
  /**
   * One throttle per tab, at its shipped limits. Constructed lazily so its
   * window is anchored to this dashboard rather than to module import, and held
   * in state so no re-render can hand the visitor a fresh allowance.
   */
  const [throttle] = useState(() => new CreationThrottle());
  /**
   * The sites created this session, readable from the listing effect without
   * being a dependency of it (`react.md` rule 2).
   *
   * A dependency would make a creation re-run the listing, which is the one
   * fan-out this dashboard must never re-spend. But the stale-id guard below
   * still has to count a created site as known: a reader whose listing failed
   * can add a site, select it, and then retry the listing — and a guard that
   * only knew the listing's sites would clear the selection of a site sitting
   * right there in the list.
   */
  const createdSitesRef = useRef(createdSites);
  createdSitesRef.current = createdSites;
  /** The context region itself — the thing a swap has to bring back into view. */
  const contextRegionRef = useRef<HTMLDivElement>(null);
  /** The map's box, searched for the add-site control a closing draft returns focus to. */
  const mapRegionRef = useRef<HTMLDivElement>(null);
  /** The Sites section's box, searched for the row a closing panel hands focus back to. */
  const siteListRegionRef = useRef<HTMLDivElement>(null);

  // The fleet listing is a request whose answer arrives after this render — the
  // external system an effect is for (`react.md` rule 1). Its cleanup flips a
  // flag rather than aborting: the answer to a superseded listing is discarded,
  // not acted on. No `catch`, deliberately — a `FleetDataSource` returns its
  // expected failures as values, so a rejection is a bug in the source and
  // belongs at the boundary rather than converted into a fleet error here
  // (`error-handling.md` rule 1).
  useEffect(() => {
    let cancelled = false;

    setLoad({ status: 'loading' });
    void dataSource.listSites().then((result) => {
      if (cancelled) {
        return;
      }

      if (result.kind !== 'ok') {
        setLoad({ status: 'failed', message: result.error.message });
        return;
      }

      setLoad({ status: 'ready', sites: result.value });

      // The stale-id guard, here rather than in an effect watching derived
      // state: this is the moment the question "does that site exist?" gets its
      // answer, so it is the moment a `?site=` naming nobody stops being a
      // selection. Left standing, a dead deep link would have `useFirstForecast`
      // polling a site that does not exist for its full ninety-second deadline,
      // and the sync effect below cleans the parameter out of the URL as soon as
      // the selection goes.
      const known = [...result.value, ...createdSitesRef.current];

      setSelectedSiteId((current) =>
        current === null || known.some((site) => site.id === current) ? current : null,
      );
    });

    return () => {
      cancelled = true;
    };
  }, [dataSource, listAttempt]);

  // The address bar is an external system, and keeping it level with the
  // selection is what an effect is for (`react.md` rule 1). It cannot be a line
  // in the click handlers instead, because the selection also moves without a
  // click: a creation selects the site it just made, and the guard above clears
  // a selection nothing can show.
  useEffect(() => {
    writeSiteIdToUrl(selectedSiteId);
  }, [selectedSiteId]);

  // A scroll position is an external system in the same sense the address bar
  // is — a property of the document that no render owns and no re-render
  // restores — so keeping it level with the context is an effect's job
  // (`react.md` rule 1). The page scrolls over an unbounded site list, so a
  // reader who has scrolled to row forty and clicks a marker gets their answer
  // written into a region that is now off the top of the screen: the swap
  // happens, and the feedback is invisible. This puts the region back where it
  // can be read. The full-bleed layout (#265) did not retire the problem — it
  // moved the scroller from the panel column to the document and put a
  // full-height map band above the region (`.dashboard-map` in dashboard.css
  // owns that height), so a selection now lands *further* out of view than it
  // used to.
  //
  // It cannot be a line in the click handlers, for the reason the URL effect
  // cannot either: a context also arrives without a click — a creation selects
  // the site it just made, and a `?site=` link opens on one.
  //
  // Only *into* a context, never out of one. Closing a panel hands the same
  // region back to the fleet, and a page that jumped on the way out would move
  // ground the reader did not ask to move. `block: 'start'` and the
  // default (instant) behaviour rather than smooth scrolling: this is feedback
  // for an action already taken, not an animation, and it must not fight a
  // reader who scrolls immediately after clicking.
  //
  // A draft is deliberately not one of the arrivals this watches any more. It
  // opens in a modal now (`add-site/AddSiteDialog.tsx`), which is painted in the
  // top layer over wherever the reader happens to be — so there is nothing to
  // bring into view, and scrolling the inert page underneath it would move
  // ground for no reason the reader could see.
  useEffect(() => {
    if (selectedSiteId === null) {
      return;
    }

    contextRegionRef.current?.scrollIntoView({ block: 'start' });
  }, [selectedSiteId]);

  // Derived during render rather than mirrored into state. Memoised for
  // identity rather than speed: this array is what the map clusters, and a
  // fresh one every render would rebuild the cluster index every render.
  const sites = useMemo(() => [...loadedSites(load), ...createdSites], [load, createdSites]);
  const selectedSite = sites.find((site) => site.id === selectedSiteId) ?? null;

  /*
   * The panel's forecast follows the selection rather than only the newly
   * created site. One loop serves both, because they are the same question
   * asked of different sites: an established site answers on the first poll and
   * the loop stops (its brief wait is the `checking` arm), while a site created
   * seconds ago answers `not-found` until its first forecast exists — which is
   * the `generating` state the demo's headline minute is made of.
   */
  const { state: forecast, retry: retryForecast } = useFirstForecast(dataSource, selectedSiteId);

  /**
   * Puts focus back on one site's row in the fleet list.
   *
   * The other half of the rule the occupants of the context region follow. An
   * occupant taking the region focuses its own heading; a panel *leaving* it has
   * to hand focus somewhere too, because the button the reader pressed to close
   * it is about to be unmounted and focus would otherwise fall to `body` — no
   * position, nothing announced, and a keyboard user starting the page again.
   * The row that names the site they were reading is where they were, so it is
   * where they go back to.
   *
   * Matched on `dataset.siteId` rather than by interpolating the id into a
   * selector: an id is data, and data does not belong in a query language. If no
   * row matches — a listing that failed, a site scrolled out of a future
   * virtualised list — this does nothing, and focus stays on the Close button
   * until React unmounts it. That is the same place the browser would have left
   * it anyway, so the fallback costs nothing that was not already lost.
   */
  const focusSiteRow = (siteId: Site['id']): void => {
    const rows = siteListRegionRef.current?.querySelectorAll<HTMLElement>('[data-site-id]') ?? [];

    for (const row of rows) {
      if (row.dataset.siteId === siteId) {
        row.focus();
        return;
      }
    }
  };

  /**
   * Where focus lands when the add-site dialog leaves, and when it lands there
   * at all.
   *
   * Called from the dialog's own unmount cleanup rather than from a click
   * handler, because on the Escape path the browser restores focus itself while
   * the `cancel` event is still being dispatched — a focus call made in the
   * handler would simply be overwritten (`add-site/AddSiteDialog.tsx` carries
   * the ordering argument).
   *
   * Unconditional, which the draft's old context-region focus was not — and the
   * difference is the modal. While the draft was an occupant of the region it
   * displaced whatever was there, so cancelling *remounted* a `SitePanel` that
   * then focused its own heading, and this had to stand aside for it. A modal
   * displaces nothing: the panel behind never unmounted and has no reason to
   * re-focus, so a dashboard that stood aside here would leave focus on `body`
   * as the dialog leaves the document — the exact defect the mechanism exists
   * to remove.
   *
   * A creation is the one close that *does* have something else to say, and it
   * says it without a guard here. `SitePanel`'s heading effect runs on a change
   * of `site.id`, and React flushes every unmount cleanup in a commit before
   * any mount or update effect in that same commit — so the panel's heading is
   * the last focus set, which is the rule every occupant of the context region
   * follows. `Dashboard.focus.test.tsx`'s creation case is what holds that
   * ordering honest rather than a comment claiming it.
   *
   * The target is the control the reader opened the draft with, matched inside
   * the map's own box rather than across the document: it is the map's control,
   * the map region is substitutable (see `MapRegion.tsx`), and a document-wide
   * query would happily find a second one somebody added elsewhere.
   */
  const returnFocusFromDraft = (): void => {
    mapRegionRef.current?.querySelector<HTMLElement>('.map-control-add')?.focus();
  };

  const closeDraft = (): void => {
    setDraft(null);
    setCreation({ status: 'editing' });
  };

  const createSite = async (input: CreateSiteInput): Promise<void> => {
    // Spent here, at the call — not when the form validated. A draft the form
    // rejected never reached the fleet, and charging the allowance for it would
    // make a typo cost the visitor a site.
    throttle.record();

    const result = await dataSource.createSite(input);

    if (result.kind === 'error') {
      setCreation({ status: 'failed', message: result.error.message });
      return;
    }

    // The returned site, server-assigned id and all. Appended locally rather
    // than re-listed: one fan-out avoided, and the site is already in hand.
    setCreatedSites((current) => [...current, result.value]);
    setSelectedSiteId(result.value.id);
    setDraft(null);
    setCreation({ status: 'editing' });
  };

  const handleSubmit = (input: CreateSiteInput): void => {
    const decision = throttle.check();

    if (decision.kind === 'refused') {
      setCreation({ status: 'refused', refusal: decision });
      return;
    }

    setCreation({ status: 'submitting' });
    void createSite(input);
  };

  return (
    <div className="dashboard">
      <div className="dashboard-map" ref={mapRegionRef}>
        <MapRegionSlot
          theme={theme}
          sites={sites}
          selectedSiteId={selectedSiteId}
          onSelectSite={(siteId) => {
            setSelectedSiteId(siteId);
          }}
          onMapClick={(position) => {
            // The gate the add-site control arms. Without it every click on the
            // basemap opened a draft, so panning past a marker handed the reader
            // a form they never asked for — and the affordance had to be
            // explained in prose beside the fleet chart, because nothing on the
            // map said it.
            if (!addSiteArmed) {
              return;
            }

            setDraft(position);
            setCreation({ status: 'editing' });
            // Single-shot: the mode is spent on the click that used it, so a
            // reader is never left armed without a draft on screen to show for
            // it.
            setAddSiteArmed(false);
          }}
          addSiteArmed={addSiteArmed}
          onToggleAddSite={() => {
            setAddSiteArmed((armed) => !armed);
          }}
        />
      </div>

      {/*
       * A `div` rather than the `<aside>` this used to be. `aside` marks a
       * complementary landmark — content beside the thing the page is about —
       * which is what this was while it sat in a column next to the map. It is
       * the page's own reading now, running under the map inside `<main>`, so
       * the landmark would be describing a shape the layout no longer has.
       */}
      <div className="dashboard-content">
        {/*
         * The context region: one of *two* things now, in a fixed place.
         *
         * The draft used to be a third occupant here, outranking a selection
         * without clearing it — a precedence rule the composition had to state
         * because nothing on screen showed it. It is a modal now, so the
         * precedence is physical: the page behind is inert and there is nothing
         * to outrank. The selection still survives a draft, which is what makes
         * cancelling hand the reader back the site they had open; that is now a
         * property of the dashboard simply never clearing it, rather than of
         * this condition testing `draft`.
         *
         * Both occupants share one wrapping element because "the context
         * region" has to be addressable to be scrolled to, and because exactly
         * one of them is ever visible — the box is the region, not a stack.
         */}
        <div className="dashboard-context" ref={contextRegionRef}>
          {selectedSite !== null && (
            <SitePanel
              dataSource={dataSource}
              site={selectedSite}
              firstForecast={forecast}
              onRetryFirstForecast={retryForecast}
              onClose={() => {
                // Focus first, state second: this reads the row while it is
                // still the selected one, and moving focus off the Close button
                // before React unmounts it is the whole point.
                focusSiteRow(selectedSite.id);
                setSelectedSiteId(null);
              }}
            />
          )}

          {/*
           * Mounted always, hidden when something else holds the region — which
           * inverts, on purpose, the unmount-on-leave rule the old view nav
           * followed. A fleet re-sum in live mode is a paced fan-out of one
           * request per site (~8 s over 60 sites), so it is a thing to be spent
           * once and kept, not re-spent every time a reader closes a site. The
           * fleet's sum changes on exactly one event — a site being added — and
           * `refreshToken` is that event, counted. Deselection is not an event:
           * hiding the panel keeps its state, and unhiding it costs nothing. The
           * panel defers its *first* fan-out to its first reveal for the same
           * frugality reason, so a `?site=` deep link that never shows the fleet
           * never spends one (#178).
           *
           * A draft no longer hides it. The modal covers the page itself, so
           * emptying the region behind the backdrop would buy nothing a reader
           * can see and would cost them the context they had — visible again,
           * unchanged, the instant they cancel.
           */}
          <FleetPanel
            dataSource={dataSource}
            sites={sites}
            hidden={selectedSite !== null}
            refreshToken={createdSites.length}
          />
        </div>

        <section className="dashboard-slot" aria-labelledby="dashboard-sites-heading">
          <h2 className="dashboard-slot-heading" id="dashboard-sites-heading">
            Sites
          </h2>
          <div className="dashboard-fleet" ref={siteListRegionRef}>
            <FleetSection
              load={load}
              sites={sites}
              selectedSiteId={selectedSiteId}
              onSelectSite={(siteId) => {
                setSelectedSiteId(siteId);
              }}
              onRetryLoad={() => {
                setListAttempt((attempt) => attempt + 1);
              }}
            />
          </div>
        </section>

        {/*
         * The page's one weather credit, at the foot of the content rather than
         * inside a panel. Every panel above it shows Open-Meteo-derived numbers,
         * and a credit that lived in one of them would come and go with a
         * selection — eventually absent exactly when it mattered. The map
         * carries its own, overlaid on its bottom edge; two credits on one
         * screen at rest is the design, not an oversight (CC BY 4.0, CLAUDE.md
         * hard constraints). "At rest" because a surface a reader opens may owe
         * its own: the About dialog (`header/AboutDialog.tsx`) credits every
         * source it lists, making a third while it is open. More is compliance;
         * fewer is the failure.
         */}
        <footer className="dashboard-footer">
          <OpenMeteoAttribution />
        </footer>
      </div>

      {/*
       * The draft, in the top layer over all of the above.
       *
       * Rendered from the dashboard rather than from inside the context region
       * because it is no longer part of that flow — a modal is painted over the
       * whole page, and nesting it in the region it replaced would only leave a
       * reader of this file believing it still lives there.
       *
       * `key={draftKey(draft)}` is unchanged and still load-bearing:
       * `AddSiteForm` reads the coordinates once at mount, so a draft at a new
       * location has to remount rather than re-render (`AddSiteForm.tsx` has the
       * argument). Mounting the dialog *is* opening it, so the same key now
       * carries the modality too.
       */}
      {draft !== null && (
        <AddSiteDialog
          key={draftKey(draft)}
          latitude={draft.latitude}
          longitude={draft.longitude}
          submitting={creation.status === 'submitting'}
          refusal={creation.status === 'refused' ? creation.refusal : null}
          error={creation.status === 'failed' ? creation.message : null}
          onSubmit={handleSubmit}
          onCancel={closeDraft}
          onReturnFocus={returnFocusFromDraft}
        />
      )}
    </div>
  );
};
