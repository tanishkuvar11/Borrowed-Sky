/**
 * Validates the stellar population clustering against the luminosity classes
 * recorded in the HYG catalogue.
 *
 * The clustering never sees spectral or luminosity class: it operates only on
 * B-V colour index and absolute magnitude. The check then compares what it
 * found against the held-out luminosity classes. If the groups align with
 * classes they were never shown, the structure is real.
 *
 * Case 8 is the one that makes the rest mean anything. The same clustering is
 * run against shuffled luminosity class assignments, which breaks any real
 * correspondence while leaving the class distribution exactly intact. If
 * agreement stays high under the shuffle, the metric was measuring the shape
 * of the class distribution, not any actual correspondence -- a passing score
 * against that baseline is no evidence at all. Sixty per cent against a third
 * is a real signal; sixty per cent against fifty-eight is not.
 *
 * Run: npx tsx scripts/verify/populations.check.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  plottableStars,
  findPopulations,
  type Population,
} from '../../src/lib/astro/populations.ts';
import type { StarCatalog } from '../../src/lib/astro/starfield.ts';

// ---------------------------------------------------------------------------
// Minimal catalogue loader (no fetch, no browser APIs)
// ---------------------------------------------------------------------------

interface StarsFile {
  count: number;
  fields: string[];
  stars: (string | number)[][];
}

const dataPath = fileURLToPath(new URL('../../public/data/stars.json', import.meta.url));
const file = JSON.parse(readFileSync(dataPath, 'utf8')) as StarsFile;

// Build a StarCatalog-shaped object from the raw JSON, matching the layout
// that readStarCatalog produces in starfield.ts.
const iRa = file.fields.indexOf('ra_hours');
const iDec = file.fields.indexOf('dec_deg');
const iMag = file.fields.indexOf('mag');
const iCi = file.fields.indexOf('colorIndex');
const iSpect = file.fields.indexOf('spect');
const iDist = file.fields.indexOf('dist_ly');

const n = file.stars.length;
const magnitude = new Float32Array(n);
const colorIndex = new Float32Array(n);
const distanceLy = new Float32Array(n);
const spectral: string[] = new Array(n);

for (let i = 0; i < n; i++) {
  const s = file.stars[i];
  magnitude[i] = s[iMag] as number;
  colorIndex[i] = s[iCi] as number;
  distanceLy[i] = s[iDist] as number;
  spectral[i] = String(s[iSpect] ?? '');
}

// Only the fields used by plottableStars and the checks below are needed.
const catalog = {
  count: n,
  magnitude,
  colorIndex,
  distanceLy,
  spectral,
} as unknown as StarCatalog;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * The luminosity class portion of a spectral string, or null if absent.
 * Matches the same regex as catalog.check.ts so the two are consistent.
 */
function luminosityClass(spect: string): string | null {
  const withoutType = spect.replace(/^[a-zA-Z]{0,2}[OBAFGKMWSCR][0-9.]*/, '');
  const match = /(VII|VI|IV|III|II|Iab|Ia|Ib|V|I)/.exec(withoutType);
  return match ? match[1] : null;
}

function isGiantOrSuperGiant(lc: string): boolean {
  return lc === 'I' || lc === 'Ia' || lc === 'Ib' || lc === 'Iab' || lc === 'II' || lc === 'III';
}

/**
 * Given a list of populations and a star-index-to-luminosity-class map,
 * returns the fraction of stars (that carry a luminosity class) whose cluster's
 * majority class matches their actual class.
 *
 * The majority class of a cluster is defined as the most common luminosity
 * class among its members that carry one.
 */
function agreementRate(populations: Population[], classOf: Map<number, string>): number {
  // For each cluster, find the majority luminosity class among its members.
  const majorityClass = new Map<number, string>();
  for (const pop of populations) {
    const counts = new Map<string, number>();
    for (const idx of pop.members) {
      const lc = classOf.get(idx);
      if (lc) counts.set(lc, (counts.get(lc) ?? 0) + 1);
    }
    let best = '';
    let bestCount = 0;
    for (const [lc, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        best = lc;
      }
    }
    majorityClass.set(pop.id, best);
  }

  // Count stars whose actual class matches their cluster's majority class.
  let matched = 0;
  let total = 0;
  for (const pop of populations) {
    const majority = majorityClass.get(pop.id) ?? '';
    for (const idx of pop.members) {
      const lc = classOf.get(idx);
      if (!lc) continue;
      total++;
      if (lc === majority) matched++;
    }
  }
  return total > 0 ? matched / total : 0;
}

