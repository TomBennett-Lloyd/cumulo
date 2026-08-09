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
import { AppHeader } from '../header/AppHeader';
import type { MapPosition } from '../map/MapView';
import type { Theme } from '../theme';
import { FleetPanel } from './FleetPanel';
import { LazyMapRegion } from './LazyMapRegion';
import type { MapRegionComponent } from './MapRegion';
import { PanelError, PanelPending } from './panel-states';
import type { SelectionOrigin } from './selection-origin';
import { readSiteIdFromSearch, writeSiteIdToUrl } from './selection-url';
import { SiteTable } from './SiteTable';
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
 * The fleet's own section: the table, or an honest account of why there is no
 * table.
 *
 * A failed listing shows the reason and a retry rather than an empty table
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
 * rather than a second one here — `react.md`'s live-region bullet budgets per
 * panel, which is exactly why the two stacked in one column compose.
 *
 * That panel can hold two of its own in one state, and it is the co-occurrence
 * the same bullet sanctions rather than a breach of it: since #284 D3 the chart
 * survives a failed fan-out, so `PanelError`'s alert mounts beside the readout
 * there. It is safe for the reason the bullet gives — a failed fan-out leaves no
 * points, so the readout is empty for as long as the alert is up — and it does
 * not change the composition here, because the budget is still per panel and
 * this section still mounts exactly one.
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
        <SiteTable sites={sites} selectedSiteId={selectedSiteId} onSelectSite={onSelectSite} />
      )}
    </>
  );
};

