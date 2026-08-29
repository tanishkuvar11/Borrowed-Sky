/**
 * The first line of an object's panel: what the thing is.
 *
 * The panel used to open with a position, so tapping an unfamiliar point of
 * light told you where MSAT-2 was without ever saying what MSAT-2 is. This
 * checks the sentence that now comes first, and mostly it checks the two
 * places that sentence could quietly say something untrue: a spectral type
 * read wrongly, and a satellite given a purpose nobody knows it has.
 *
 * Run: npx tsx scripts/verify/identity.check.ts
 */

import { identityLine } from '../../src/components/ObjectSheet.tsx';
import type { SkyBody } from '../../src/lib/astro/types.ts';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

function body(over: Partial<SkyBody>): SkyBody {
  return {
    id: 'x',
    kind: 'star',
    name: 'Test',
    altitude: 40,
    azimuth: 180,
    magnitude: 2,
    ...over,
  } as SkyBody;
}

console.log('\nthe Solar System, from the facts the app already had');
for (const [name, want] of [
  ['Saturn', 'ringed'],
  ['Mars', 'rusty'],
  ['Moon', 'natural satellite'],
  ['Sun', 'Never look at it'],
] as [string, string][]) {
  const line = identityLine(body({ kind: name === 'Moon' ? 'moon' : name === 'Sun' ? 'sun' : 'planet', name }));
  check(`${name} says what it is`, !!line && line.includes(want), line ?? '(none)');
}

console.log('\nstars, from the spectral type');
{
  const sirius = identityLine(
    body({ name: 'Sirius', spectralType: 'A1V', constellation: 'Canis Major', distance: { value: 8.6, unit: 'ly' } }),
  );
  check('a main sequence star is not called a giant', !!sirius && !/giant/.test(sirius), sirius ?? '');
  check('  and its colour comes from the class', !!sirius && sirius.includes('white'), sirius ?? '');
  check('  and it names the constellation', !!sirius && sirius.includes('Canis Major'));
  check('  and the distance is in light years', !!sirius && sirius.includes('9 light years'), sirius ?? '');

  const antares = identityLine(body({ name: 'Antares', spectralType: 'M1.5Iab', constellation: 'Scorpius' }));
  check('a supergiant is called a supergiant', !!antares && /supergiant/.test(antares), antares ?? '');

  const arcturus = identityLine(body({ name: 'Arcturus', spectralType: 'K0III', constellation: 'Bootes' }));
  check('a giant is called a giant, not a supergiant', !!arcturus && /\bgiant/.test(arcturus) && !/supergiant/.test(arcturus), arcturus ?? '');
  check('  and the article agrees with the colour', !!arcturus && arcturus.startsWith('An orange'), arcturus ?? '');

  const rigel = identityLine(body({ name: 'Rigel', spectralType: 'B8Ia', constellation: 'Orion' }));
  check('Ia is a supergiant too', !!rigel && /supergiant/.test(rigel), rigel ?? '');

  const subgiant = identityLine(body({ name: 'Procyon', spectralType: 'F5IV-V', constellation: 'Canis Minor' }));
  check('a subgiant is not promoted to giant', !!subgiant && !/giant/.test(subgiant), subgiant ?? '');

  /*
   * The one that matters most. A star with no spectral type in the catalogue
   * must still be described as a star, and must not be given a colour that
   * nothing supports.
   */
  const bare = identityLine(body({ name: 'Unnamed', spectralType: undefined }));
  check('an unclassified star is still called a star', !!bare && bare.startsWith('A star'), bare ?? '');
  check('  and is given no colour it cannot support', !!bare && !/blue|white|yellow|orange|red/.test(bare), bare ?? '');
}

console.log('\nsatellites, including the ones nobody has heard of');
{
  const iss = identityLine(body({ kind: 'satellite', name: 'ISS (ZARYA)', heightKm: 420 }));
  check('the station is named as the station', !!iss && /International Space Station/.test(iss), iss ?? '');
  check('  and says people are aboard', !!iss && /people living aboard/.test(iss));

  const msat = identityLine(body({ kind: 'satellite', name: 'MSAT-2', heightKm: 782 }));
  check('an unknown satellite is called a satellite', !!msat && /satellite in orbit/.test(msat), msat ?? '');
  check('  and is given no purpose it may not have', !!msat && !/communications|weather|spy|navigation/.test(msat));
  check('  and carries its height', !!msat && msat.includes('782 km'), msat ?? '');

  const noHeight = identityLine(body({ kind: 'satellite', name: 'MSAT-2' }));
  check('and reads as a sentence with no height known', !!noHeight && noHeight.endsWith('people.'), noHeight ?? '');
}

console.log('');
if (failures.length) {
  console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('PASS  every object says what it is before it says where it is');
