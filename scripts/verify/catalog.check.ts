/**
 * The shipped star catalogue, checked against astrophysics rather than against
 * the script that produced it.
 *
 * This file exists because of a bug that survived for months in a repository
 * whose one rule is that nothing is invented. The build script trimmed each
 * spectral class to three characters to save bytes, and three quarters of the
 * catalogue came out the other side saying something else: G8III is a giant,
 * G8I is a supergiant, and the app printed the result in the dossier under the
 * word "Spectrum" as though it were the measurement.
 *
 * The reason it survived is the reason this check is worth having. A truncation
 * that produced obvious rubbish would have been spotted the first time anybody
 * looked at a star. This one produced another valid classification, so it read
 * as data, and nothing in the app was in a position to disagree with it.
 *
 * So the assertions below are about what the sky is actually like, not about
 * what the parser did. A naked-eye catalogue that claims three thousand
 * supergiants is wrong however cleanly it parses.
 *
 * Run: npx tsx scripts/verify/catalog.check.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

interface StarsFile {
  count: number;
  fields: string[];
  stars: (string | number)[][];
}

const path = fileURLToPath(new URL('../../public/data/stars.json', import.meta.url));
const file = JSON.parse(readFileSync(path, 'utf8')) as StarsFile;

const iName = file.fields.indexOf('proper');
const iSpect = file.fields.indexOf('spect');
const iMag = file.fields.indexOf('mag');

/** The luminosity class, if the string carries one. */
function luminosity(spect: string): string | null {
  const withoutType = spect.replace(/^[a-zA-Z]{0,2}[OBAFGKMWSCR][0-9.]*/, '');
  const match = /(VII|VI|IV|III|II|Iab|Ia|Ib|V|I)/.exec(withoutType);
  return match ? match[1] : null;
}

console.log(`\ncatalogue  ${file.count} stars to magnitude 6`);

/*
 * Six stars anybody can check in a reference book, chosen to span the classes
 * that the truncation confused: two supergiants, two giants, one main sequence
 * star and one peculiar. If slicing ever comes back, Aldebaran turns from a
 * giant into a supergiant here and this line goes red.
 */
console.log('\nstars whose classification is not in question');
const known: [string, string][] = [
  ['Betelgeuse', 'M2Ib'],
  ['Rigel', 'B8Ia'],
  ['Aldebaran', 'K5III'],
  ['Arcturus', 'K2IIIp'],
  ['Vega', 'A0Vvar'],
  ['Spica', 'B1V'],
];

for (const [name, expected] of known) {
  const star = file.stars.find((s) => s[iName] === name);
  const actual = star ? String(star[iSpect]) : '(not in the catalogue)';
  check(`${name} is ${expected}`, actual === expected, actual);
}

console.log('\nand the population as a whole');
const classes = new Map<string, number>();
let withClass = 0;
for (const star of file.stars) {
  const lum = luminosity(String(star[iSpect] ?? ''));
  if (!lum) continue;
  withClass++;
  classes.set(lum, (classes.get(lum) ?? 0) + 1);
}

const giants = classes.get('III') ?? 0;
const dwarfs = classes.get('V') ?? 0;
const supergiants = (classes.get('I') ?? 0) + (classes.get('Ia') ?? 0) + (classes.get('Ib') ?? 0);

check('most stars carry a luminosity class at all', withClass > file.count * 0.8, `${withClass}`);

/*
 * A magnitude-limited sample of the naked-eye sky is dominated by giants, for
 * the plain reason that they are visible from much further away than dwarfs
 * are. Supergiants are genuinely rare: there are a few dozen naked-eye ones,
 * not thousands. The truncated catalogue reported 2906, which is the assertion
 * that would have caught this on day one.
 */
check(
  'giants outnumber main sequence stars, as they do in any naked-eye sample',
  giants > dwarfs,
  `${giants} III against ${dwarfs} V`,
);
check(
  'supergiants are rare rather than a third of the sky',
  supergiants < file.count * 0.1,
  `${supergiants} of ${file.count}`,
);

console.log('');
if (failures.length) {
  console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('PASS  the catalogue says what the sky says');
