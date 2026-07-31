import type { CreateSiteInput, Site } from '@cumulo/shared';
import type { ReactElement } from 'react';
import { useEffect, useMemo, useState } from 'react';

import { AddSiteForm } from '../add-site/AddSiteForm';
import type { CreationRefusal } from '../add-site/creation-throttle';
import { CreationThrottle } from '../add-site/creation-throttle';
import { DemoFleetDataSource } from '../data/demo-fleet-data-source';
import type { FleetDataSource } from '../data/fleet-data-source';
import { useFirstForecast } from '../data/use-first-forecast';
import type { MapPosition } from '../map/MapView';
import type { Theme } from '../theme';
import type { MapRegionComponent } from './MapRegion';
import { MapRegion } from './MapRegion';
import { SiteDetailPanel } from './SiteDetailPanel';
import { SiteList } from './SiteList';

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
 * The fleet the app runs against until the Fleet API exists (#14, wired in C8).
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
 */
const FleetSection = ({
  load,
  sites,
  selectedSiteId,
  onSelectSite,
  onRetryLoad,
}: FleetSectionProps): ReactElement => {
  if (load.status === 'loading') {
    return (
      <p className="dashboard-slot-note" role="status">
        Loading the fleet…
      </p>
    );
  }

  return (
    <>
      {load.status === 'failed' && (
        <div className="dashboard-failure" role="alert">
          <p className="dashboard-failure-message">Fleet unavailable: {load.message}</p>
          <button type="button" className="dashboard-retry" onClick={onRetryLoad}>
            Try again
          </button>
        </div>
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
  /** The map half. Defaults to the real one — see {@link MapRegionComponent}. */
  readonly mapRegion?: MapRegionComponent;
}

/**
 * The fleet dashboard: the map, the fleet as text beside it, and the flow that
 * turns a click on the map into a site with a forecast.
 *
 * This is where the pieces meet, and it owns exactly the state they share.
 * `selectedSiteId` is the clearest case — the markers, the list rows and the
 * detail panel all render from that one value, which is what makes selecting a
 * site on the map and selecting it in the list the same act rather than two
 * views that agree by luck.
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
  mapRegion: MapRegionSlot = MapRegion,
}: DashboardProps): ReactElement => {
  const [load, setLoad] = useState<FleetLoad>({ status: 'loading' });
  /** Bumping this is how the retry button asks the listing effect to run again. */
  const [listAttempt, setListAttempt] = useState(0);
  const [createdSites, setCreatedSites] = useState<readonly Site[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState<Site['id'] | null>(null);
  const [draft, setDraft] = useState<MapPosition | null>(null);
  const [creation, setCreation] = useState<CreationState>({ status: 'editing' });
  /**
   * One throttle per tab, at its shipped limits. Constructed lazily so its
   * window is anchored to this dashboard rather than to module import, and held
   * in state so no re-render can hand the visitor a fresh allowance.
   */
  const [throttle] = useState(() => new CreationThrottle());

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

      setLoad(
        result.kind === 'ok'
          ? { status: 'ready', sites: result.value }
          : { status: 'failed', message: result.error.message },
      );
    });

    return () => {
      cancelled = true;
    };
  }, [dataSource, listAttempt]);

  // Derived during render rather than mirrored into state. Memoised for
  // identity rather than speed: this array is what the map clusters, and a
  // fresh one every render would rebuild the cluster index every render.
  const sites = useMemo(() => [...loadedSites(load), ...createdSites], [load, createdSites]);
  const selectedSite = sites.find((site) => site.id === selectedSiteId) ?? null;

  /*
   * The panel's forecast follows the selection rather than only the newly
   * created site. One loop serves both, because they are the same question
   * asked of different sites: an established site answers on the first poll and
   * the loop stops, while a site created seconds ago answers `not-found` until
   * its first forecast exists — which is the pending state the demo's headline
   * minute is made of.
   */
  const { state: forecast, retry: retryForecast } = useFirstForecast(dataSource, selectedSiteId);

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

        <section className="dashboard-slot" aria-labelledby="dashboard-sites-heading">
          <h2 className="dashboard-slot-heading" id="dashboard-sites-heading">
            Sites
          </h2>
          <div className="dashboard-fleet">
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

        {selectedSite === null ? (
          <section className="dashboard-slot" aria-labelledby="dashboard-detail-heading">
            <h2 className="dashboard-slot-heading" id="dashboard-detail-heading">
              Site detail
            </h2>
            <p className="dashboard-slot-note">
              Selecting a site — on the map or in the list — opens its forecast here. Clicking the
              map anywhere else adds a site at that spot.
            </p>
          </section>
        ) : (
          <SiteDetailPanel
            site={selectedSite}
            forecast={forecast}
            onClose={() => {
              setSelectedSiteId(null);
            }}
            onRetry={retryForecast}
          />
        )}
      </aside>
    </div>
  );
};
