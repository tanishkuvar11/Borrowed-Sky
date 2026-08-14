/**
 * The galactic frame, checked against published equatorial positions.
 *
 * The Milky Way band is the one piece of the scene that is drawn rather than
 * plotted from a catalogue, so its geometry has to be verified independently or
 * it is just decoration wearing a lab coat. Everything here is a number someone
 * else measured.
 *
 *   npx tsx scripts/verify/milkyway.check.ts
 */

import { buildMilkyWay, galacticBasis, galacticToEqj } from '../../src/lib/astro/milkyway.ts';

const DEG = Math.PI / 180;
const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function toRaDec(v: { x: number; y: number; z: number }) {
  const ra = (Math.atan2(v.y, v.x) / DEG + 360) % 360;
  const dec = Math.asin(Math.max(-1, Math.min(1, v.z))) / DEG;
  return { ra, dec };
}

/** Great-circle separation in arcseconds. */
function sep(
  a: { ra: number; dec: number },
  b: { ra: number; dec: number },
): number {
  const d =
    Math.sin(a.dec * DEG) * Math.sin(b.dec * DEG) +
    Math.cos(a.dec * DEG) * Math.cos(b.dec * DEG) * Math.cos((a.ra - b.ra) * DEG);
  return (Math.acos(Math.max(-1, Math.min(1, d))) / DEG) * 3600;
}

console.log('\ngalactic frame');

const basis = galacticBasis();
const dotXZ = basis.x.x * basis.z.x + basis.x.y * basis.z.y + basis.x.z * basis.z.z;
check('centre is perpendicular to the pole', Math.abs(dotXZ) < 2e-4, `dot=${dotXZ.toExponential(2)}`);

for (const [name, v] of Object.entries(basis)) {
  const len = Math.hypot(v.x, v.y, v.z);
  check(`${name} axis is unit length`, Math.abs(len - 1) < 1e-12, `|v|=${len.toFixed(15)}`);
}

const hand = {
  x: basis.x.y * basis.y.z - basis.x.z * basis.y.y,
  y: basis.x.z * basis.y.x - basis.x.x * basis.y.z,
  z: basis.x.x * basis.y.y - basis.x.y * basis.y.x,
};
const handDot = hand.x * basis.z.x + hand.y * basis.z.y + hand.z * basis.z.z;
check('frame is right-handed', handDot > 0.999, `x×y·z=${handDot.toFixed(6)}`);

console.log('\nknown directions  (published equatorial J2000 vs computed)');

// Independent published positions. Sgr A* is the observational anchor for the
// galactic centre; the NCP round-trip catches any error in the pole angle that
// a centre-only test would miss.
const cases: { label: string; l: number; b: number; ra: number; dec: number; tol: number }[] = [
  { label: 'Sagittarius A*', l: 359.9442, b: -0.0462, ra: 266.41684, dec: -29.00781, tol: 60 },
  { label: 'galactic centre', l: 0, b: 0, ra: 266.4051, dec: -28.936175, tol: 1 },
  { label: 'north galactic pole', l: 0, b: 90, ra: 192.85948, dec: 27.12825, tol: 1 },
  { label: 'north celestial pole', l: 122.93192, b: 27.12825, ra: 0, dec: 90, tol: 60 },
  { label: 'galactic anticentre', l: 180, b: 0, ra: 86.4051, dec: 28.936175, tol: 1 },
];

for (const c of cases) {
  const got = toRaDec(galacticToEqj(c.l, c.b));
  const arcsec = sep(got, { ra: c.ra, dec: c.dec });
  check(
    c.label,
    arcsec < c.tol,
    `off by ${arcsec.toFixed(1)}", got RA ${got.ra.toFixed(4)}° Dec ${got.dec.toFixed(4)}°`,
  );
}

console.log('\nband shape');

const patches = buildMilkyWay();
check('produces a usable number of patches', patches.length > 300, `${patches.length} patches`);

const unitLengths = patches.every((p) => Math.abs(Math.hypot(p.v.x, p.v.y, p.v.z) - 1) < 1e-9);
check('every patch is a unit vector', unitLengths);

// Brightness must favour the bulge over the anticentre: the single most
// recognisable property of the real band.
const centreVec = galacticToEqj(0, 0);
const antiVec = galacticToEqj(180, 0);
const near = (target: { x: number; y: number; z: number }) =>
  patches.filter((p) => p.v.x * target.x + p.v.y * target.y + p.v.z * target.z > Math.cos(25 * DEG));

const centreMean =
  near(centreVec).reduce((s, p) => s + p.intensity, 0) / Math.max(1, near(centreVec).length);
const antiMean =
  near(antiVec).reduce((s, p) => s + p.intensity, 0) / Math.max(1, near(antiVec).length);

check(
  'bulge is brighter than the anticentre',
  centreMean > antiMean * 1.5,
  `centre ${centreMean.toFixed(3)} vs anticentre ${antiMean.toFixed(3)}`,
);

// The plane should be tightly held: almost everything within a couple of tens
// of degrees of b = 0, or it reads as haze rather than a band.
const basisZ = basis.z;
const lat = patches.map((p) => Math.abs(Math.asin(p.v.x * basisZ.x + p.v.y * basisZ.y + p.v.z * basisZ.z) / DEG));
const within20 = lat.filter((b) => b <= 20).length / lat.length;
check('band is confined to the plane', within20 > 0.9, `${(within20 * 100).toFixed(1)}% within |b| ≤ 20°`);

console.log('');
if (failures.length) {
  console.error(`FAIL  ${failures.length} check(s): ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('PASS  galactic frame matches published positions');
}
