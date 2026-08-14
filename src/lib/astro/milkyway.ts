/**
 * The Milky Way, placed where it actually is.
 *
 * The band across the sky is our own galaxy's disc seen edge-on from inside it,
 * so its position is not a matter of taste; it is fixed in the sky and can be
 * computed. This module builds the galactic coordinate frame from the IAU 1958
 * pole (the values below are the standard J2000 realisation) and hands back a
 * cloud of points on the galactic plane already expressed as J2000 equatorial
 * unit vectors, so the renderer can push them through exactly the same matrix it
 * uses for the star catalogue.
 *
 * What is real here: where the band lies, which way it runs, and where along it
 * the bright central bulge sits (towards Sagittarius) versus the faint outer
 * anticentre (towards Auriga). Turn to face south from the southern hemisphere
 * on a winter evening and the bright part will be where the app draws it.
 *
 * What is stylised: the cloud texture itself. This is a depiction of a real
 * structure, not a photometric survey: the individual patches are generated,
 * and the app does not claim otherwise. The honest line is that the *geometry*
 * is computed and the *rendering* is illustration, which is why this lives well
 * away from anything that produces a number the user is shown.
 */

const DEG = Math.PI / 180;

/** North galactic pole, J2000 equatorial. */
const NGP_RA = 192.85948;
const NGP_DEC = 27.12825;

/** Galactic centre (l = 0, b = 0), J2000 equatorial. */
const GC_RA = 266.4051;
const GC_DEC = -28.936175;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface MilkyWayPatch {
  /** J2000 equatorial unit vector. */
  v: Vec3;
  /** Angular size of the patch in degrees. */
  size: number;
  /** Relative surface brightness, 0–1. */
  intensity: number;
}

function unit(raDeg: number, decDeg: number): Vec3 {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  const c = Math.cos(dec);
  return { x: c * Math.cos(ra), y: c * Math.sin(ra), z: Math.sin(dec) };
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

/**
 * The galactic frame expressed in J2000 equatorial axes.
 *
 * Built from two published directions rather than a rotation-angle triple, so
 * there is no sign or ordering convention to get wrong: x points at the galactic
 * centre, z at the north galactic pole, y completes a right-handed set.
 *
 * The two published directions are not exactly perpendicular; they are each
 * rounded to five decimal places, which leaves them about a third of an
 * arcsecond out of square. Gram-Schmidt takes the pole as given and squares the
 * centre against it, well inside the rounding, so the result is an exactly
 * orthonormal frame rather than one that is almost a rotation.
 */
export function galacticBasis(): { x: Vec3; y: Vec3; z: Vec3 } {
  const z = normalise(unit(NGP_RA, NGP_DEC));
  const raw = unit(GC_RA, GC_DEC);
  const along = raw.x * z.x + raw.y * z.y + raw.z * z.z;
  const x = normalise({
    x: raw.x - along * z.x,
    y: raw.y - along * z.y,
    z: raw.z - along * z.z,
  });
  return { x, y: normalise(cross(z, x)), z };
}

/** Galactic (l, b) in degrees to a J2000 equatorial unit vector. */
export function galacticToEqj(lDeg: number, bDeg: number): Vec3 {
  const { x, y, z } = galacticBasis();
  const l = lDeg * DEG;
  const b = bDeg * DEG;
  const cb = Math.cos(b);
  const gx = cb * Math.cos(l);
  const gy = cb * Math.sin(l);
  const gz = Math.sin(b);
  return {
    x: x.x * gx + y.x * gy + z.x * gz,
    y: x.y * gx + y.y * gy + z.y * gz,
    z: x.z * gx + y.z * gy + z.z * gz,
  };
}

/** Deterministic PRNG, so the band looks identical on every device and reload. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Box–Muller, for a plane that thins out smoothly instead of ending abruptly. */
function gaussian(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Surface brightness along the band, 0–1.
 *
 * Two real features drive this. The disc is optically thick, so looking towards
 * the centre (l = 0) crosses far more of it than looking outwards at the
 * anticentre (l = 180), hence the cosine-weighted falloff. And the Great Rift
 * is a genuine dark lane: nearby dust in the Aquila–Cygnus arm blocking the
 * light behind it, which is why the band appears to split from roughly l = 0 to
 * l = 50 rather than fading.
 */
function brightness(lDeg: number, bDeg: number): number {
  const l = ((lDeg % 360) + 360) % 360;
  const fromCentre = l > 180 ? 360 - l : l;

  // Bright towards the bulge, faint towards the anticentre.
  let value = 0.22 + 0.78 * Math.pow(Math.cos((fromCentre / 180) * (Math.PI / 2)), 1.6);

  // The bulge itself: a concentrated brightening within ~25 degrees of centre.
  value += 0.45 * Math.exp(-((fromCentre / 18) ** 2));

  // The Great Rift, strongest near the plane and closing up away from it.
  const riftCentre = 25;
  const riftSpan = 30;
  if (l < riftCentre + riftSpan * 1.6 || l > 360 - 12) {
    const dl = l > 180 ? l - 360 : l;
    const along = Math.exp(-(((dl - riftCentre) / riftSpan) ** 2));
    const across = Math.exp(-((bDeg / 5.5) ** 2));
    value *= 1 - 0.62 * along * across;
  }

  return Math.max(0, Math.min(1, value));
}

/**
 * A fixed cloud of patches on the galactic plane.
 *
 * Computed once at module load: these directions are fixed in J2000, so nothing
 * here depends on time or place, and the per-frame cost is just the projection.
 */
export function buildMilkyWay(count = 900): MilkyWayPatch[] {
  const rand = mulberry32(0x5eed11);
  const patches: MilkyWayPatch[] = [];

  for (let i = 0; i < count; i++) {
    const l = rand() * 360;

    // The disc is thicker towards the bulge and thins outwards, which is what
    // gives the band its tapered shape rather than a uniform stripe.
    const fromCentre = l > 180 ? 360 - l : l;
    const thickness = 4.5 + 7 * Math.exp(-((fromCentre / 45) ** 2));
    const b = gaussian(rand) * thickness;
    if (Math.abs(b) > 32) continue;

    const intensity = brightness(l, b) * (0.55 + 0.45 * rand());
    if (intensity < 0.08) continue;

    patches.push({
      v: galacticToEqj(l, b),
      size: 2.5 + rand() * 7,
      intensity,
    });
  }

  return patches;
}
