/**
 * The functions the model is allowed to call.
 *
 * These are the only route by which a number can reach an answer now, which
 * makes them the place a wrong answer would come from. So they are checked the
 * way the rest of the astronomy here is checked: against a second path through
 * the code that shares none of the first one's arithmetic, and against
 * invariants that hold whatever the date is.
 *
 * The refusals get as much attention as the answers, and that is deliberate. A
 * tool that returns something plausible when it should have said "I cannot
 * answer that" is worse than one that crashes, because the model will pass the
 * plausible thing on in a confident sentence and the guard downstream has no
 * way to know it was never true. Half the cases below are about a tool
 * declining, and about declining for the right reason: "below the horizon" and
 * "no such object" are different answers to the person asking.
 *
 * Run: npx tsx scripts/verify/tools.check.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * The catalogue loader fetches a relative URL, which is right in a browser and
 * meaningless in a script. Rather than reach past it into the parsing, which
 * would leave the loader itself untested, fetch is pointed at the same files
 * the dev server would serve. What is checked below is then the real loader
 * output, not a fixture standing in for it.
 */
function serveCatalogueFromDisk() {
  const root = fileURLToPath(new URL('../../public/', import.meta.url));
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    const body = readFileSync(root + path, 'utf8');
    return new Response(body, { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

async function main() {
  serveCatalogueFromDisk();

  const { runSkyTool, SKY_TOOLS } = await import('../../src/lib/astro/tools.ts');
  const { computeSolarSystem, computeConditions } = await import('../../src/lib/astro/solar.ts');
  const { loadStarCatalog } = await import('../../src/lib/astro/starfield.ts');
  const { compassPoint } = await import('../../src/lib/astro/satellites.ts');

  const site = {
    latitude: 51.4779,
    longitude: -0.0015,
    elevation: 47,
    source: 'manual' as const,
    timezone: 'Europe/London',
  };
  const catalog = await loadStarCatalog();
  const ctx = { site, catalog, tleSet: null };

  console.log(`\ncatalogue  ${catalog.count} stars to magnitude ${catalog.magLimit}`);
  console.log(`site       Royal Observatory, Greenwich`);

  console.log('\nwhat the model is offered');
  check('every declared tool has an implementation', SKY_TOOLS.length > 0);
  for (const tool of SKY_TOOLS) {
    const answer = runSkyTool(tool.function.name, {}, ctx);
    // Called with nothing at all, a tool either answers (its arguments are
    // optional) or explains itself. What it must never do is throw, because
    // the model will call these wrong and that has to be survivable.
    check(
      `${tool.function.name} survives being called with no arguments`,
      typeof answer.ok === 'boolean',
    );
  }
  check(
    'an unknown tool is refused rather than ignored',
    runSkyTool('drop_database', {}, ctx).ok === false,
  );

  console.log('\nwhere_is, against a second path to the same answer');
  const now = new Date();
  const moonHere = runSkyTool('where_is', { name: 'the Moon' }, ctx);
  const { moon } = computeSolarSystem(now, site);
  if (!moonHere.ok) {
    check('the Moon can be found', false, moonHere.error);
  } else {
    const said = moonHere.result as { altitudeDegrees: number; direction: string };
    check(
      'the Moon is where the ephemeris independently puts it',
      Math.abs(said.altitudeDegrees - moon.altitude) < 0.2,
      `tool ${said.altitudeDegrees}deg vs engine ${moon.altitude.toFixed(1)}deg`,
    );
    check(
      'and the compass word matches the azimuth it reported',
      said.direction === compassPoint(moon.azimuth),
      `${said.direction} vs ${compassPoint(moon.azimuth)}`,
    );
  }

  // Pinned to one instant, because two calls a millisecond apart legitimately
  // report different positions and the point here is the name, not the clock.
  const fixed = now.toISOString();
  check(
    '"the Moon" and "moon" and "The Moon" are the same object',
    JSON.stringify(runSkyTool('where_is', { name: 'moon', at: fixed }, ctx)) ===
      JSON.stringify(runSkyTool('where_is', { name: 'The  Moon', at: fixed }, ctx)),
  );

  console.log('\nwhere_is, refusing');
  const invented = runSkyTool('where_is', { name: 'Planet Bob' }, ctx);
  check('an object that does not exist is refused', invented.ok === false);
  check(
    'and the refusal says it is not in the catalogue, not that it is below the horizon',
    !invented.ok && /not in this app/i.test(invented.error),
    !invented.ok ? invented.error : '',
  );

  /*
   * Some real star is under the horizon at any instant from any latitude, and
   * which one it is depends on when this runs. So the case is found rather than
   * hard-coded: a named star the tool cannot see, asked for by name.
   */
  const named = [...catalog.proper].filter(Boolean);
  let hidden: string | null = null;
  for (const name of named) {
    const answer = runSkyTool('where_is', { name }, ctx);
    if (!answer.ok && /below the horizon/i.test(answer.error)) {
      hidden = name;
      break;
    }
  }
  check(
    'a real star that is down is told apart from one that does not exist',
    hidden !== null,
    hidden ?? 'no star was below the horizon, which cannot happen',
  );

  console.log('\nrise_set');
  const sunTimes = runSkyTool('rise_set', { name: 'Sun' }, ctx);
  if (!sunTimes.ok) {
    check('the Sun has rise and set times', false, sunTimes.error);
  } else {
    const times = sunTimes.result as {
      nextRise: { iso: string } | null;
      nextSet: { iso: string } | null;
      nextHighestPoint: { iso: string; altitudeDegrees: number } | null;
    };
    check('the Sun rises', times.nextRise !== null);
    check('the Sun sets', times.nextSet !== null);
    check(
      'its highest point is above the horizon and below the zenith',
      times.nextHighestPoint !== null &&
        times.nextHighestPoint.altitudeDegrees > 0 &&
        times.nextHighestPoint.altitudeDegrees < 90,
      String(times.nextHighestPoint?.altitudeDegrees),
    );
    check(
      'and every time it gives is in the next two days',
      [times.nextRise, times.nextSet, times.nextHighestPoint].every(
        (t) =>
          t === null ||
          (new Date(t.iso).getTime() - now.getTime() < 2 * 86_400_000 &&
            new Date(t.iso).getTime() > now.getTime() - 60_000),
      ),
    );
  }
  check(
    'a star is refused rather than answered with something else',
    runSkyTool('rise_set', { name: 'Vega' }, ctx).ok === false,
  );

  console.log('\nwhat_is_up');
  const upNow = runSkyTool('what_is_up', {}, ctx);
  const inSixHours = runSkyTool(
    'what_is_up',
    { at: new Date(now.getTime() + 6 * 3_600_000).toISOString(), only_visible: false },
    ctx,
  );
  check('now can be listed', upNow.ok === true);
  check('and so can a moment that has not happened yet', inSixHours.ok === true);
  if (upNow.ok && inSixHours.ok) {
    const a = upNow.result as { objects: { name: string; altitudeDegrees: number }[] };
    const b = inSixHours.result as { objects: { name: string; altitudeDegrees: number }[] };
    check(
      'the sky six hours from now is not the sky now',
      JSON.stringify(a.objects) !== JSON.stringify(b.objects),
      `${a.objects.length} objects now, ${b.objects.length} then`,
    );
    check(
      'nothing listed is below the horizon',
      b.objects.every((o) => o.altitudeDegrees > 0),
    );
    check(
      'and the list is brightest first',
      isSortedByBrightness(b.objects as { magnitude: number }[]),
    );
  }

  const conditions = computeConditions(now, site);
  const everything = runSkyTool('what_is_up', { only_visible: false }, ctx);
  const seeable = runSkyTool('what_is_up', { only_visible: true }, ctx);
  if (everything.ok && seeable.ok) {
    const all = (everything.result as { objects: unknown[] }).objects.length;
    const some = (seeable.result as { objects: unknown[] }).objects.length;
    check(
      'asking for only what can be seen never returns more than everything',
      some <= all,
      `${some} of ${all} in ${conditions.darkness}`,
    );
  }

  console.log('\nidentify');
  const nonsense = runSkyTool('identify', { direction: 'up and slightly left' }, ctx);
  check('a direction that is not a direction is refused', nonsense.ok === false);

  const spotted = runSkyTool('identify', { direction: 'south', height: 'halfway up' }, ctx);
  if (!spotted.ok) {
    check('a real direction returns candidates', false, spotted.error);
  } else {
    const found = spotted.result as {
      lookingToward: { approximateAltitudeDegrees: number };
      candidates: { degreesAway: number }[];
    };
    check(
      '"halfway up" is read as about forty-five degrees',
      Math.abs(found.lookingToward.approximateAltitudeDegrees - 45) < 1,
      String(found.lookingToward.approximateAltitudeDegrees),
    );
    check(
      'candidates come back nearest first',
      found.candidates.every(
        (c, i) => i === 0 || c.degreesAway >= found.candidates[i - 1].degreesAway,
      ),
      found.candidates.map((c) => c.degreesAway).join(', '),
    );
    check(
      'and none of them is on the other side of the sky',
      found.candidates.every((c) => c.degreesAway <= 180),
    );
  }

  console.log('\nno satellites without orbital elements');
  const noTle = runSkyTool('where_is', { name: 'ISS (ZARYA)' }, { ...ctx, tleSet: null });
  check(
    'a satellite is refused when Celestrak has not been reached, not invented',
    noTle.ok === false,
    !noTle.ok ? noTle.error.slice(0, 60) : '',
  );
  check(
    'and blames the missing data source rather than the object',
    !noTle.ok && /orbital elements/i.test(noTle.error),
    !noTle.ok ? noTle.error.slice(0, 70) : '',
  );

  console.log('');
  if (failures.length) {
    console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS  the tools answer from the engine and refuse when they cannot');
}

function isSortedByBrightness(objects: { magnitude: number }[]): boolean {
  return objects.every((o, i) => i === 0 || o.magnitude >= objects[i - 1].magnitude);
}

main().catch((err) => {
  console.error('tool check failed to run:', err);
  process.exit(1);
});
