/**
 * The observer's position on Earth: the one input every calculation needs.
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
  const [permission, setPermission] = useState<PermissionState | 'unknown'>('unknown');

  useEffect(() => {
    save(site);
  }, [site]);

  /**
   * "Refused" covers two different situations that need different advice: a
   * prompt that was answered no, and a prompt that was never allowed to appear
   * because location is switched off for the browser at the OS level. The
   * Geolocation API reports both as PERMISSION_DENIED. The Permissions API can
   * tell them apart: 'prompt' means the browser still intends to ask, so a
   * denial arriving anyway points outside the browser.
   */
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let live = true;
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((result) => {
        if (!live) return;
        setPermission(result.state);
        result.onchange = () => setPermission(result.state);
      })
      .catch(() => {
        // Safari has historically not supported querying this. Not knowing is a
        // valid answer; it just means the guidance stays general.
      });
    return () => {
      live = false;
    };
  }, []);

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
          setError(
            'Your browser refused to share your location. Nothing is lost: typing coordinates in gives exactly the same sky.',
          );
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

  return { site, status, error, permission, requestGps, setManual, clear };
}
