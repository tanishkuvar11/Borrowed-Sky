/**
 * Satellite tracking and visible-pass prediction.
 *
 * Orbital elements come from Celestrak (free, no key) through this app's own
 * /api/tle proxy, and are propagated with SGP4 via satellite.js. Nothing here
 * is approximated from a schedule or a lookup table; every pass time is
 * searched for numerically from the elements.
 *
 * A pass being *above the horizon* is not the same as a pass being *visible*.
 * A satellite is only seen when it is in sunlight while the observer is in
 * darkness, so this module tests both and reports them separately. That
 * distinction is the difference between telling someone to go outside and
 * wasting their evening.
 */

import {
  degreesLat,
  degreesLong,
  ecfToLookAngles,
  eciToEcf,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
  type EciVec3,
  type SatRec,
} from 'satellite.js';

import {
  Body,
  Equator,
  GeoVector,
  Horizon,
  MakeTime,
  Rotation_EQJ_EQD,
  RotateVector,
} from 'astronomy-engine';

import type { ObserverSite, SkyBody } from './types.js';
import { toObserver } from './solar.js';

const RAD = 180 / Math.PI;
const EARTH_RADIUS_KM = 6378.137;
/** Shadow is grown by the sensible depth of atmosphere, so grazing cases lean dark. */
const SHADOW_RADIUS_KM = EARTH_RADIUS_KM + 25;

export const ISS_NORAD_ID = 25544;
export const CSS_NORAD_ID = 48274;

/** Satellites we search passes for. Others are still drawn if they are overhead. */
export const TRACKED_FOR_PASSES = [ISS_NORAD_ID, CSS_NORAD_ID];

export const SATELLITE_FACTS: Record<number, string> = {
  [ISS_NORAD_ID]:
    'The International Space Station, a laboratory the size of a football pitch with people living aboard it, orbiting about 400 km up.',
  [CSS_NORAD_ID]:
    "Tiangong, China's space station. Three astronauts typically live aboard it.",
};

// ---------------------------------------------------------------------------
// elements
// ---------------------------------------------------------------------------

export interface TleRecord {
  name: string;
  noradId: number;
  satrec: SatRec;
  epoch: Date;
}

export interface TleSet {
  group: string;
  fetchedAt: number;
  /** True when the proxy had to serve cached elements because Celestrak was down. */
  stale: boolean;
  records: TleRecord[];
}

export class TleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TleUnavailableError';
  }
}

/** Recovers the element-set epoch, so the UI can show how fresh the data is. */
function epochFromSatrec(satrec: SatRec): Date {
  const year = satrec.epochyr;
  const fullYear = year < 57 ? 2000 + year : 1900 + year;
  const start = Date.UTC(fullYear, 0, 1);
  return new Date(start + (satrec.epochdays - 1) * 86_400_000);
}

export function parseTle(text: string): TleRecord[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.length > 0);

  const records: TleRecord[] = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;

    try {
      const satrec = twoline2satrec(l1, l2);
      // satellite.js sets a non-zero error code for element sets it cannot use.
      if (satrec.error !== 0) continue;
      records.push({
        name,
        noradId: Number.parseInt(l1.slice(2, 7), 10),
        satrec,
        epoch: epochFromSatrec(satrec),
      });
    } catch {
      // A single malformed entry must not take down the whole set.
    }
  }
  return records;
}

const CACHE_KEY = 'borrowed-sky:tle:';
const CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Fetches elements, falling back to a browser-cached copy when offline.
 *
 * SGP4 accuracy decays slowly: elements a day or two old still give passes
 * good to a few seconds, so serving a cached set beats serving nothing. Past
 * three days we refuse rather than quietly mislead.
 */
