/**
 * Coordinate frames and the projection pipeline.
 *
 * The sky view has to place ~5000 stars every animation frame, so the naive
 * "convert each star to alt/az, then to screen" path is too slow. Instead we
 * collapse the whole chain into one 4x3 matrix per frame:
 *
 *     star (J2000 equatorial unit vector)  --M-->  (X, Y, Z, U)
 *
 * where X/Y are camera-plane axes, Z is the camera forward axis (for culling
 * what is behind the viewer) and U is the vertical component in the horizontal
 * frame, that is, sin(altitude), which is all we need to cull below-horizon
 * objects. Per star that is twelve multiplies and no trigonometry.
 *
 * Frame conventions follow astronomy-engine:
 *   EQJ: J2000 mean equator. x toward the vernal equinox, z toward the celestial pole.
 *   HOR: horizontal. x = north, y = west, z = zenith.
 */

import { Rotation_EQJ_HOR, type AstroTime, type Observer, type RotationMatrix } from 'astronomy-engine';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

/** J2000 right ascension (hours) and declination (degrees) to a unit vector in EQJ. */
export function eqjVector(raHours: number, decDeg: number): Vec3 {
  const ra = raHours * (Math.PI / 12);
  const dec = decDeg * DEG;
  const cd = Math.cos(dec);
  return { x: cd * Math.cos(ra), y: cd * Math.sin(ra), z: Math.sin(dec) };
}

/** Horizontal altitude/azimuth (degrees, azimuth clockwise from north) to a HOR unit vector. */
export function horVector(altDeg: number, azDeg: number): Vec3 {
  const alt = altDeg * DEG;
  const az = azDeg * DEG;
  const ca = Math.cos(alt);
  // y is *west*, so the east-going component of the azimuth carries a minus sign.
  return { x: ca * Math.cos(az), y: -ca * Math.sin(az), z: Math.sin(alt) };
}

/** Inverse of {@link horVector}. Azimuth is normalised to [0, 360). */
export function horVectorToAltAz(v: Vec3): { altitude: number; azimuth: number } {
  const r = Math.hypot(v.x, v.y, v.z) || 1;
  const altitude = Math.asin(v.z / r) * RAD;
  let azimuth = Math.atan2(-v.y, v.x) * RAD;
  if (azimuth < 0) azimuth += 360;
  return { altitude, azimuth };
}

/**
 * Re-indexes astronomy-engine's RotationMatrix into plain row-major form, where
 * `out[i] = sum_j m[i][j] * v[j]`. Its own `rot[i][j]` is stored transposed
 * relative to that (see RotateVector), so this is where that gets untangled once.
 */
function rowMajor(r: RotationMatrix): number[][] {
  return [
    [r.rot[0][0], r.rot[1][0], r.rot[2][0]],
    [r.rot[0][1], r.rot[1][1], r.rot[2][1]],
    [r.rot[0][2], r.rot[1][2], r.rot[2][2]],
  ];
}

export function rotateEqjToHor(m: number[][], v: Vec3): Vec3 {
  return {
    x: m[0][0] * v.x + m[0][1] * v.y + m[0][2] * v.z,
    y: m[1][0] * v.x + m[1][1] * v.y + m[1][2] * v.z,
    z: m[2][0] * v.x + m[2][1] * v.y + m[2][2] * v.z,
  };
}

/** The J2000-equatorial to horizontal rotation for one instant and place. */
export function eqjToHorMatrix(time: AstroTime | Date, observer: Observer): number[][] {
  return rowMajor(Rotation_EQJ_HOR(time, observer));
}

// ---------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------

export interface Camera {
  /** Direction the viewer is facing, degrees clockwise from north. */
  azimuth: number;
  /** Height of the view centre above the horizon, degrees. */
  altitude: number;
  /** Rotation of the screen about the view axis, degrees. */
  roll: number;
  /** Full horizontal field of view, degrees. */
  fov: number;
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function normalise(v: Vec3): Vec3 {
  const n = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / n, y: v.y / n, z: v.z / n };
}

export interface ViewBasis {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
}

/**
 * The camera basis in the horizontal frame.
 *
 * Horizon lines, the altitude grid and the compass scales are all naturally
 * expressed in alt/az, so they project through this directly rather than being
 * pushed out to J2000 and back.
 */
export function buildHorizonBasis(camera: Camera): ViewBasis {
  const forward = horVector(camera.altitude, camera.azimuth);
  const zenith: Vec3 = { x: 0, y: 0, z: 1 };

  // Looking straight up or down makes forward x zenith degenerate; fall back to
  // north as the roll reference so the view stays stable overhead.
  let baseRight = cross(forward, zenith);
  if (Math.hypot(baseRight.x, baseRight.y, baseRight.z) < 1e-6) {
    baseRight = cross(forward, { x: 1, y: 0, z: 0 });
  }
  baseRight = normalise(baseRight);
  const baseUp = normalise(cross(baseRight, forward));

  const rollRad = camera.roll * DEG;
  const cr = Math.cos(rollRad);
  const sr = Math.sin(rollRad);

  return {
    right: {
      x: baseRight.x * cr - baseUp.x * sr,
      y: baseRight.y * cr - baseUp.y * sr,
      z: baseRight.z * cr - baseUp.z * sr,
    },
    up: {
      x: baseRight.x * sr + baseUp.x * cr,
      y: baseRight.y * sr + baseUp.y * cr,
      z: baseRight.z * sr + baseUp.z * cr,
    },
    forward,
  };
}

/**
 * Builds the combined EQJ-to-screen-basis matrix as a flat 12-element array:
 * rows are [right, up, forward, zenith], each expressed in EQJ.
 */
export function buildViewMatrix(camera: Camera, eqjToHor: number[][]): Float64Array {
  const { right, up, forward } = buildHorizonBasis(camera);
  const zenith: Vec3 = { x: 0, y: 0, z: 1 };

  // Each basis row is in HOR; multiply through the rotation to land back in EQJ.
  const m = new Float64Array(12);
  const rows = [right, up, forward, zenith];
  for (let r = 0; r < 4; r++) {
    const a = rows[r];
    for (let c = 0; c < 3; c++) {
      m[r * 3 + c] = a.x * eqjToHor[0][c] + a.y * eqjToHor[1][c] + a.z * eqjToHor[2][c];
    }
  }
  return m;
}

/**
 * Screen scale for a stereographic projection.
 *
 * Stereographic is the right choice here: it holds star patterns recognisable
 * across a wide field, where a gnomonic projection would smear constellations
 * near the edges. A point at angle t from the view centre lands at radius
 * tan(t/2), so the scale that puts the half-FOV exactly at `radiusPx` is:
 */
export function projectionScale(fovDeg: number, radiusPx: number): number {
  return radiusPx / Math.tan((fovDeg * DEG) / 4);
}

/** Angular separation between two alt/az directions, in degrees. */
export function angularSeparation(
  altA: number,
  azA: number,
  altB: number,
  azB: number,
): number {
  const a = horVector(altA, azA);
  const b = horVector(altB, azB);
  const dot = Math.min(1, Math.max(-1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot) * RAD;
}
