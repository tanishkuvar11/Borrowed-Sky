/**
 * Sun, Moon and planets for one instant and place.
 *
 * Everything here comes out of astronomy-engine's ephemeris. Positions are
 * apparent (equator of date, with aberration) and altitudes include atmospheric
 * refraction, so they match what an observer actually sees rather than the
 * geometric position.
 */

import {
  Body,
  Equator,
  GeoVector,
  Horizon,
  Illumination,
  MakeTime,
  MoonPhase,
  Observer,
  type AstroTime,
} from 'astronomy-engine';

import type { ObserverSite, SkyBody, SkyConditions, DarknessLevel } from './types.js';
import { skyQuality, type SkyQualityInput } from './skyquality.js';

const KM_PER_AU = 149_597_870.7;

/** Mean radii in km (IAU 2015 nominal values). Used only for angular sizes. */
const RADIUS_KM: Partial<Record<Body, number>> = {
  [Body.Sun]: 695_700,
  [Body.Moon]: 1737.4,
};

export const PLANETS = [
  Body.Mercury,
  Body.Venus,
  Body.Mars,
  Body.Jupiter,
  Body.Saturn,
  Body.Uranus,
  Body.Neptune,
] as const;

/**
 * Static encyclopedic descriptions. These are fixed facts about the bodies, not
 * computed observations; they never stand in for measured data.
 */
export const BODY_FACTS: Record<string, string> = {
  Sun: 'The star our planet orbits. Never look at it directly.',
  Moon: "Earth's only natural satellite, and the only other world humans have stood on.",
  Mercury: 'The smallest planet, and the closest one to the Sun.',
  Venus: 'The hottest planet, wrapped in thick cloud that reflects sunlight brilliantly.',
  Mars: 'The rusty desert world that robotic rovers are exploring right now.',
  Jupiter: 'The largest planet, a gas giant with a storm wider than Earth.',
  Saturn: 'The ringed gas giant. Even a small telescope shows the rings.',
  Uranus: 'An ice giant tipped almost entirely on its side.',
  Neptune: 'The most distant planet, with the fastest winds in the Solar System.',
};

export interface SolarSystemResult {
  sun: SkyBody;
  moon: SkyBody;
  planets: SkyBody[];
}

function apparentAltAz(body: Body, time: AstroTime, observer: Observer) {
  const eq = Equator(body, time, observer, true, true);
  const hor = Horizon(time, observer, eq.ra, eq.dec, 'normal');
  return { altitude: hor.altitude, azimuth: hor.azimuth };
}

/** Arcminutes subtended by a body of the given radius at the given distance. */
function angularDiameterArcmin(radiusKm: number, distanceKm: number): number {
  return 2 * Math.atan(radiusKm / distanceKm) * (180 / Math.PI) * 60;
}

export function toObserver(site: ObserverSite): Observer {
  return new Observer(site.latitude, site.longitude, site.elevation);
}

/**
 * Names the lunar phase from the Moon–Sun ecliptic longitude difference.
 * 0 deg is new, 90 first quarter, 180 full, 270 third quarter.
 */
export function moonPhaseName(phaseAngleDeg: number): string {
  const p = ((phaseAngleDeg % 360) + 360) % 360;
  if (p < 11.25 || p >= 348.75) return 'New Moon';
  if (p < 78.75) return 'Waxing Crescent';
  if (p < 101.25) return 'First Quarter';
  if (p < 168.75) return 'Waxing Gibbous';
  if (p < 191.25) return 'Full Moon';
  if (p < 258.75) return 'Waning Gibbous';
  if (p < 281.25) return 'Third Quarter';
  return 'Waning Crescent';
}

export function computeSolarSystem(when: Date, site: ObserverSite): SolarSystemResult {
  const time = MakeTime(when);
  const observer = toObserver(site);

  // --- Sun ---
  const sunPos = apparentAltAz(Body.Sun, time, observer);
  const sunIllum = Illumination(Body.Sun, time);
  const sunDistKm = sunIllum.geo_dist * KM_PER_AU;
  const sun: SkyBody = {
    id: 'sun',
    kind: 'sun',
    name: 'Sun',
    ...sunPos,
    magnitude: sunIllum.mag,
    distance: { value: sunDistKm, unit: 'km' },
    angularDiameter: angularDiameterArcmin(RADIUS_KM[Body.Sun]!, sunDistKm),
  };

  // --- Moon ---
  const moonPos = apparentAltAz(Body.Moon, time, observer);
  const moonIllum = Illumination(Body.Moon, time);
  const moonVec = GeoVector(Body.Moon, time, true);
  const moonDistKm = Math.hypot(moonVec.x, moonVec.y, moonVec.z) * KM_PER_AU;
  const phase = MoonPhase(time);
  const moon: SkyBody = {
    id: 'moon',
    kind: 'moon',
    name: 'Moon',
    ...moonPos,
    magnitude: moonIllum.mag,
    distance: { value: moonDistKm, unit: 'km' },
    illuminatedFraction: moonIllum.phase_fraction,
    phaseName: moonPhaseName(phase),
    angularDiameter: angularDiameterArcmin(RADIUS_KM[Body.Moon]!, moonDistKm),
  };

  // --- Planets ---
  const planets: SkyBody[] = PLANETS.map((body) => {
    const pos = apparentAltAz(body, time, observer);
    const illum = Illumination(body, time);
    return {
      id: String(body).toLowerCase(),
      kind: 'planet' as const,
      name: String(body),
      ...pos,
      magnitude: illum.mag,
      distance: { value: illum.geo_dist, unit: 'au' as const },
      illuminatedFraction: illum.phase_fraction,
    };
  });

  return { sun, moon, planets };
}