export async function loadTleSet(group = 'stations', signal?: AbortSignal): Promise<TleSet> {
  const cacheKey = CACHE_KEY + group;

  let cached: { fetchedAt: number; text: string } | null = null;
  try {
    const raw = localStorage.getItem(cacheKey);
    if (raw) cached = JSON.parse(raw);
  } catch {
    cached = null;
  }

  if (cached && Date.now() - cached.fetchedAt < CACHE_MAX_AGE_MS) {
    return { group, fetchedAt: cached.fetchedAt, stale: false, records: parseTle(cached.text) };
  }

  try {
    const res = await fetch(`api/tle?group=${encodeURIComponent(group)}`, { signal });
    if (!res.ok) throw new Error(`the orbital element service responded ${res.status}`);

    // A static host with no serverless functions answers /api/tle with the app's
    // own index.html. Catch that here so the user sees a real explanation rather
    // than a JSON parse error from deep in the stack.
    if (!res.headers.get('content-type')?.includes('application/json')) {
      throw new Error('this deployment has no orbital element service configured');
    }

    const json = (await res.json()) as { tle?: string; fetchedAt?: number; stale?: boolean };
    if (!json.tle) throw new Error('the orbital element service returned no elements');

    const records = parseTle(json.tle);
    if (!records.length) throw new Error('no usable element sets in response');

    try {
      localStorage.setItem(cacheKey, JSON.stringify({ fetchedAt: Date.now(), text: json.tle }));
    } catch {
      // Storage full or blocked. Not fatal, we just refetch next time.
    }

    return {
      group,
      fetchedAt: json.fetchedAt ?? Date.now(),
      stale: Boolean(json.stale),
      records,
    };
  } catch (err) {
    const ageMs = cached ? Date.now() - cached.fetchedAt : Infinity;
    if (cached && ageMs < 3 * 24 * 60 * 60 * 1000) {
      return { group, fetchedAt: cached.fetchedAt, stale: true, records: parseTle(cached.text) };
    }
    throw new TleUnavailableError(
      err instanceof Error ? err.message : 'could not reach the orbital element service',
    );
  }
}

// ---------------------------------------------------------------------------
// instantaneous position
// ---------------------------------------------------------------------------

export interface SatelliteObservation {
  altitude: number;
  azimuth: number;
  rangeKm: number;
  heightKm: number;
  speedKmS: number;
  sunlit: boolean;
  /** Sub-satellite point, for "it is currently over ..." readouts. */
  groundLatitude: number;
  groundLongitude: number;
}

function isVec(v: EciVec3<number> | boolean): v is EciVec3<number> {
  return typeof v === 'object' && v !== null;
}

/**
 * Unit vector to the Sun in the true equator of date, which TEME (the frame
 * SGP4 outputs) matches to within about twenty arcseconds. That is far tighter
 * than needed to decide which side of Earth's shadow a satellite is on.
 */
function sunUnitVectorEqd(when: Date): { x: number; y: number; z: number } {
  const time = MakeTime(when);
  const eqj = GeoVector(Body.Sun, time, true);
  const v = RotateVector(Rotation_EQJ_EQD(time), eqj);
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

/** Cylindrical umbra test: is this satellite in sunlight? */
function isSunlit(pos: EciVec3<number>, sunHat: { x: number; y: number; z: number }): boolean {
  const along = pos.x * sunHat.x + pos.y * sunHat.y + pos.z * sunHat.z;
  if (along > 0) return true; // sunward hemisphere
  const perp = Math.hypot(
    pos.x - along * sunHat.x,
    pos.y - along * sunHat.y,
    pos.z - along * sunHat.z,
  );
  return perp > SHADOW_RADIUS_KM;
}

export function observeSatellite(
  record: TleRecord,
  when: Date,
  site: ObserverSite,
  sunHat = sunUnitVectorEqd(when),
): SatelliteObservation | null {
  let pv;
  try {
    pv = propagate(record.satrec, when);
  } catch {
    return null;
  }
  if (!pv || !isVec(pv.position) || !isVec(pv.velocity)) return null;

  const gmst = gstime(when);
  const ecf = eciToEcf(pv.position, gmst);
  const observerGd = {
    longitude: site.longitude / RAD,
    latitude: site.latitude / RAD,
    height: site.elevation / 1000,
  };
  const look = ecfToLookAngles(observerGd, ecf);
  const geo = eciToGeodetic(pv.position, gmst);

  return {
    altitude: look.elevation * RAD,
    azimuth: (look.azimuth * RAD + 360) % 360,
    rangeKm: look.rangeSat,
    heightKm: geo.height,
    speedKmS: Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z),
    sunlit: isSunlit(pv.position, sunHat),
    groundLatitude: degreesLat(geo.latitude),
    groundLongitude: degreesLong(geo.longitude),
  };
}

