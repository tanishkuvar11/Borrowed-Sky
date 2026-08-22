/**
 * Assembles everything the app knows about the sky for one place.
 *
 * Three cadences, because the underlying data changes at three speeds:
 *   - the star catalogue and orbital elements load once,
 *   - Sun/Moon/planet/satellite positions refresh every second,
 *   - the night's timeline is rebuilt every few minutes.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  loadConstellations,
  loadStarCatalog,
  type ConstellationFigure,
  type StarCatalog,
} from '../lib/astro/starfield';
import { computeConditions, computeSolarSystem } from '../lib/astro/solar';
import { requestedInstant } from '../lib/instant';
import {
  loadTleSet,
  satellitesAboveHorizon,
  type TleSet,
} from '../lib/astro/satellites';
import { buildTimeline, type TonightTimeline } from '../lib/astro/events';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';

const POSITION_REFRESH_MS = 1000;
const TIMELINE_REFRESH_MS = 5 * 60_000;
const TLE_REFRESH_MS = 3 * 60 * 60_000;

export interface SkyData {
  catalog: StarCatalog | null;
  constellations: ConstellationFigure[];
  /** Sun, Moon, planets, plus any tracked satellite currently above the horizon. */
  bodies: SkyBody[];
  conditions: SkyConditions | null;
  timeline: TonightTimeline | null;
  tleSet: TleSet | null;
  now: Date;
  /**
   * The instant the URL pinned the app to, or null on the ordinary live clock.
   *
   * Present so the interface can say which of the two it is showing. A sky
   * computed for a moment three weeks away, with nothing on screen admitting
   * it, is the one kind of wrong this app is built not to be.
   */
  pinnedInstant: Date | null;
  catalogError: string | null;
  satelliteError: string | null;
  loadingCatalog: boolean;
  refreshSatellites: () => void;
}

export function useSkyData(site: ObserverSite | null): SkyData {
  const [catalog, setCatalog] = useState<StarCatalog | null>(null);
  const [constellations, setConstellations] = useState<ConstellationFigure[]>([]);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  const [tleSet, setTleSet] = useState<TleSet | null>(null);
  const [satelliteError, setSatelliteError] = useState<string | null>(null);
  const [tleNonce, setTleNonce] = useState(0);

  /*
   * Read once, at mount. The parameter is not going to change underneath the
   * app, and re-reading it every tick would make the clock depend on the URL
   * bar rather than on the moment the page was opened.
   */
  const [pinnedInstant] = useState(() => requestedInstant());
  const [now, setNow] = useState(() => pinnedInstant ?? new Date());
  const [timeline, setTimeline] = useState<TonightTimeline | null>(null);

  // --- catalogues: once ---
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const [stars, figures] = await Promise.all([
          loadStarCatalog(controller.signal),
          loadConstellations(controller.signal),
        ]);
        if (cancelled) return;
        setCatalog(stars);
        setConstellations(figures);
        setCatalogError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setCatalogError(
          err instanceof Error ? err.message : 'The star catalogue could not be loaded.',
        );
      } finally {
        if (!cancelled) setLoadingCatalog(false);
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  // --- orbital elements: once, then every few hours ---
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const set = await loadTleSet('stations', controller.signal);
        if (cancelled) return;
        setTleSet(set);
        setSatelliteError(null);
      } catch (err) {
        if (cancelled || controller.signal.aborted) return;
        setTleSet(null);
        setSatelliteError(
          err instanceof Error
            ? err.message
            : 'Orbital elements could not be reached, so satellite passes are unavailable.',
        );
      }
    })();

    const interval = setInterval(() => setTleNonce((n) => n + 1), TLE_REFRESH_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(interval);
    };
  }, [tleNonce]);

  // --- clock ---
  useEffect(() => {
    // A pinned instant is a held instrument, so nothing advances it.
    if (pinnedInstant) return;
    const interval = setInterval(() => setNow(new Date()), POSITION_REFRESH_MS);
    return () => clearInterval(interval);
  }, [pinnedInstant]);

  // --- positions: every tick ---
  const bodies = useMemo<SkyBody[]>(() => {
    if (!site) return [];
    const { sun, moon, planets } = computeSolarSystem(now, site);
    const satellites = tleSet ? satellitesAboveHorizon(tleSet.records, now, site, 0) : [];
    return [sun, moon, ...planets, ...satellites];
  }, [site, now, tleSet]);

  const conditions = useMemo<SkyConditions | null>(
    () => (site ? computeConditions(now, site) : null),
    // Conditions change slowly; recomputing each second is cheap and keeps the
    // twilight readout honest as the sky actually changes.
    [site, now],
  );

  // --- timeline: on site change, then every few minutes ---
  const timelineKeyRef = useRef('');
  const rebuildTimeline = useCallback(() => {
    if (!site) {
      setTimeline(null);
      return;
    }
    setTimeline(buildTimeline(new Date(), site, tleSet, satelliteError ?? undefined));
  }, [site, tleSet, satelliteError]);

  useEffect(() => {
    if (!site) return;
    // The zone is in the key because the timeline bakes formatted times into its
    // own prose: "appears at 12:29 AM" is part of a sentence, not a Date the view
    // can reformat later. When the lookup answers, those sentences are rebuilt.
    const key = `${site.latitude.toFixed(3)},${site.longitude.toFixed(3)},${site.timezone ?? ''},${tleSet?.fetchedAt ?? 0}`;
    if (timelineKeyRef.current !== key) {
      timelineKeyRef.current = key;
      rebuildTimeline();
    }
    const interval = setInterval(rebuildTimeline, TIMELINE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [site, tleSet, rebuildTimeline]);

  const refreshSatellites = useCallback(() => setTleNonce((n) => n + 1), []);

  return {
    catalog,
    constellations,
    bodies,
    conditions,
    timeline,
    tleSet,
    now,
    pinnedInstant,
    catalogError,
    satelliteError,
    loadingCatalog,
    refreshSatellites,
  };
}