// ---------------------------------------------------------------------------
// observing conditions
// ---------------------------------------------------------------------------

export function darknessFromSunAltitude(sunAltitude: number): DarknessLevel {
  if (sunAltitude > -0.833) return 'day';
  if (sunAltitude > -6) return 'civil-twilight';
  if (sunAltitude > -12) return 'nautical-twilight';
  if (sunAltitude > -18) return 'astronomical-twilight';
  return 'night';
}

export const DARKNESS_LABEL: Record<DarknessLevel, string> = {
  day: 'Daylight',
  'civil-twilight': 'Civil twilight',
  'nautical-twilight': 'Nautical twilight',
  'astronomical-twilight': 'Astronomical twilight',
  night: 'Full darkness',
};

function conditionsSummary(darkness: DarknessLevel, moonFraction: number, moonUp: boolean): string {
  switch (darkness) {
    case 'day':
      return 'The Sun is up. This view shows where things are, but only the Moon and occasionally Venus can be seen in daylight.';
    case 'civil-twilight':
      return 'The sky is still bright. The Moon and the brightest planets are appearing first.';
    case 'nautical-twilight':
      return 'Bright stars and planets are out. Fainter stars are still washed out by the last of the daylight.';
    case 'astronomical-twilight':
      return 'Almost fully dark. Nearly everything on this map is now above the noise.';
    case 'night':
      if (moonUp && moonFraction > 0.6) {
        return 'Fully dark, but a bright Moon is washing out the faintest stars.';
      }
      return moonUp
        ? 'Fully dark, with the Moon adding a little light.'
        : 'Fully dark with no Moon: the best conditions you will get.';
  }
}

export function computeConditions(when: Date, site: ObserverSite): SkyConditions {
  const { sun, moon } = computeSolarSystem(when, site);
  const darkness = darknessFromSunAltitude(sun.altitude);
  return {
    sunAltitude: sun.altitude,
    sunAzimuth: sun.azimuth,
    darkness,
    summary: conditionsSummary(darkness, moon.illuminatedFraction ?? 0, moon.altitude > 0),
    moonIlluminatedFraction: moon.illuminatedFraction ?? 0,
    moonAltitude: moon.altitude,
    moonPhaseName: moon.phaseName ?? '',
  };
}

/**
 * Whether a body is realistically visible to the unaided eye right now, given
 * how bright it is, how high it is, and how dark the sky is. Used to keep the
 * app from telling someone to look at Neptune.
 */
export function nakedEyeVisible(
  body: SkyBody,
  darkness: DarknessLevel,
  /** Optional. Supplying it lets the fitted night correction apply. */
  sky?: SkyQualityInput,
): boolean {
  if (body.altitude < 5) return false;
  if (body.kind === 'moon' || body.kind === 'sun') return true;

  const limit =
    darkness === 'day'
      ? -3.5
      : darkness === 'civil-twilight'
        ? 1.5
        : darkness === 'nautical-twilight'
          ? 3.5
          : 5.5;

  /*
   * The Moon and the local sky, when the caller knows them.
   *
   * Added rather than substituted, and only in genuine darkness, where the
   * model was fitted. Callers that pass nothing get the four numbers above
   * exactly as they have always been, which is what makes it impossible for
   * this to change what the app says in daylight.
   */
  const correction = sky ? skyQuality(sky).adjustment : 0;
  return body.magnitude <= limit + correction;
}

/**
 * The inputs the night correction needs, gathered from what the app already has.
 *
 * Here rather than at each call site so the two places that ask about
 * visibility cannot drift into asking slightly different questions.
 */
export function skyQualityInput(
  site: ObserverSite,
  conditions: SkyConditions,
): SkyQualityInput {
  return {
    sunAltitudeDegrees: conditions.sunAltitude,
    moonAltitudeDegrees: conditions.moonAltitude,
    moonIlluminatedFraction: conditions.moonIlluminatedFraction,
    latitude: site.latitude,
    longitude: site.longitude,
    elevationMetres: site.elevation,
  };
}
