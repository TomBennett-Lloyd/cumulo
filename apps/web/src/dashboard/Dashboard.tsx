import type { CreateSiteInput, Site } from '@cumulo/shared';
import { OpenMeteoAttribution } from '@cumulo/ui';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { AddSiteForm } from '../add-site/AddSiteForm';
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
 * The fleet column's contents: the list, or an honest account of why there is
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
 * accessible; `PanelPending` is a plain `aria-busy` container instead. The
 * column's live regions are now two, which is the pair `react.md`'s amended
 * live-region bullet registers: this failure's `role="alert"`, which really does
 * arrive as a change, and the chart readout a panel above brings with it
 * (`.forecast-chart-readout`, mounted empty with the chart and filled only when
 * a reader moves its selection).
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
 * The fleet dashboard: the map as the canvas, the panel column beside it, and
 * the flow that turns a click on the map into a site with a forecast.
 *
 * This is where the pieces meet, and it owns exactly the state they share.
 * `selectedSiteId` is the clearest case — the markers, the list rows and the
 * context panel all render from that one value, which is what makes selecting a
 * site on the map and selecting it in the list the same act rather than two
 * views that agree by luck. That one value is also what `?site=` addresses:
 * `selection-url.ts` is the whole of the deep link, and the dashboard reads it
 * once at mount and writes it whenever the selection moves.
 *
 * The column is a context swap, not a set of stacked slots: one region shows the
 * fleet's story, one site's, or a draft, and which one is a function of state
 * rather than of a page the reader navigated to. `docs/design/dashboard-composition.md`
 * records the rule and what it is buying.
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
  /** The fleet column's box, searched for the row a closing panel hands focus back to. */
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
  // (`react.md` rule 1). The column is one scroller over an unbounded site
  // list, so a reader who has scrolled to row forty and clicks a marker gets
  // their answer written into a region that is now off the top of the screen:
  // the swap happens, and the feedback is invisible. This puts the region back
  // where it can be read.
  //
  // It cannot be a line in the click handlers, for the reason the URL effect
  // cannot either: a context also arrives without a click — a creation selects
  // the site it just made, and a `?site=` link opens on one.
  //
  // Only *into* a context, never out of one. Closing a panel hands the same
  // region back to the fleet, and a column that jumped on the way out would
  // move ground the reader did not ask to move. `block: 'start'` and the
  // default (instant) behaviour rather than smooth scrolling: this is feedback
  // for an action already taken, not an animation, and it must not fight a
  // reader who scrolls immediately after clicking.
  useEffect(() => {
    if (selectedSiteId === null && draft === null) {
      return;
    }

    contextRegionRef.current?.scrollIntoView({ block: 'start' });
  }, [selectedSiteId, draft]);

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

  const closeDraft = (): void => {
    setDraft(null);
    setCreation({ status: 'editing' });

    // A cancelled draft hands the region to whatever takes it back, and that
    // occupant focuses its own heading — a re-mounting `SitePanel`. So the
    // question here is precisely "is a panel about to remount?", and the value
    // that answers it is `selectedSite`, because that is what the panel's own
    // render condition below tests.
    //
    // Not `selectedSiteId`: the two come apart exactly when a selection names a
    // site nothing can show — a `?site=` deep link whose listing failed, or has
    // not landed yet — and there the id is set while the site is null. Guarding
    // on the id would skip this focus *and* mount no panel to claim it, so
    // focus would fall to body as the Cancel button unmounts, which is the one
    // defect this whole mechanism exists to remove.
    //
    // When it is null nothing is remounting: the fleet panel was there all
    // along, merely hidden, so the region itself is the only honest target and
    // it takes focus here rather than growing focus logic inside `FleetPanel`
    // that would race the row focus on close.
    if (selectedSite === null) {
      contextRegionRef.current?.focus();
    }
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
      <div className="dashboard-map">
        <MapRegionSlot
          theme={theme}
          sites={sites}
          selectedSiteId={selectedSiteId}
          onSelectSite={(siteId) => {
            setSelectedSiteId(siteId);
          }}
          onMapClick={(position) => {
            setDraft(position);
            setCreation({ status: 'editing' });
          }}
        />
      </div>

      <aside className="dashboard-aside">
        {/*
         * The context region: one of three things, in a fixed place.
         *
         * A draft outranks a selection but deliberately does not clear it. The
         * two are different questions — "where shall the new site go" and
         * "which site am I reading" — and cancelling a draft should hand the
         * reader back the site they had open rather than the fleet they had
         * left. That is why the site panel's condition tests `draft` rather
         * than the dashboard clearing `selectedSiteId` when a draft opens.
         *
         * The three occupants share one wrapping element because "the context
         * region" has to be addressable to be scrolled to, and because exactly
         * one of them is ever visible — the box is the region, not a stack.
         */}
        {/*
         * `tabIndex={-1}` makes the region a focus target without putting it in
         * the tab order: it is where focus lands when a draft is cancelled and
         * no panel is remounting to claim it.
         */}
        <div className="dashboard-context" ref={contextRegionRef} tabIndex={-1}>
          {draft !== null && (
            <AddSiteForm
              key={draftKey(draft)}
              latitude={draft.latitude}
              longitude={draft.longitude}
              submitting={creation.status === 'submitting'}
              refusal={creation.status === 'refused' ? creation.refusal : null}
              error={creation.status === 'failed' ? creation.message : null}
              onSubmit={handleSubmit}
              onCancel={closeDraft}
            />
          )}

          {draft === null && selectedSite !== null && (
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
           */}
          <FleetPanel
            dataSource={dataSource}
            sites={sites}
            hidden={draft !== null || selectedSite !== null}
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
         * The column's one weather credit, at its foot rather than inside a
         * panel. Every panel above it shows Open-Meteo-derived numbers, and a
         * credit that lived in one of them would come and go with a selection
         * — eventually absent exactly when it mattered. The map carries its own
         * in its strip; two credits on one screen is the design, not an
         * oversight (CC BY 4.0, CLAUDE.md hard constraints).
         */}
        <footer className="dashboard-aside-footer">
          <OpenMeteoAttribution />
        </footer>
      </aside>
    </div>
  );
};
