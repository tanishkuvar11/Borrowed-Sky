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
  /**
   * Colour temperature of the patch, 0 cool to 1 warm.
   *
   * Not decoration. Integrated starlight along the inner plane really is warm:
   * the bulge is old and metal-rich, and everything behind the near dust is
   * reddened on the way to us. Look away from the centre or up out of the plane
   * and both effects weaken, leaving the bluer light of nearby young arms.
   */
  temperature: number;
}

/**
 * An obscuring cloud: dust in front of the band rather than light in it.
 *
 * The dark lanes are the single feature that makes the Milky Way read as a
 * structure with depth instead of a smear, and they are not gaps. They are
 * cold molecular clouds close enough to blot out everything behind them, which
 * is why they are drawn as their own pass, subtracting from the band after it
 * is laid down.
 */
export interface DustPatch {
  v: Vec3;
  size: number;
  /** How completely this patch blots out what is behind it, 0–1. */
  opacity: number;
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
      temperature: temperature(l, b),
    });
  }

  return patches;
}

/**
 * Colour temperature of the integrated light at a point on the band, 0–1.
 *
 * Two real effects, both pointing the same way. Looking towards the centre you
 * are looking down the length of the disc, so the light has crossed the most
 * dust and is the most reddened; and the inner galaxy's light is dominated by
 * an old, metal-rich population that is intrinsically yellow. Both weaken with
 * galactic longitude away from the centre and with height out of the plane,
 * where the sight line leaves the dust layer early.
 */
function temperature(lDeg: number, bDeg: number): number {
  const l = ((lDeg % 360) + 360) % 360;
  const fromCentre = l > 180 ? 360 - l : l;

  const inner = Math.pow(Math.cos((fromCentre / 180) * (Math.PI / 2)), 2.2);
  const inPlane = Math.exp(-((bDeg / 9) ** 2));
  return Math.max(0, Math.min(1, 0.12 + 0.88 * inner * inPlane));
}

/**
 * The named dark clouds, at their real galactic coordinates.
 *
 * These are the ones a naked eye actually picks out of the band, which is the
 * whole reason to draw them: someone who knows the sky should be able to find
 * the Coalsack next to the Southern Cross in this rendering. Longitude,
 * latitude, angular radius in degrees, and how thoroughly each blots out the
 * light behind it.
 */
const DARK_CLOUDS: [number, number, number, number][] = [
  // The Great Rift, the long split running from Cygnus down through Aquila and
  // Ophiuchus. Drawn as a chain, because it is one.
  [80, 0.5, 7, 0.72],
  [70, 1.5, 6.5, 0.62],
  [59, 1, 6, 0.66],
  [48, 0.5, 6.5, 0.7],
  [38, 1.5, 6, 0.68],
  [29, 2.5, 6.5, 0.72],
  [21, 3, 6, 0.66],
  [13, 4, 5.5, 0.6],
  // The Pipe Nebula and the Ophiuchus dark complex, above the bulge.
  [357, 7, 4.5, 0.74],
  [353, 16, 5, 0.5],
  // The Coalsack, beside the Southern Cross.
  [303, -1, 4.5, 0.8],
  // The Cygnus Rift's northern extension, towards Cepheus.
  [95, 2, 5, 0.45],
  // The Taurus and Perseus clouds, out towards the anticentre.
  [172, -15, 5, 0.36],
  [158, -20, 4.5, 0.3],
];

/**
 * A cloud of obscuring patches, scattered around the real dark nebulae.
 *
 * Same deal as the band itself: the positions of the clouds are real and the
 * texture within each one is generated. Seeded separately from the band so
 * adding or removing dust cannot reshuffle the stars' backdrop.
 */
export function buildDust(perCloud = 26): DustPatch[] {
  const rand = mulberry32(0xda57);
  const patches: DustPatch[] = [];

  for (const [l, b, radius, opacity] of DARK_CLOUDS) {
    for (let i = 0; i < perCloud; i++) {
      // Clustered towards the centre of the cloud, so it has a dense core and
      // ragged edges rather than a uniform disc.
      const spread = Math.pow(rand(), 0.6);
      const angle = rand() * Math.PI * 2;
      const dl = (Math.cos(angle) * spread * radius) / Math.max(0.2, Math.cos(b * DEG));
      const db = Math.sin(angle) * spread * radius * 0.75;

      patches.push({
        v: galacticToEqj(l + dl, b + db),
        size: radius * (0.35 + 0.4 * rand()),
        opacity: opacity * (1 - 0.55 * spread) * (0.6 + 0.4 * rand()),
      });
    }
  }

  return patches;
}
