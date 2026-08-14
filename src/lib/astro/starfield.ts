/**
 * Loads the shipped star and constellation catalogues into the flat, typed
 * layout the renderer wants.
 *
 * The catalogue is real astrometry (HYG v4.1, J2000). This module never
 * fabricates a star: if the fetch fails, it throws and the UI says the sky data
 * could not be loaded.
 */

import { eqjVector, type Vec3 } from './frames.js';

interface StarsFile {
  epoch: string;
  magLimit: number;
  count: number;
  stars: [
    ra: number,
    dec: number,
    mag: number,
    ci: number,
    proper: string,
    bayer: string,
    con: string,
    hip: number,
    spect: string,
    distLy: number,
  ][];
}

interface ConstellationsFile {
  constellations: {
    id: string;
    name: string;
    centroid: [number, number];
    lines: number[][];
  }[];
}

export interface StarCatalog {
  count: number;
  magLimit: number;
  /** 3N J2000 unit vectors, laid out x,y,z per star. */
  vectors: Float64Array;
  magnitude: Float32Array;
  /** Index into {@link STAR_COLORS}, so the renderer can batch by colour. */
  colorBucket: Uint8Array;
  proper: string[];
  bayer: string[];
  constellation: string[];
  hip: Int32Array;
  spectral: string[];
  /** Light years, from the catalogue parallax. 0 means no reliable measurement. */
  distanceLy: Float32Array;
}

export interface ConstellationFigure {
  id: string;
  name: string;
  /** Flattened independent segments: x1,y1,z1,x2,y2,z2 per segment, in EQJ. */
  segments: Float64Array;
  segmentCount: number;
  labelVector: Vec3;
}

// ---------------------------------------------------------------------------
// star colour
// ---------------------------------------------------------------------------

/**
 * Ballesteros' formula: effective temperature from B-V colour index.
 * Good to a few percent across the main sequence, which is far better than the
 * eye can tell at the size a star is drawn.
 */
function temperatureFromColorIndex(bv: number): number {
  const b = Math.max(-0.4, Math.min(2.0, bv));
  return 4600 * (1 / (0.92 * b + 1.7) + 1 / (0.92 * b + 0.62));
}

/** Blackbody temperature to sRGB, via the widely used Tanner Helland fit. */
function rgbFromTemperature(kelvin: number): [number, number, number] {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
  } else {
    r = 329.698727446 * (t - 60) ** -0.1332047592;
    g = 288.1221695283 * (t - 60) ** -0.0755148492;
  }

  if (t >= 66) b = 255;
  else if (t <= 19) b = 0;
  else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;

  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}

/**
 * Quantised star colours. Stars are drawn a few pixels across, so batching them
 * into a small palette costs nothing visually and lets the renderer issue one
 * fill per colour instead of one per star.
 *
 * Colours are pulled toward the "starlight" warm white of the design system:
 * real stars are far less saturated to the eye than their raw blackbody values.
 */
const BUCKET_COUNT = 12;
const BV_MIN = -0.35;
const BV_MAX = 2.0;

export const STAR_COLORS: string[] = Array.from({ length: BUCKET_COUNT }, (_, i) => {
  const bv = BV_MIN + ((BV_MAX - BV_MIN) * i) / (BUCKET_COUNT - 1);
  const [r, g, b] = rgbFromTemperature(temperatureFromColorIndex(bv));
  // Desaturate toward white; the eye sees almost no colour in faint stars.
  const mix = 0.55;
  const blend = (c: number) => Math.round(c * (1 - mix) + 246 * mix);
  return `rgb(${blend(r)}, ${blend(g)}, ${blend(b)})`;
});

/**
 * The same buckets rendered on a red-only ramp for night-vision mode.
 *
 * Under red light the eye cannot resolve hue anyway, so only relative
 * brightness is preserved, carried over from each bucket's luminance so the
 * hot blue-white stars still read as the brighter ones.
 */
export const STAR_COLORS_NIGHT: string[] = Array.from({ length: BUCKET_COUNT }, (_, i) => {
  const bv = BV_MIN + ((BV_MAX - BV_MIN) * i) / (BUCKET_COUNT - 1);
  const [r, g, b] = rgbFromTemperature(temperatureFromColorIndex(bv));
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const level = 0.68 + 0.32 * luminance;
  return `rgb(${Math.round(255 * level)}, ${Math.round(96 * level)}, ${Math.round(70 * level)})`;
});

