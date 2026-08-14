/**
 * Exercises the Tonight's Sky timeline at several latitudes, including the ones
 * that break naive implementations: an Arctic site in midsummer where darkness
 * never arrives, and the equator where everything rises and sets vertically.
 *
 * Run: npx tsx scripts/verify/events.check.ts
 */

import { buildTimeline } from '../../src/lib/astro/events.ts';
import { parseTle, type TleSet } from '../../src/lib/astro/satellites.ts';
import type { ObserverSite } from '../../src/lib/astro/types.ts';

const res = await fetch('https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle', {
  headers: { 'User-Agent': 'BorrowedSky/1.0 verification' },
});
const tleSet: TleSet = {
  group: 'stations',
  fetchedAt: Date.now(),
  stale: false,
  records: parseTle(await res.text()),
};

const SITES: ObserverSite[] = [
  { latitude: -26.2041, longitude: 28.0473, elevation: 1753, source: 'manual', label: 'Johannesburg' },
  { latitude: 78.2232, longitude: 15.6469, elevation: 10, source: 'manual', label: 'Longyearbyen (Arctic)' },
  { latitude: -0.1807, longitude: -78.4678, elevation: 2850, source: 'manual', label: 'Quito (equator)' },
  { latitude: 28.6139, longitude: 77.209, elevation: 216, source: 'manual', label: 'Delhi' },
];

const failures: string[] = [];
const now = new Date();

for (const site of SITES) {
  console.log(`\n=== ${site.label} ===`);
  const t0 = Date.now();
  const timeline = buildTimeline(now, site, tleSet, undefined, 12);
  const elapsed = Date.now() - t0;

  console.log(`built in ${elapsed} ms, ${timeline.spans.length} spans, ${timeline.moments.length} moments`);
  console.log(`moon: ${timeline.moonPhase.name}, ${(timeline.moonPhase.illuminatedFraction * 100).toFixed(0)}% lit`);
  console.log(
    timeline.darkness
      ? `darkness: ${timeline.darkness.start.toISOString().slice(11, 16)} -> ${timeline.darkness.end.toISOString().slice(11, 16)} UTC`
      : 'darkness: none in this window (sun never gets 6 deg below the horizon)',
  );

  for (const m of timeline.moments) {
    console.log(`  moment  ${m.time.toISOString().slice(11, 16)}Z  ${m.label}`);
  }
  for (const s of timeline.spans.slice(0, 6)) {
    console.log(
      `  span    ${s.start.toISOString().slice(11, 16)}Z-${s.end.toISOString().slice(11, 16)}Z  ` +
        `[${s.quality.padEnd(8)}] ${s.name}`,
    );
  }
  if (timeline.spans.length) console.log(`  detail  "${timeline.spans[0].detail}"`);

  // --- invariants ---
  const windowEnd = now.getTime() + 12 * 3_600_000;
  for (const s of timeline.spans) {
    if (s.start >= s.end) failures.push(`${site.label}: span ${s.id} starts after it ends`);
    if (s.start.getTime() < now.getTime() - 60_000 || s.end.getTime() > windowEnd + 60_000) {
      failures.push(`${site.label}: span ${s.id} falls outside the window`);
    }
    if (s.peakAltitude !== undefined && (s.peakAltitude < 0 || s.peakAltitude > 90)) {
      failures.push(`${site.label}: span ${s.id} has an impossible peak altitude`);
    }
  }
  for (const m of timeline.moments) {
    if (m.time < now || m.time.getTime() > windowEnd) {
      failures.push(`${site.label}: moment ${m.id} falls outside the window`);
    }
  }
  if (elapsed > 4000) failures.push(`${site.label}: timeline took ${elapsed} ms`);
}

console.log(failures.length ? `\nFAIL\n  ${failures.join('\n  ')}` : '\nPASS');
process.exit(failures.length ? 1 : 0);
