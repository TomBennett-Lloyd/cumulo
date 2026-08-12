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
import type { SelectionOrigin } from './selection-origin';
import { readSiteIdFromSearch, writeSiteIdToUrl } from './selection-url';

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

/*
 * There is no `FleetSection` here any more, and #452 is where it went.
 *
 * It was the listing's own account of itself — a pending label, and a failure
 * with the source's message and a retry — and it was the last occupant of the
 * sites section after the fleet's table left the page in #451. The owner routed
 * both states into the chart instead: *"the sites fetch error state should show
 * in the graph area … this can be the generic error message for anything that
 * means we can't show data on the graph"*. So the listing's status is a prop of
 * `FleetPanel` now (`listing`, below), the failure is the chart's own in-figure
 * alert, and the wait is the trace the chart already draws for a query that has
 * not run. Nothing was dropped: what changed is that the reader is told where
 * they are looking rather than in a box under it, and one fewer element arrives
 * and leaves above the fold.
 */

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
 * `selectedSiteId` is the clearest case — the markers, the card on the map, the
 * header's search and the chart's overlay all render from that one value, which
 * is what makes selecting a site on the map and picking it out of the search the
 * same act rather than views that agree by luck. That one value is also what `?site=`
 * addresses: `selection-url.ts` is the whole of the deep link, and the dashboard
 * reads it once at mount and writes it whenever the selection moves.
 *
 * A selection has a second half here, `selectionOrigin`, and it exists for one
 * rule: a selection nobody asked for is not owed a landing on the way out
 * (`selection-origin.ts`, the clause of #260 that outlived the landing #328
 * removed).
 *
 * Nothing under the map swaps any more. One region alternating between a site's
 * panel and the fleet's was the shape the reading had until #265; a site's
 * detail is now a card anchored to its own marker, so the reading below is a
 * plain flow — the fleet's chart, then the credit, since #451 and #452 took the
 * fleet's table and then the listing's own states out of it — and a selection
 * changes what is *drawn on* those surfaces rather than which of them is there.
 * The flow is also the shortest it has been: every state the page can be in is
 * now reported on a surface that is already there, so nothing arrives above the
 * fold and pushes the chart down.
 * Placing a site is a modal over the whole page
 * (`add-site/AddSiteDialog.tsx`). `docs/design/dashboard-composition.md` records
 * the reasoning and what it is buying.
 *
 * Two things it deliberately never does. It never re-lists the fleet on a
 * cadence: the listing is a mount-time request that only an explicit retry asks
 * for again, and a dashboard that polled it would be treating the fleet as
 * something to re-ask on a clock — which is the habit ADR 0002's review of this
 * ticket priced. The listing itself is the cheap half (one Query over the
 * `FLEET` partition, ~2 read units on `sites`); what sits beside it is the
 * expensive half, the two fleet series reads at ~25 read units on `series`
 * each — every site's partition, once for the forecasts and once for the
 * simulated actuals — against a per-site forecast poll's ~0.5. Since #264 and
 * #296 those Queries run server-side inside one request each; the per-load
 * arithmetic and its history are owned by the `series` section of
 * `infra/storage/tables.tf`. And it never invents a site id: the id it
 * watches for a forecast is the one `createSite` returned, because a locally
 * predicted id addresses a site that does not exist.
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
   * Who asked for the current selection — the fact the card's hand-back turns on
   * (`selection-origin.ts`, settling #260).
   *
   * It starts at `'deep-link'` because that is the only thing the initialiser
   * above can be answering: at mount the selection is whatever the address bar
   * carried, and nobody has done anything yet. Every handler that moves the
   * selection sets `'reader'` in the same commit, so the two values cannot
   * disagree about a selection either of them can see. It is deliberately not
   * cleared alongside a deselection: with no site there is no card to read it,
   * and a value nothing reads is a value nothing can be wrong about.
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
   * A dependency would make a creation re-run the listing, and the listing is a
   * read this dashboard re-spends only when something asks it to: once at mount,
   * and once more per explicit retry (`listAttempt` above), never as a side
   * effect of unrelated state moving. But the stale-id guard below still has to
   * count a created site as known: a reader whose listing failed can add a site,
   * select it, and then retry the listing — and a guard that only knew the
   * listing's sites would clear the selection of a site sitting right there in
   * the list.
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
   * every opener — a marker, the header's search, a creation — without the
   * dashboard knowing which happened, and without needing an answer of its own
   * the next time one is added. That generality is what made removing the list
   * cost nothing here: one opener fewer, and not a line to change. Since #328 a selection moves nobody into the
   * card in the first place, so that hand-back is owed only to a reader who came
   * into it afterwards, and this component holds no focus target of its own at
   * all: the only landing left here is the dismissed draft's, below.
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
   * takes no focus after it (#328). This is therefore the *last* focus move a
   * creation makes, and the same ordering is what makes the card's captured
   * opener the add-site control rather than the submit button that just left the
   * document, so a reader who then comes into the card and closes it lands back
   * where they are standing now. `Dashboard.focus.test.tsx`'s creation cases are
   * what hold both halves honest rather than a comment claiming them.
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
    // than re-listed: one listing request avoided, and the site is already in hand.
    setCreatedSites((current) => [...current, result.value]);
    // A creation is a reader-initiated selection like any other: they placed the
    // site, so its card owes them a hand-back if they go into it — and, like
    // every other selection, moves their focus nowhere on the way in (#328).
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
       * same selection a marker press makes (`header/AppHeader.tsx`). Since the
       * fleet's own listing left the page it is also one of only two ways to
       * reach a site at all, the map being the other. A search hit is
       * reader-initiated by
       * construction, so the reader keeps their place in the combobox while
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
           * The fleet's chart, as a full-width band directly under the map and
           * never displaced.
           *
           * A sibling of `.dashboard-map` rather than the first card inside the
           * reading, which is #323's structural half. The map and the chart are
           * one reading unit — the same fleet, drawn in space and then in time —
           * and the measure, the padding and the card edge between them were all
           * claiming a separation nobody meant (`design.md` rule 4). The two
           * surfaces now share a continuous `--color-surface` band with no gap
           * between them (`.dashboard { gap: 0 }`), and the centred measure picks
           * up again below, where the reading genuinely is a separate thing.
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
            listing={load.status}
            onRetryListing={() => {
              setListAttempt((attempt) => attempt + 1);
            }}
            selectedSite={selectedSite}
            selectionReady={forecast.status === 'ready'}
            refreshToken={createdSites.length}
          />

          {/*
           * A `div` rather than the `<aside>` this used to be. `aside` marks a
           * complementary landmark — content beside the thing the page is about —
           * which is what this was while it sat in a column next to the map. It is
           * the page's own reading now, running under the map inside `<main>`, so
           * the landmark would be describing a shape the layout no longer has.
           */}
          <div className="dashboard-content">
            {/*
             * The credit is all that is left down here, and both removals that
             * emptied the box were the owner's. The fleet was drawn as a table —
             * a `Sites` heading with sixty rows open under it until #265, then
             * the same rows folded behind a summary — and it went on 2026-08-12
             * (#451): the sites are on the map and in the header's search, so a
             * third listing of them was a third place to keep level with the
             * other two. The listing's own pending and failure states outlived it
             * by one ticket and went into the chart in #452 (see the note where
             * `FleetSection` used to be).
             *
             * The box stays because the credit is the page's rather than the
             * chart band's, and the measure and padding that separate the two are
             * this box's (`dashboard.css`).
             */}

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