function bucketFor(bv: number): number {
  const t = (bv - BV_MIN) / (BV_MAX - BV_MIN);
  return Math.max(0, Math.min(BUCKET_COUNT - 1, Math.round(t * (BUCKET_COUNT - 1))));
}

// ---------------------------------------------------------------------------
// loading
// ---------------------------------------------------------------------------

export async function loadStarCatalog(signal?: AbortSignal): Promise<StarCatalog> {
  const res = await fetch('data/stars.json', { signal });
  if (!res.ok) throw new Error(`star catalogue unavailable (${res.status})`);
  const file = (await res.json()) as StarsFile;

  const n = file.stars.length;
  const vectors = new Float64Array(n * 3);
  const magnitude = new Float32Array(n);
  const colorBucket = new Uint8Array(n);
  const hip = new Int32Array(n);
  const distanceLy = new Float32Array(n);
  const proper: string[] = new Array(n);
  const bayer: string[] = new Array(n);
  const constellation: string[] = new Array(n);
  const spectral: string[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const s = file.stars[i];
    const v = eqjVector(s[0], s[1]);
    vectors[i * 3] = v.x;
    vectors[i * 3 + 1] = v.y;
    vectors[i * 3 + 2] = v.z;
    magnitude[i] = s[2];
    colorBucket[i] = bucketFor(s[3]);
    proper[i] = s[4];
    bayer[i] = s[5];
    constellation[i] = s[6];
    hip[i] = s[7];
    spectral[i] = s[8];
    distanceLy[i] = s[9];
  }

  return {
    count: n,
    magLimit: file.magLimit,
    vectors,
    magnitude,
    colorBucket,
    proper,
    bayer,
    constellation,
    hip,
    spectral,
    distanceLy,
  };
}

/**
 * Turns a catalogue entry into the same shape as every other sky object, so a
 * tapped star flows through the identical detail panel and journal as a planet.
 */
export function starToBody(
  catalog: StarCatalog,
  index: number,
  altitude: number,
  azimuth: number,
  constellationName?: string,
): {
  id: string;
  kind: 'star';
  name: string;
  designation?: string;
  altitude: number;
  azimuth: number;
  magnitude: number;
  constellation?: string;
  distance?: { value: number; unit: 'ly' };
  spectralType?: string;
} {
  const distance = catalog.distanceLy[index];
  return {
    id: `star-${index}`,
    kind: 'star',
    name: catalog.proper[index] || catalog.bayer[index] || `HIP ${catalog.hip[index]}`,
    designation: catalog.proper[index] ? catalog.bayer[index] || undefined : undefined,
    altitude,
    azimuth,
    magnitude: catalog.magnitude[index],
    constellation: constellationName || catalog.constellation[index] || undefined,
    distance: distance > 0 ? { value: distance, unit: 'ly' } : undefined,
    spectralType: catalog.spectral[index] || undefined,
  };
}

export async function loadConstellations(signal?: AbortSignal): Promise<ConstellationFigure[]> {
  const res = await fetch('data/constellations.json', { signal });
  if (!res.ok) throw new Error(`constellation figures unavailable (${res.status})`);
  const file = (await res.json()) as ConstellationsFile;

  return file.constellations.map((c) => {
    // Expand polylines into independent segments so the renderer can cull each
    // one on its own: a figure that straddles the horizon then loses only the
    // segments that are actually below it.
    const segs: number[] = [];
    for (const line of c.lines) {
      for (let i = 0; i + 3 < line.length; i += 2) {
        const a = eqjVector(line[i], line[i + 1]);
        const b = eqjVector(line[i + 2], line[i + 3]);
        segs.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
    return {
      id: c.id,
      name: c.name,
      segments: new Float64Array(segs),
      segmentCount: segs.length / 6,
      labelVector: eqjVector(c.centroid[0], c.centroid[1]),
    };
  });
}

/**
 * Screen radius for a star of the given magnitude.
 *
 * Brightness is logarithmic, so this maps magnitude to radius on a curve that
 * keeps first-magnitude stars clearly dominant without letting sixth-magnitude
 * stars vanish entirely.
 */
export function starRadius(mag: number, limit: number, pixelScale: number): number {
  const t = Math.max(0, (limit - mag) / (limit + 1.5));
  return (0.35 + 2.6 * t * t) * pixelScale;
}