export interface DashboardProps {
  readonly theme: Theme;
  /**
   * Flipping the theme, passed straight through to the header's menu.
   *
   * The dashboard has no opinion about theming — it forwards the theme to the
   * map, which paints its basemap in it, and this to the bar it now renders.
   * Both arrive from `useTheme` in the shell above.
   */
  readonly onToggleTheme: () => void;
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
 * The fleet dashboard: the header bar, the map as a full-width canvas across the
 * top, the reading beneath it, and the flow that turns a click on the map into a
 * site with a forecast.
 *
 * The bar is here rather than in the shell because of one item on it. The
 * header's site search reads the fleet and selects into `selectedSiteId`, and
 * both of those are this component's — so the bar came down to the state rather
 * than the state going up to the shell (`header/AppHeader.tsx` states the trade,
 * including what it costs when the tree below throws).
 *
 * This is where the pieces meet, and it owns exactly the state they share.
 * `selectedSiteId` is the clearest case — the markers, the table rows, the card
 * on the map and the chart's overlay all render from that one value, which is
 * what makes selecting a site on the map and selecting it in the table the same
 * act rather than views that agree by luck. That one value is also what `?site=`
 * addresses: `selection-url.ts` is the whole of the deep link, and the dashboard
 * reads it once at mount and writes it whenever the selection moves.
 *
 * A selection has a second half here, `selectionOrigin`, and it exists for one
 * rule: focus moves for a reader and never for a link (`selection-origin.ts`,
 * settling #260).
 *
 * Nothing under the map swaps any more. One region alternating between a site's
 * panel and the fleet's was the shape the reading had until #265; a site's
 * detail is now a card anchored to its own marker, so the reading below is a
 * plain flow — the fleet's chart, the site table, the credit — and a selection
 * changes what is *drawn on* those surfaces rather than which of them is there.
 * Placing a site is a modal over the whole page
 * (`add-site/AddSiteDialog.tsx`). `docs/design/dashboard-composition.md` records
 * the reasoning and what it is buying.
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
  onToggleTheme,
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
  /**
   * Who asked for the current selection — the fact the focus rule turns on
   * (`selection-origin.ts`, settling #260).
   *
   * It starts at `'deep-link'` because that is the only thing the initialiser
   * above can be answering: at mount the selection is whatever the address bar
   * carried, and nobody has done anything yet. Every handler that moves the
   * selection sets `'reader'` in the same commit, so the two values cannot
   * disagree about a selection either of them can see. It is deliberately not
   * cleared alongside a deselection: with no site there is no card to focus, and
   * a value nothing reads is a value nothing can be wrong about.
   */
  const [selectionOrigin, setSelectionOrigin] = useState<SelectionOrigin>('deep-link');
  /**
   * Selecting a site, the way everything but the address bar does it.
   *
   * One helper rather than the pair of `set` calls written out at every call
   * site: "which site" and "who asked" are one fact about one event, and a call
   * site that set the first without the second would silently reuse the previous
   * origin — which is the deep-link bug this exists to prevent, reintroduced from
   * the other end. The number of call sites is deliberately not stated here; it
   * has grown twice already, and a helper is what makes each new one correct by
   * default rather than by being counted.
   */
  const selectSiteForReader = (siteId: Site['id']): void => {
    setSelectedSiteId(siteId);
    setSelectionOrigin('reader');
  };
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
  /** The map's box, searched for the add-site control a closing draft returns focus to. */
  const mapRegionRef = useRef<HTMLDivElement>(null);

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

  // There is no context-scroll effect here any more, and its absence is the
  // point. A selection used to be written into a region under the map, so a
  // reader who had scrolled down to row forty got their answer somewhere off the
  // top of the screen and the dashboard had to bring the region back into view
  // (#148 review cycle 1). #265 anchored the answer to the site's own marker on
  // the map instead — there is nothing under the reader's scroll position to
  // chase, and the one thing that can be out of view is the *site*, which the
  // map's own `SelectionCamera` brings into frame without moving the page.

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

  /*
   * There is no `focusSiteRow` here any more, and it is worth saying what
   * replaced it. A closing site panel used to hand focus back by *searching the
   * list* for the row naming its site, which was right only because a row was
   * the only way to open one that this dashboard could see. The card on the map
   * remembers the element that actually held focus when it opened and hands it
   * back on close (`map/SitePopoverCard.tsx`), which is the same answer for
   * every opener — a marker, a row, the header's search, a creation — without
   * the dashboard knowing which happened, and without needing an answer of its
   * own the next time one is added.
   */

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
   * Unconditional, and the reason it can be is that the dialog displaces
   * nothing: the map and everything under it are still exactly where the reader
   * left them, so nothing else has cause to claim the focus back and a dashboard
   * that stood aside here would leave it on `body` as the dialog leaves the
   * document — the exact defect this mechanism exists to remove.
   *
   * A creation is the one close that *does* have something else to say, and it
   * says it without a guard here. React flushes every unmount cleanup in a
   * commit before any mount effect in that same commit, so this runs first and
   * the new site's card — mounting in the same commit, and reader-initiated —
   * focuses its own heading last. That ordering is also what makes the card's
   * captured opener the add-site control rather than the submit button that just
   * left the document, so closing the card afterwards lands somewhere real.
   * `Dashboard.focus.test.tsx`'s creation case is what holds it honest rather
   * than a comment claiming it.
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
    // A creation is a reader-initiated selection like any other: they placed the
    // site, so its card announces itself and takes the focus.
    selectSiteForReader(result.value.id);
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
    <>
      {/*
       * The bar, and the reason it is here rather than in the shell: its search
       * reads `sites` and selects through `selectSiteForReader`, which is the
       * same selection a marker press and a row press make
       * (`header/AppHeader.tsx`). A search hit is reader-initiated by
       * construction, so the card it opens focuses its own heading and
       * `SelectionCamera` brings a site that is off screen into frame — neither
       * of which this component had to be told anything new to do.
       *
       * A sibling of `<main>` rather than a child of it: a `<header>` inside
       * `<main>` is a section header and carries no banner landmark.
       */}
      <AppHeader
        theme={theme}
        onToggleTheme={onToggleTheme}
        sites={sites}
        onSelectSite={selectSiteForReader}
      />

      <main className="app-main">
        <div className="dashboard">
          <div className="dashboard-map" ref={mapRegionRef}>
            <MapRegionSlot
              theme={theme}
              sites={sites}
              selectedSiteId={selectedSiteId}
              onSelectSite={selectSiteForReader}
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
              selectedSite={selectedSite}
              selectionOrigin={selectionOrigin}
              firstForecast={forecast}
              onRetryFirstForecast={retryForecast}
              onDeselectSite={() => {
                // State only. Where focus goes on the way out is the card's own
                // business, from the unmount this triggers — it captured the element
                // that opened it, which is the one thing the dashboard cannot see.
                setSelectedSiteId(null);
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
             * The fleet's chart, first under the map and never displaced.
             *
             * There is no context region here any more. One region showing either a
             * site or the fleet was the shape the reading had while a site's detail
             * was a panel in this flow; the detail is a card on the site's own marker
             * now, so nothing swaps, nothing is hidden, and the fleet chart is on
             * screen in every state of the page.
             *
             * The selection reaches it as an overlay rather than as a replacement,
             * which is the whole argument for the move: a reader comparing one roof
             * against the fleet was previously asked to remember one chart while
             * looking at the other. The fleet's sum still changes on exactly one
             * event — a site being added — and `refreshToken` is that event, counted.
             */}
            <FleetPanel
              dataSource={dataSource}
              sites={sites}
              selectedSite={selectedSite}
              selectionReady={forecast.status === 'ready'}
              refreshToken={createdSites.length}
            />

            {/*
             * The fleet as a table, folded away (#265). It used to be a section
             * with a `Sites` heading and sixty rows open under it, which is the
             * tallest thing this page could hold and the reason everything below
             * it was off screen. Looking a site up by name is the header
             * search's job now, so the table keeps the role
             * `map-treatment.md` gives it — the map's table view, every marker
             * state with a row equivalent — from behind its own summary, which
             * names the section the way the heading did.
             *
             * No wrapper section, and none needed: the disclosure is its own
             * labelled box, and a `<section>` whose heading had gone would have
             * been a landmark with nothing to name it.
             */}
            <div className="dashboard-fleet">
              <FleetSection
                load={load}
                sites={sites}
                selectedSiteId={selectedSiteId}
                onSelectSite={selectSiteForReader}
                onRetryLoad={() => {
                  setListAttempt((attempt) => attempt + 1);
                }}
              />
            </div>

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
           * A sibling of the whole surface rather than a child of the reading,
           * because a modal is painted over the whole page — nesting it inside the
           * flow would only leave a reader of this file placing it there. (It was an
           * occupant of the context region until #265, and that region is gone
           * entirely now, so there is not even a box left to nest it in.)
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
      </main>
    </>
  );
};
