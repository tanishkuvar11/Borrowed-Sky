/**
 * The night correction, and above all the promise that it is only a correction.
 *
 * This feature has been built three times and reverted twice, both times for
 * the same underlying reason: it replaced the four hand-written magnitudes
 * instead of adjusting them, and the replacement had nothing sensible to say
 * about daylight. The first version reported a limiting magnitude of 4.72 with
 * the Sun forty five degrees up. The second moved daylight from -3.5 to +1.0,
 * which lists Sirius, Vega and fourteen others as visible at noon.
 *
 * Both passed their own suites. So the first cases here are not about the model
 * being accurate; they are about it being unable to reach the places it has
 * already been wrong about, and they are written against the app's real
 * visibility decision rather than against the module in isolation, because the
 * bug both times was in the wiring rather than in the arithmetic.
 *
 * Run: npx tsx scripts/verify/skyquality.check.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { nakedEyeVisible, skyQualityInput } from '../../src/lib/astro/solar.ts';
import { skyQuality, _setModelForTesting } from '../../src/lib/astro/skyquality.ts';
import type { SkyBody, SkyConditions, ObserverSite } from '../../src/lib/astro/types.ts';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

const model = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../public/data/skymodel.json', import.meta.url)), 'utf8'),
);
_setModelForTesting(model);

/** A star of a given brightness, so visibility can be asked about directly. */
function star(magnitude: number): SkyBody {
  return {
    id: 'test',
    kind: 'star',
    name: 'test star',
    altitude: 45,
    azimuth: 180,
    magnitude,
  } as SkyBody;
}

const site: ObserverSite = { latitude: 51.48, longitude: 0, elevation: 0, source: 'gps' };

function conditions(sunAltitude: number, moonAltitude = -30, lit = 0): SkyConditions {
  const darkness =
    sunAltitude > -0.833
      ? 'day'
      : sunAltitude > -6
        ? 'civil-twilight'
        : sunAltitude > -12
          ? 'nautical-twilight'
          : sunAltitude > -18
            ? 'astronomical-twilight'
            : 'night';
  return {
    sunAltitude,
    sunAzimuth: 180,
    darkness,
    summary: '',
    moonIlluminatedFraction: lit,
    moonAltitude,
    moonPhaseName: '',
  } as SkyConditions;
}

/** The brightest star in the sky, and the test both earlier versions failed. */
const SIRIUS = -1.46;

console.log('\ndaylight and twilight are untouched');
for (const [label, sunAltitude] of [
  ['the Sun forty five degrees up', 45],
  ['the Sun on the horizon', 0],
  ['civil twilight', -3],
  ['nautical twilight', -9],
  ['astronomical twilight', -15],
] as [string, number][]) {
  const c = conditions(sunAltitude);
  const q = skyQuality(skyQualityInput(site, c));
  const sirius = nakedEyeVisible(star(SIRIUS), c.darkness, skyQualityInput(site, c));
  check(
    `${label}: the correction is exactly zero`,
    q.adjustment === 0,
    q.adjustment.toFixed(4),
  );
  if (sunAltitude > -0.833) {
    check('  and Sirius is not claimed to be visible at noon', sirius === false);
  }
}

console.log('\nand the same answer with the model as without it');
{
  /*
   * The structural claim, checked rather than asserted. Outside astronomical
   * night, passing the sky must give the identical answer to passing nothing,
   * for every brightness the app can show. If a future change makes the
   * correction reach into twilight, this is what goes red.
   */
  let same = true;
  for (const sunAltitude of [45, 10, 0, -3, -9, -15, -17.9]) {
    const c = conditions(sunAltitude, 60, 1);
    for (let m = -5; m <= 7; m += 0.25) {
      const withSky = nakedEyeVisible(star(m), c.darkness, skyQualityInput(site, c));
      const without = nakedEyeVisible(star(m), c.darkness);
      if (withSky !== without) same = false;
    }
  }
  check('every brightness, every band above -18 degrees, identical', same);
}

console.log('\nat night it does something, and in the right direction');
{
  const dark = conditions(-40);
  const moonlit = conditions(-40, 70, 1);
  const darkQ = skyQuality(skyQualityInput(site, dark));
  const moonQ = skyQuality(skyQualityInput(site, moonlit));

  check(
    'a full Moon overhead takes stars away rather than adding them',
    moonQ.adjustment < darkQ.adjustment,
    `${moonQ.adjustment.toFixed(3)} against ${darkQ.adjustment.toFixed(3)} magnitudes`,
  );
  check(
    'and the difference is worth having but not extravagant',
    darkQ.adjustment - moonQ.adjustment > 0.1 && darkQ.adjustment - moonQ.adjustment < 1.5,
    `${(darkQ.adjustment - moonQ.adjustment).toFixed(3)} magnitudes`,
  );

  // The thing a person would actually notice: a faint star that a moonless sky
  // gives you and a full Moon takes away.
  const faint = star(5.2);
  check(
    'a faint star visible on a moonless night is lost under a full Moon',
    nakedEyeVisible(faint, dark.darkness, skyQualityInput(site, dark)) === true &&
      nakedEyeVisible(faint, moonlit.darkness, skyQualityInput(site, moonlit)) === false,
  );
}

console.log('\nplaces it has never heard of');
{
  // The middle of the Pacific. No observations, so no light pollution term, and
  // it must say so rather than borrow somebody else's sky.
  const remote: ObserverSite = { latitude: -30, longitude: -140, elevation: 0, source: 'gps' };
  const q = skyQuality(skyQualityInput(remote, conditions(-40)));
  check('report that the answer is not local', q.localised === false);
  check('and still return something bounded', Math.abs(q.adjustment) <= 1.5, q.adjustment.toFixed(3));
}

console.log('\nbounds');
{
  let worst = 0;
  for (const lat of [-60, -30, 0, 30, 51.48, 60]) {
    for (const lon of [-140, -75, 0, 12, 77, 150]) {
      for (const lit of [0, 0.5, 1]) {
        const q = skyQuality(
          skyQualityInput({ latitude: lat, longitude: lon, elevation: 0, source: 'gps' }, conditions(-40, 60, lit)),
        );
        if (!Number.isFinite(q.adjustment)) worst = NaN;
        worst = Math.max(worst, Math.abs(q.adjustment));
      }
    }
  }
  check('no correction anywhere exceeds the clamp', worst <= 1.5, `largest ${worst.toFixed(3)} magnitudes`);
  check('and none is NaN', Number.isFinite(worst));
}

console.log('\nwithout the model file at all');
{
  _setModelForTesting(null);
  const c = conditions(-40, 70, 1);
  check(
    'the correction is zero and the app is exactly what it was',
    skyQuality(skyQualityInput(site, c)).adjustment === 0 &&
      nakedEyeVisible(star(5.2), c.darkness, skyQualityInput(site, c)) ===
        nakedEyeVisible(star(5.2), c.darkness),
  );
  _setModelForTesting(model);
}

console.log('\nwhat the fit says');
console.log(`  held out on ${model.testRows} night observations`);
console.log(`  a constant  ${model.constantRmse}`);
console.log(`  this model  ${model.modelRmse}`);
check(
  'the model beats a constant on held-out night observations',
  model.modelRmse < model.constantRmse,
  `${(((model.constantRmse - model.modelRmse) / model.constantRmse) * 100).toFixed(1)}% better`,
);

console.log('');
if (failures.length) {
  console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('PASS  the night correction corrects the night, and only the night');
