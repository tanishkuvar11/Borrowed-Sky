/**
 * Cross-checks the fast matrix pipeline in src/lib/astro/frames.ts against
 * astronomy-engine's own DefineStar -> Equator -> Horizon path.
 *
 * The two routes share no code: one collapses the transform into a single
 * matrix, the other goes through the library's per-object conversion. If they
 * agree to arcsecond level on real stars from real places, the matrix is right.
 *
 * Run: npx tsx scripts/verify/frames.check.ts
 */

import {
  Body,
  DefineStar,
  Equator,
  Horizon,
  MakeTime,
  Observer,
} from 'astronomy-engine';
import {
  buildViewMatrix,
  eqjToHorMatrix,
  eqjVector,
  horVectorToAltAz,
  rotateEqjToHor,
  projectionScale,
  angularSeparation,
  type Camera,
} from '../../src/lib/astro/frames.ts';

interface Star {
  name: string;
  ra: number;
  dec: number;
}

// J2000 positions straight from the shipped HYG catalogue.
const STARS: Star[] = [
  { name: 'Sirius', ra: 6.7525, dec: -16.7161 },
  { name: 'Vega', ra: 18.6156, dec: 38.7837 },
  { name: 'Polaris', ra: 2.5302, dec: 89.2641 },
  { name: 'Acrux', ra: 12.4433, dec: -63.0991 },
  { name: 'Betelgeuse', ra: 5.9195, dec: 7.4071 },
];

const PLACES = [
  { name: 'Johannesburg', lat: -26.2041, lon: 28.0473, elev: 1753 },
  { name: 'Reykjavik', lat: 64.1466, lon: -21.9426, elev: 30 },
  { name: 'Quito', lat: -0.1807, lon: -78.4678, elev: 2850 },
  { name: 'Nuuk', lat: 64.1836, lon: -51.7214, elev: 20 },
];

const TIMES = [
  new Date('2026-08-10T21:30:00Z'),
  new Date('2026-01-04T03:15:00Z'),
  new Date('2026-11-22T18:00:00Z'),
];

let worst = 0;
let worstLabel = '';
let checks = 0;

for (const place of PLACES) {
  const observer = new Observer(place.lat, place.lon, place.elev);
  for (const when of TIMES) {
    const time = MakeTime(when);
    const matrix = eqjToHorMatrix(time, observer);

    for (const star of STARS) {
      // Route A — the app's matrix path.
      const mine = horVectorToAltAz(rotateEqjToHor(matrix, eqjVector(star.ra, star.dec)));

      // Route B — astronomy-engine's own conversion. Aberration and refraction
      // are switched off so this compares frame maths, not modelling choices.
      DefineStar(Body.Star1, star.ra, star.dec, 1000);
      const eq = Equator(Body.Star1, time, observer, true, false);
      const theirs = Horizon(time, observer, eq.ra, eq.dec, null);

      const sep = angularSeparation(mine.altitude, mine.azimuth, theirs.altitude, theirs.azimuth);
      checks++;
      if (sep > worst) {
        worst = sep;
        worstLabel = `${star.name} from ${place.name} at ${when.toISOString()}`;
      }
    }
  }
}

console.log(`frame cross-check: ${checks} comparisons`);
console.log(`worst disagreement: ${(worst * 3600).toFixed(2)} arcsec  (${worstLabel})`);

// --- projection sanity ------------------------------------------------------

const camera: Camera = { azimuth: 180, altitude: 40, roll: 0, fov: 70 };
const observer = new Observer(-26.2041, 28.0473, 1753);
const matrix = eqjToHorMatrix(MakeTime(new Date('2026-08-10T21:30:00Z')), observer);
const view = buildViewMatrix(camera, matrix);

const scale = projectionScale(camera.fov, 400);

// The invariants the renderer depends on: an orthonormal basis (so the view
// neither shears nor scales), and a half-FOV that lands exactly on the
// requested pixel radius.
function rowDot(a: number, b: number) {
  return view[a * 3] * view[b * 3] + view[a * 3 + 1] * view[b * 3 + 1] + view[a * 3 + 2] * view[b * 3 + 2];
}
const orthoErr = Math.max(
  Math.abs(rowDot(0, 0) - 1),
  Math.abs(rowDot(1, 1) - 1),
  Math.abs(rowDot(2, 2) - 1),
  Math.abs(rowDot(0, 1)),
  Math.abs(rowDot(0, 2)),
  Math.abs(rowDot(1, 2)),
);
console.log(`view basis orthonormality error: ${orthoErr.toExponential(2)}`);

const edge = Math.tan(((camera.fov / 2) * Math.PI) / 180 / 2) * scale;
console.log(`half-FOV maps to ${edge.toFixed(1)} px (expected 400.0)`);

const ok = worst * 3600 < 5 && orthoErr < 1e-12 && Math.abs(edge - 400) < 0.01;
console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