/** Seeded shuffle using the same mulberry32 PRNG used by the clustering. */
function shuffledCopy<T>(arr: T[], seed: number): T[] {
  let s = seed >>> 0;
  function rand(): number {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  }
  const copy = arr.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy;
}

/**
 * Prints a confusion table: rows are clusters (by name), columns are the most
 * common luminosity classes. Values are raw counts.
 */
function printConfusion(populations: Population[], classOf: Map<number, string>) {
  const allClasses = ['V', 'IV', 'III', 'II', 'Ib', 'Ia', 'I'];
  // Only show classes that actually appear.
  const present = allClasses.filter((lc) =>
    populations.some((pop) => pop.members.some((i) => classOf.get(i) === lc)),
  );

  const colW = 6;
  const nameW = 28;
  const header = 'Cluster'.padEnd(nameW) + present.map((lc) => lc.padStart(colW)).join('');
  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  for (const pop of populations) {
    const counts = new Map<string, number>();
    for (const idx of pop.members) {
      const lc = classOf.get(idx);
      if (lc) counts.set(lc, (counts.get(lc) ?? 0) + 1);
    }
    const row =
      pop.name.padEnd(nameW) +
      present.map((lc) => String(counts.get(lc) ?? 0).padStart(colW)).join('');
    console.log(row);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Build the data structures used across all cases
// ---------------------------------------------------------------------------

const points = plottableStars(catalog);
const populations = findPopulations(points);

// Map from catalogue index to luminosity class, for the held-out validation.
const classOf = new Map<number, string>();
for (let i = 0; i < n; i++) {
  const lc = luminosityClass(spectral[i]);
  if (lc) classOf.set(i, lc);
}

// Set of indices present in plottableStars, for the shuffle test.
const plottableIndices = points.map((p) => p.index);

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

console.log('\npopulations check');

// --- Case 1: plottable star count ------------------------------------------

console.log('\n1. plottableStars on the real catalogue');
check(
  'around 4,887 plottable stars',
  Math.abs(points.length - 4887) < 50,
  `${points.length} points`,
);
check(
  'no point has a zero distance',
  points.every((p) => catalog.distanceLy[p.index] !== 0),
);
check(
  'no point has a zero colour index',
  points.every((p) => catalog.colorIndex[p.index] !== 0),
);

// --- Case 2: known absolute magnitudes -------------------------------------

console.log('\n2. absolute magnitude of known stars (from this catalogue\'s distances)');

const PARSECS_PER_LY = 3.261563777;

function absMag(appMag: number, distLy: number): number {
  return appMag - 5 * Math.log10(distLy / PARSECS_PER_LY) + 5;
}

/*
 * Vega has B-V = 0.00, which is a real measurement (it is an A0 standard),
 * but the catalogue stores zero for both "missing data" and this genuine value.
 * Because plottableStars excludes ci = 0 to avoid fabricated inputs, Vega does
 * not appear in the clusterable set. Case 2 checks the absolute magnitude
 * formula only, so it reads directly from the raw catalogue rather than from
 * plottableStars. The formula is what is under test here, not whether Vega
 * happens to be clusterable.
 */
const nameIdx = file.fields.indexOf('proper');

function starAbsMag(name: string): number | null {
  const row = file.stars.find((s) => s[nameIdx] === name);
  if (!row) return null;
  const appMag = row[iMag] as number;
  const distLy = row[iDist] as number;
  if (distLy === 0) return null;
  return absMag(appMag, distLy);
}

for (const [name, expected] of [
  ['Sirius', 1.45],
  ['Betelgeuse', -5.47],
  ['Vega', 0.61],
] as [string, number][]) {
  const got = starAbsMag(name);
  if (got === null) {
    check(`${name} has a usable distance in the catalogue`, false, 'not found or zero distance');
    continue;
  }
  check(
    `${name} absolute magnitude within 0.1 of ${expected}`,
    Math.abs(got - expected) < 0.1,
    `got ${got.toFixed(2)}`,
  );
}

// --- Case 3: deterministic output ------------------------------------------

console.log('\n3. findPopulations is deterministic');

const second = findPopulations(points);
const identical =
  populations.length === second.length &&
  populations.every((p, i) => {
    const q = second[i];
    return (
      p.id === q.id &&
      p.name === q.name &&
      Math.abs(p.centroid.colorIndex - q.centroid.colorIndex) < 1e-12 &&
      Math.abs(p.centroid.absoluteMagnitude - q.centroid.absoluteMagnitude) < 1e-12 &&
      p.members.length === q.members.length &&
      p.members.every((m, j) => m === q.members[j])
    );
  });

check('two runs produce identical output', identical);

// --- Case 4: cluster sizes -------------------------------------------------

console.log('\n4. cluster sizes');

const totalPoints = points.length;
for (const pop of populations) {
  const frac = pop.members.length / totalPoints;
  check(
    `"${pop.name}" holds at least 5% of points`,
    frac >= 0.05,
    `${pop.members.length} members (${(frac * 100).toFixed(1)}%)`,
  );
}

// --- Cases 5 and 6: compositional checks -----------------------------------

console.log('\n5. coolest, most luminous cluster is dominated by giants');

// The coolest, most luminous cluster has the highest colour index and lowest
// (most negative) absolute magnitude centroid.
const coolLuminous = populations.reduce((best, pop) =>
  pop.centroid.colorIndex > best.centroid.colorIndex &&
  pop.centroid.absoluteMagnitude < best.centroid.absoluteMagnitude
    ? pop
    : best,
);

const giantCount = coolLuminous.members.filter((i) => {
  const lc = classOf.get(i);
  return lc ? isGiantOrSuperGiant(lc) : false;
}).length;
const mseqCountInCoolLuminous = coolLuminous.members.filter((i) => classOf.get(i) === 'V').length;
const classifiedInCoolLuminous = coolLuminous.members.filter((i) => classOf.has(i)).length;

check(
  'coolest/most luminous cluster has majority giants/supergiants (not V)',
  giantCount > mseqCountInCoolLuminous,
  `${giantCount} giants vs ${mseqCountInCoolLuminous} main sequence (of ${classifiedInCoolLuminous} classified)`,
);

console.log('\n6. faintest centroid cluster has higher proportion of main sequence (V)');

// The cluster with the faintest (most positive) absolute magnitude centroid.
const faintest = populations.reduce((best, pop) =>
  pop.centroid.absoluteMagnitude > best.centroid.absoluteMagnitude ? pop : best,
);

const vInFaintest = faintest.members.filter((i) => classOf.get(i) === 'V').length;
const classifiedInFaintest = faintest.members.filter((i) => classOf.has(i)).length;
const vFracFaintest = classifiedInFaintest > 0 ? vInFaintest / classifiedInFaintest : 0;

// Compare V fractions: the faintest cluster (ordinary stars) should have many
// more main-sequence members than the cool-luminous (giant) cluster does.
const vInCoolLuminous = coolLuminous.members.filter((i) => classOf.get(i) === 'V').length;
const vFracInCoolLuminous =
  classifiedInCoolLuminous > 0 ? vInCoolLuminous / classifiedInCoolLuminous : 0;

check(
  'faintest cluster has substantially more V than the giant cluster',
  vFracFaintest > vFracInCoolLuminous + 0.2,
  `faintest ${(vFracFaintest * 100).toFixed(1)}% V vs giant cluster ${(vFracInCoolLuminous * 100).toFixed(1)}% V`,
);

// --- Case 7: overall agreement ---------------------------------------------

console.log('\n7. overall agreement with luminosity classes');

printConfusion(populations, classOf);

const agreement = agreementRate(populations, classOf);
check(
  'overall agreement above 60%',
  agreement > 0.6,
  `${(agreement * 100).toFixed(1)}%`,
);

/*
 * Every group has its own name.
 *
 * k distinct clusters given the same label is always a bug, and it happened:
 * the first naming rule called anything above M = -1 a giant whatever its
 * colour, which put "Giants and supergiants" on both the cool luminous cluster
 * and a blue one holding 660 main sequence stars. The dossier would have told
 * somebody their hot main sequence star was a giant, in a confident voice,
 * under a heading.
 *
 * None of the other cases caught it. Cases 5 and 6 pick their clusters by
 * centroid position rather than by name, and case 7 scores against each
 * cluster's own majority class, so a wrong label is invisible to all three. A
 * name is the only part of this a person ever reads, and it was the only part
 * nothing checked.
 */
console.log('');
console.log('9. every population is named, and named distinctly');
const names = populations.map((p) => p.name);
check('no two clusters share a name', new Set(names).size === names.length, names.join(' | '));
check(
  'and none is empty or a placeholder',
  names.every((n) => n.trim().length > 3),
  names.join(' | '),
);

// --- Case 8: shuffled-label baseline ---------------------------------------

console.log('\n8. same clustering on shuffled luminosity classes collapses to near chance');

/*
 * Take the classes assigned to the plottable stars, shuffle them at random
 * among those same stars, then measure agreement with the unchanged clusters.
 * A shuffle keeps the class distribution exactly intact: the same number of
 * giants, dwarfs and supergiants, just attached to different stars.
 *
 * If agreement stays high after the shuffle, the metric was picking up the
 * distribution shape rather than any real correspondence, and case 7 was never
 * evidence of anything. Only by running both can you tell which you have.
 */
const classesForPlottable: Array<string | null> = plottableIndices.map(
  (i) => classOf.get(i) ?? null,
);
const shuffledClasses = shuffledCopy(classesForPlottable, 0xdeadbeef);

const shuffledClassOf = new Map<number, string>();
for (let i = 0; i < plottableIndices.length; i++) {
  const lc = shuffledClasses[i];
  if (lc) shuffledClassOf.set(plottableIndices[i], lc);
}

const shuffledAgreement = agreementRate(populations, shuffledClassOf);
check(
  'shuffled agreement is substantially lower than real agreement',
  shuffledAgreement < agreement - 0.1,
  `shuffled ${(shuffledAgreement * 100).toFixed(1)}% vs real ${(agreement * 100).toFixed(1)}%`,
);
/*
 * What chance actually is here, rather than what it feels like it should be.
 *
 * The brief guessed a third, on the reasoning that three clusters means one in
 * three. That is wrong for this metric. Agreement scores a star when the
 * majority class of its cluster equals its own class, and once the labels are
 * shuffled every cluster's majority becomes whichever class is commonest
 * overall. So the floor is not 1/k, it is the frequency of the single most
 * common luminosity class, which in a naked-eye sample is III at about 47%.
 *
 * Asserting "below 50%" was therefore asserting almost nothing: the floor sits
 * at 47% and could not have gone much above it. The real claim is the distance
 * between the two numbers, and it is worth printing the floor next to them so
 * that 70% is read against 47% rather than against zero.
 */
const commonest = Math.max(
  ...[...new Set(classesForPlottable.filter(Boolean))].map(
    (lc) => classesForPlottable.filter((x) => x === lc).length,
  ),
);
const floor = commonest / classesForPlottable.filter(Boolean).length;

console.log(
  `  chance floor for this metric: ${(floor * 100).toFixed(1)}% (the commonest class)`,
);
check(
  'shuffling lands on the floor, so the metric is measuring correspondence',
  Math.abs(shuffledAgreement - floor) < 0.05,
  `shuffled ${(shuffledAgreement * 100).toFixed(1)}% against a floor of ${(floor * 100).toFixed(1)}%`,
);
check(
  'and the real clustering clears that floor by a wide margin',
  agreement - floor > 0.15,
  `${((agreement - floor) * 100).toFixed(1)} points above chance`,
);

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

console.log('');
if (failures.length) {
  console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('PASS  clustering finds real structure in the HR diagram');
