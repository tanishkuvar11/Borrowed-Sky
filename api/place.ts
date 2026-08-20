/**
 * Reverse geocoding: coordinates in, the name of the place and its timezone out.
 *
 * This is the one place in Borrowed Sky where something about the user leaves
 * the machine they are standing on. Everything else here is computed in the
 * browser from catalogues the app ships, and the two existing network paths
 * carry nothing personal: Celestrak is asked for orbital elements, and watsonx
 * is sent a sky that has already been computed. A place name cannot be worked
 * out from first principles, so it is asked for, and the honest thing is to say
 * so plainly rather than to bury it.
 *
 * Three things follow from that, and they are the whole design of this file.
 *
 * The coordinates are rounded to two decimal places before they go anywhere.
 * That is a little over a kilometre, which is the difference between naming the
 * town somebody is in and naming their street, and the town is all that is
 * being asked for. It also means the cache below is hit by everybody in the
 * same square rather than once per GPS fix.
 *
 * Nothing is invented when the lookup fails. There is no "somewhere near" and
 * no guessed country: the endpoint reports the failure and the plate goes on
 * showing the coordinates it already had, which were computed and are true.
 *
 * And it stays a narrow pipe. Two fixed upstreams, no pass-through of anything
 * the caller sends beyond a latitude and a longitude, so this cannot be used as
 * a general proxy by anybody who finds it.
 */

import { queryParam, sendJson, type ApiRequest, type ApiResponse } from './_lib/http.js';

/**
 * OpenStreetMap's own geocoder, for the name.
 *
 * Chosen over the commercial services because the data is open, there is no key
 * to leak, and its usage policy is a published document rather than a contract.
 * That policy asks for a real User-Agent identifying the application and no
 * more than one request a second, both of which the cache and the rounding
 * above make comfortable at this scale.
 */
const NOMINATIM = 'https://nominatim.openstreetmap.org/reverse';

/**
 * Open-Meteo, for the timezone.
 *
 * Nominatim does not return one, and a timezone is not something that can be
 * derived from a longitude: the boundaries are political, they bend around
 * borders, and half of India is offset by thirty minutes from anything a
 * fifteen-degrees-an-hour calculation would produce. Open-Meteo resolves the
 * real IANA zone for a coordinate, without a key, so it is asked for that and
 * nothing else. No weather variables are requested.
 */
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

const UA = 'BorrowedSky/1.0 (https://github.com/tanishkuvar11/Borrowed-Sky; sky guide)';

/**
 * A day. Places do not move, and the answer for a given square kilometre is the
 * same tomorrow as it is now.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

interface Place {
  /** Something a person would say out loud: "Mangaluru, India". */
  name: string | null;
  /** IANA zone at those coordinates, which is not necessarily the device's. */
  timezone: string | null;
}

interface CacheEntry {
  fetchedAt: number;
  place: Place;
}
const cache = new Map<string, CacheEntry>();

/**
 * Two decimal places, and the rounded pair is what is sent upstream as well as
 * what keys the cache. Done once, here, so there is no path through this file
 * where the caller's exact position reaches a third party.
 */
function coarse(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The shortest true name for somewhere.
 *
 * Nominatim returns a full postal address, which for a stargazer standing in a
 * field is mostly noise: the house number, the road, the district, the postcode
 * and the state are all correct and none of them is the answer to "where am I".
 * So this walks from the most specific thing that is still a settlement down to
 * the least, and pairs it with the country.
 */
function shortName(address: Record<string, unknown> | undefined): string | null {
  if (!address) return null;

  const settlement = [
    'city',
    'town',
    'village',
    'municipality',
    'hamlet',
    'suburb',
    'county',
    'state_district',
    'state',
  ]
    .map((key) => address[key])
    .find((value): value is string => typeof value === 'string' && value.length > 0);

  const country = typeof address.country === 'string' ? address.country : null;

  if (settlement && country) return `${settlement}, ${country}`;
  return settlement ?? country ?? null;
}

async function lookupName(lat: number, lon: number): Promise<string | null> {
  /*
   * zoom=10 asks for the city level. Left at the default, Nominatim answers a
   * rural coordinate with the name of the nearest individual building, which is
   * both wrong as an answer to this question and more than anybody asked to
   * have looked up about them.
   */
  const url =
    `${NOMINATIM}?format=jsonv2&zoom=10&addressdetails=1` +
    `&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`nominatim responded ${res.status}`);

  const body = (await res.json()) as { address?: Record<string, unknown> };
  return shortName(body.address);
}

async function lookupTimezone(lat: number, lon: number): Promise<string | null> {
  const url =
    `${OPEN_METEO}?timezone=auto&forecast_days=1` +
    `&latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`open-meteo responded ${res.status}`);

  const body = (await res.json()) as { timezone?: unknown };
  return typeof body.timezone === 'string' ? body.timezone : null;
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const lat = Number(queryParam(req, 'lat'));
  const lon = Number(queryParam(req, 'lon'));

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    sendJson(res, 400, {
      error: 'bad_coordinates',
      message: 'lat and lon must be numbers within the usual ranges.',
    });
    return;
  }

  const roundedLat = coarse(lat);
  const roundedLon = coarse(lon);
  const key = `${roundedLat},${roundedLon}`;

  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    sendJson(res, 200, { ...cached.place, cached: true }, 86_400);
    return;
  }

  /*
   * Both at once, and neither is allowed to sink the other. A name with no
   * timezone is still worth showing, and so is a timezone with no name; only
   * losing both is a failure worth reporting, because at that point the answer
   * is empty and the plate is better off with the coordinates it already has.
   */
  const [name, timezone] = await Promise.all([
    lookupName(roundedLat, roundedLon).catch(() => null),
    lookupTimezone(roundedLat, roundedLon).catch(() => null),
  ]);

  if (name === null && timezone === null) {
    sendJson(res, 502, {
      error: 'lookup_failed',
      message: 'Neither the name nor the timezone could be looked up for those coordinates.',
    });
    return;
  }

  const place: Place = { name, timezone };
  cache.set(key, { fetchedAt: Date.now(), place });
  sendJson(res, 200, { ...place, cached: false }, 86_400);
}