/** Turns tracked satellites currently above the horizon into drawable bodies. */
export function satellitesAboveHorizon(
  records: TleRecord[],
  when: Date,
  site: ObserverSite,
  minAltitude = 0,
): SkyBody[] {
  const sunHat = sunUnitVectorEqd(when);
  const out: SkyBody[] = [];

  for (const record of records) {
    const obs = observeSatellite(record, when, site, sunHat);
    if (!obs || obs.altitude < minAltitude) continue;

    out.push({
      id: `sat-${record.noradId}`,
      kind: 'satellite',
      name: prettySatelliteName(record.name),
      designation: `NORAD ${record.noradId}`,
      altitude: obs.altitude,
      azimuth: obs.azimuth,
      // Brightness depends on range, phase and attitude in ways SGP4 does not
      // model. Rather than invent a magnitude, we sort satellites by whether
      // they are lit and how close they are.
      magnitude: obs.sunlit ? 1.5 : 8,
      noradId: record.noradId,
      rangeKm: obs.rangeKm,
      heightKm: obs.heightKm,
      speedKmS: obs.speedKmS,
      sunlit: obs.sunlit,
      distance: { value: obs.rangeKm, unit: 'km' },
    });
  }

  return out;
}

export function prettySatelliteName(raw: string): string {
  const name = raw.replace(/\s+/g, ' ').trim();
  if (/ISS \(ZARYA\)/i.test(name)) return 'International Space Station';
  if (/CSS \(TIANHE\)/i.test(name)) return 'Tiangong Space Station';
  return name.replace(/\s*\([^)]*\)\s*$/, '');
}

// ---------------------------------------------------------------------------
// pass prediction
// ---------------------------------------------------------------------------

export interface SatellitePass {
  noradId: number;
  name: string;
  /** Above the horizon from this moment. */
  start: Date;
  end: Date;
  peak: Date;
  peakAltitude: number;
  startAzimuth: number;
  endAzimuth: number;
  peakAzimuth: number;
  durationSeconds: number;
  /** True when the satellite is sunlit while the observer's sky is dark. */
  visible: boolean;
  /** The sunlit-and-dark sub-window, present only when `visible`. */
  visibleFrom?: Date;
  visibleTo?: Date;
  visiblePeakAltitude?: number;
}

interface PassSearchOptions {
  /** Ignore passes that never get this high; they stay lost in ground clutter. */
  minPeakAltitude?: number;
  /** How dark the observer's sky must be to count a pass as visible. */
  maxSunAltitude?: number;
  coarseStepSeconds?: number;
}

function elevationAt(record: TleRecord, when: Date, site: ObserverSite): number {
  let pv;
  try {
    pv = propagate(record.satrec, when);
  } catch {
    return -90;
  }
  if (!pv || !isVec(pv.position)) return -90;
  const ecf = eciToEcf(pv.position, gstime(when));
  return (
    ecfToLookAngles(
      {
        longitude: site.longitude / RAD,
        latitude: site.latitude / RAD,
        height: site.elevation / 1000,
      },
      ecf,
    ).elevation * RAD
  );
}

/** Bisects a horizon crossing bracketed by [lo, hi] down to one second. */
function refineCrossing(
  record: TleRecord,
  site: ObserverSite,
  lo: number,
  hi: number,
  rising: boolean,
): Date {
  let a = lo;
  let b = hi;
  for (let i = 0; i < 20 && b - a > 500; i++) {
    const mid = (a + b) / 2;
    const above = elevationAt(record, new Date(mid), site) > 0;
    if (above === rising) b = mid;
    else a = mid;
  }
  return new Date(rising ? b : a);
}

function sunAltitude(when: Date, site: ObserverSite): number {
  const time = MakeTime(when);
  const observer = toObserver(site);
  const eq = Equator(Body.Sun, time, observer, true, true);
  return Horizon(time, observer, eq.ra, eq.dec, 'normal').altitude;
}

/**
 * Searches forward for horizon-to-horizon passes, then decides which of them
 * can actually be seen.
 *
 * The coarse sweep uses a 30-second step. The shortest possible pass of a
 * low-Earth-orbit satellite is a couple of minutes, so that cannot step over one.
 */
