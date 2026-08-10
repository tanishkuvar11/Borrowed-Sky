/**
 * The observer's position on Earth — the one input every calculation needs.
 *
 * Geolocation is asked for, never assumed. If it is refused or unavailable the
 * app takes coordinates by hand rather than guessing from an IP address, which
 * would silently produce a sky for the wrong place.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ObserverSite } from '../lib/astro/types';

export type LocationStatus = 'idle' | 'requesting' | 'ready' | 'denied' | 'unavailable';

const STORAGE_KEY = 'borrowed-sky:site';

function load(): ObserverSite | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ObserverSite;
    if (
      typeof parsed.latitude !== 'number' ||
      typeof parsed.longitude !== 'number' ||
      Math.abs(parsed.latitude) > 90 ||
      Math.abs(parsed.longitude) > 180
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function save(site: ObserverSite | null) {
  try {
    if (site) localStorage.setItem(STORAGE_KEY, JSON.stringify(site));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private browsing can block storage; the app still works for this session.
  }
}

export function useObserverSite() {
  const [site, setSite] = useState<ObserverSite | null>(load);
  const [status, setStatus] = useState<LocationStatus>(() => (load() ? 'ready' : 'idle'));
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    save(site);
  }, [site]);

  const requestGps = useCallback(() => {
    if (!('geolocation' in navigator)) {
      setStatus('unavailable');
      setError('This browser cannot report your location.');
      return;
    }

    setStatus('requesting');
    setError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        setSite({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          elevation: position.coords.altitude ?? 0,
          source: 'gps',
        });
        setStatus('ready');
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          setStatus('denied');
          setError('Location was blocked. Enter your coordinates instead, or allow location and try again.');
        } else {
          setStatus('unavailable');
          setError(
            err.code === err.TIMEOUT
              ? 'Finding your location took too long. Try again, or enter coordinates by hand.'
              : 'Your location could not be determined. Enter coordinates by hand instead.',
          );
        }
      },
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 5 * 60_000 },
    );
  }, []);

  const setManual = useCallback((latitude: number, longitude: number, label?: string) => {
    setSite({ latitude, longitude, elevation: 0, source: 'manual', label });
    setStatus('ready');
    setError(null);
  }, []);

  const clear = useCallback(() => {
    setSite(null);
    setStatus('idle');
    setError(null);
  }, []);

  return { site, status, error, requestGps, setManual, clear };
}

/**
 * Times are always shown in the device's own timezone. That is right for the
 * ordinary case — you are standing where you are — but wrong if someone types
 * in coordinates on the far side of the world, so the interface says so when
 * the two clearly disagree.
 */
export function timezoneMismatch(site: ObserverSite | null): boolean {
  if (!site || site.source !== 'manual') return false;
  const deviceOffsetHours = -new Date().getTimezoneOffset() / 60;
  const solarOffsetHours = site.longitude / 15;
  return Math.abs(deviceOffsetHours - solarOffsetHours) > 3;
}
