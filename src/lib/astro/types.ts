/** Shared vocabulary for everything the app knows about the sky. */

export type ObjectKind = 'star' | 'planet' | 'moon' | 'sun' | 'satellite';

export interface ObserverSite {
  latitude: number;
  longitude: number;
  /** Metres above sea level. Affects rise/set times and satellite geometry. */
  elevation: number;
  /** Where the coordinates came from, so the UI can be honest about precision. */
  source: 'gps' | 'manual';
  label?: string;
}

export interface Distance {
  value: number;
  unit: 'km' | 'au' | 'ly';
}

/**
 * One identifiable thing in the sky at one instant. Every field is computed —
 * none is ever supplied by a language model or a placeholder.
 */
export interface SkyBody {
  id: string;
  kind: ObjectKind;
  name: string;
  /** Bayer or catalogue designation, e.g. "α CMa" or "NORAD 25544". */
  designation?: string;
  /** Apparent altitude in degrees, including atmospheric refraction. */
  altitude: number;
  /** Azimuth in degrees, clockwise from true north. */
  azimuth: number;
  /** Apparent visual magnitude. Lower is brighter. */
  magnitude: number;
  constellation?: string;
  distance?: Distance;
  /** 0–1, for the Moon and inner planets. */
  illuminatedFraction?: number;
  phaseName?: string;
  /** Arcminutes, for the Moon and Sun. */
  angularDiameter?: number;
  spectralType?: string;

  // Satellite-only.
  noradId?: number;
  rangeKm?: number;
  heightKm?: number;
  speedKmS?: number;
  /** True when the satellite is in sunlight and therefore able to be seen. */
  sunlit?: boolean;
}

export type DarknessLevel =
  | 'day'
  | 'civil-twilight'
  | 'nautical-twilight'
  | 'astronomical-twilight'
  | 'night';

export interface SkyConditions {
  sunAltitude: number;
  darkness: DarknessLevel;
  /** Plain-language summary of how much can realistically be seen right now. */
  summary: string;
  moonIlluminatedFraction: number;
  moonAltitude: number;
  moonPhaseName: string;
}
