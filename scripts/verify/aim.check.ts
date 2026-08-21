/**
 * Which way the phone says you are facing, including where that question
 * stops having a stable answer.
 *
 * This exists because of a bug somebody found by standing outside holding a
 * phone at the sky: the view would snap from west to east and back while they
 * held still. It was not the sensor. Azimuth was read off the look direction's
 * horizontal part, and pointing a phone up drives that part to nothing, so a
 * millimetre of hand shake swung the answer through any angle it liked. A
 * division had run out of numerator.
 *
 * The cases below build device orientations directly rather than replaying a
 * recording, because the interesting ones are the ones nobody can hold still
 * enough to capture: eighty-nine degrees up, with a thousandth of a unit of
 * tremor on it.
 *
 * Run: npx tsx scripts/verify/aim.check.ts
 */

import { aimFrom } from '../../src/hooks/useOrientation.ts';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const DEG = Math.PI / 180;

/**
 * A phone held at a bearing and an altitude, upright in its own plane.
 *
 * World frame is the one the hook uses: x east, y north, z up. `up` is the
 * screen's up axis, which is perpendicular to the look direction and in the
 * same vertical plane, which is what happens when somebody holds a phone the
 * normal way round and tips it at the sky.
 */
function phoneAt(azimuthDeg: number, altitudeDeg: number) {
  const a = azimuthDeg * DEG;
  const h = altitudeDeg * DEG;
  const look = [Math.sin(a) * Math.cos(h), Math.cos(a) * Math.cos(h), Math.sin(h)];
  const up = [-Math.sin(a) * Math.sin(h), -Math.cos(a) * Math.sin(h), Math.cos(h)];
  return { look, up };
}

/** How far apart two bearings are, the short way round. */
function apart(a: number, b: number): number {
  let d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

console.log('\nthe bearing is read correctly at ordinary altitudes');
for (const azimuth of [0, 90, 180, 270, 315]) {
  for (const altitude of [0, 20, 45, 70]) {
    const { look, up } = phoneAt(azimuth, altitude);
    const aim = aimFrom(look, up);
    const ok = apart(aim.azimuth, azimuth) < 0.5 && Math.abs(aim.altitude - altitude) < 0.5;
    if (!ok) {
      check(`${azimuth}deg at ${altitude}deg up`, false, `got ${aim.azimuth.toFixed(1)}`);
    }
  }
}
check('all twenty ordinary orientations read back correctly', failures.length === 0);

console.log('\nand it stays put as the phone comes up to the zenith');
{
  // Sweep to straight up. Every step must be a small step: this is the shape
  // of the bug, a large jump appearing somewhere in a continuous movement.
  let previous = aimFrom(...Object.values(phoneAt(270, 0)) as [number[], number[]]).azimuth;
  let worst = 0;
  let worstAt = 0;
  for (let altitude = 0; altitude <= 89.9; altitude += 0.1) {
    const { look, up } = phoneAt(270, altitude);
    const azimuth = aimFrom(look, up).azimuth;
    const step = apart(azimuth, previous);
    if (step > worst) {
      worst = step;
      worstAt = altitude;
    }
    previous = azimuth;
  }
  check(
    'facing west, tipping from the horizon to the zenith never jumps',
    worst < 1,
    `worst step ${worst.toFixed(2)}deg at ${worstAt.toFixed(1)}deg up`,
  );
}

console.log('\nand a shaking hand at the zenith does not spin it');
{
  /*
   * The reported bug, reproduced. At 89.5 degrees the look vector's horizontal
   * part is under a hundredth, so tremor of a thousandth is a tenth of the
   * signal: reading the bearing off that alone gives whatever it likes.
   */
  const tremor = 0.001;
  const readings: number[] = [];
  for (let i = 0; i < 64; i++) {
    const { look, up } = phoneAt(270, 89.5);
    const angle = (i / 64) * 2 * Math.PI;
    look[0] += Math.cos(angle) * tremor;
    look[1] += Math.sin(angle) * tremor;
    readings.push(aimFrom(look, up).azimuth);
  }

  let spread = 0;
  for (const a of readings) for (const b of readings) spread = Math.max(spread, apart(a, b));

  check(
    'the bearing holds still while the look vector is jittered around the zenith',
    spread < 5,
    `spread ${spread.toFixed(1)}deg across 64 samples`,
  );
  check(
    'and it still says west rather than some other direction entirely',
    apart(readings[0], 270) < 5,
    `${readings[0].toFixed(1)}deg`,
  );
}

console.log('');
if (failures.length) {
  console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('PASS  the aim is stable everywhere, including where the maths runs out');
