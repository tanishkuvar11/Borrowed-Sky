/**
 * Resolves the name and timezone of wherever the observer is standing.
 *
 * Keyed on the rounded coordinates rather than on the site object, so the
 * lookup does not restart every time a GPS fix wobbles by a few metres or the
 * hook re-renders with a fresh object holding the same numbers.
 */

import { useEffect, useState } from 'react';

import { lookupPlace, type Place } from '../lib/place';
import type { ObserverSite } from '../lib/astro/types';

export function usePlace(site: ObserverSite | null): Place | null {
  const [place, setPlace] = useState<Place | null>(null);

  const latitude = site ? Math.round(site.latitude * 100) / 100 : null;
  const longitude = site ? Math.round(site.longitude * 100) / 100 : null;

  useEffect(() => {
    if (latitude === null || longitude === null) {
      setPlace(null);
      return;
    }

    let cancelled = false;
    // Cleared first, so moving somewhere else never shows the old name beside
    // the new coordinates while the answer for those is still in the air.
    setPlace(null);
    lookupPlace(latitude, longitude).then((found) => {
      if (!cancelled) setPlace(found);
    });

    return () => {
      cancelled = true;
    };
  }, [latitude, longitude]);

  return place;
}