export function findPasses(
  record: TleRecord,
  site: ObserverSite,
  start: Date,
  hours: number,
  options: PassSearchOptions = {},
): SatellitePass[] {
  const { minPeakAltitude = 10, maxSunAltitude = -6, coarseStepSeconds = 30 } = options;

  const stepMs = coarseStepSeconds * 1000;
  const endMs = start.getTime() + hours * 3_600_000;
  const passes: SatellitePass[] = [];

  let previousAbove = elevationAt(record, start, site) > 0;
  let riseBracket: [number, number] | null = null;

  for (let t = start.getTime() + stepMs; t <= endMs; t += stepMs) {
    const above = elevationAt(record, new Date(t), site) > 0;

    if (above && !previousAbove) {
      riseBracket = [t - stepMs, t];
    } else if (!above && previousAbove && riseBracket) {
      const rise = refineCrossing(record, site, riseBracket[0], riseBracket[1], true);
      const set = refineCrossing(record, site, t - stepMs, t, false);
      const pass = describePass(record, site, rise, set, minPeakAltitude, maxSunAltitude);
      if (pass) passes.push(pass);
      riseBracket = null;
    }

    previousAbove = above;
  }

  return passes;
}

function describePass(
  record: TleRecord,
  site: ObserverSite,
  rise: Date,
  set: Date,
  minPeakAltitude: number,
  maxSunAltitude: number,
): SatellitePass | null {
  const durationSeconds = (set.getTime() - rise.getTime()) / 1000;
  if (durationSeconds < 30) return null;

  // Sample the pass finely enough to place the peak within a few seconds and to
  // catch short visible windows near the shadow boundary.
  const samples = Math.max(24, Math.min(360, Math.round(durationSeconds / 5)));
  const dt = (set.getTime() - rise.getTime()) / samples;

  let peakAltitude = -90;
  let peakMs = rise.getTime();
  let visibleFromMs: number | null = null;
  let visibleToMs: number | null = null;
  let visiblePeak = -90;

  // The observer's sky darkness barely changes over a few minutes, so evaluate
  // it once at the midpoint rather than on every sample.
  const midpoint = new Date((rise.getTime() + set.getTime()) / 2);
  const skyIsDark = sunAltitude(midpoint, site) <= maxSunAltitude;

  for (let i = 0; i <= samples; i++) {
    const when = new Date(rise.getTime() + i * dt);
    const obs = observeSatellite(record, when, site);
    if (!obs) continue;

    if (obs.altitude > peakAltitude) {
      peakAltitude = obs.altitude;
      peakMs = when.getTime();
    }

    if (skyIsDark && obs.sunlit && obs.altitude >= minPeakAltitude) {
      if (visibleFromMs === null) visibleFromMs = when.getTime();
      visibleToMs = when.getTime();
      if (obs.altitude > visiblePeak) visiblePeak = obs.altitude;
    }
  }

  if (peakAltitude < minPeakAltitude) return null;

  const startObs = observeSatellite(record, rise, site);
  const endObs = observeSatellite(record, set, site);
  const peakObs = observeSatellite(record, new Date(peakMs), site);
  const visible = visibleFromMs !== null && visibleToMs !== null && visibleToMs > visibleFromMs;

  return {
    noradId: record.noradId,
    name: prettySatelliteName(record.name),
    start: rise,
    end: set,
    peak: new Date(peakMs),
    peakAltitude,
    startAzimuth: startObs?.azimuth ?? 0,
    endAzimuth: endObs?.azimuth ?? 0,
    peakAzimuth: peakObs?.azimuth ?? 0,
    durationSeconds,
    visible,
    visibleFrom: visible ? new Date(visibleFromMs!) : undefined,
    visibleTo: visible ? new Date(visibleToMs!) : undefined,
    visiblePeakAltitude: visible ? visiblePeak : undefined,
  };
}

/** Compass point for an azimuth, for directions people can actually follow. */
export function compassPoint(azimuth: number): string {
  const points = [
    'north', 'north-north-east', 'north-east', 'east-north-east',
    'east', 'east-south-east', 'south-east', 'south-south-east',
    'south', 'south-south-west', 'south-west', 'west-south-west',
    'west', 'west-north-west', 'north-west', 'north-north-west',
  ];
  return points[Math.round((((azimuth % 360) + 360) % 360) / 22.5) % 16];
}

/** How high something is, in words rather than degrees. */
export function heightInWords(altitude: number): string {
  if (altitude < 15) return 'low on the horizon';
  if (altitude < 35) return 'about a third of the way up';
  if (altitude < 60) return 'halfway up the sky';
  if (altitude < 80) return 'high overhead';
  return 'almost directly overhead';
}
