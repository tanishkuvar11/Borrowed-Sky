/**
 * The fun facts, read the way a person would read them.
 *
 * These are the least defended text in the app. They are short, they are
 * confident, they appear without being asked for, and nobody ever checks a fun
 * fact. That combination is exactly why they are lifted whole out of NASA's
 * writing instead of being generated, and it is why this file reads every one
 * of them rather than sampling a few.
 *
 * What can go wrong is not that a sentence is false, because NASA wrote it. It
 * is that a sentence which made sense inside a paragraph stops making sense
 * once it is alone: a pronoun with nothing to point at, a "however" answering
 * an argument the reader never saw, half a sentence ending in a comma. Every
 * case below is a way of asking whether a sentence can survive being taken out
 * of its paragraph.
 *
 * Run: npx tsx scripts/verify/facts.check.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

interface StoredPassage {
  topic: string;
  title: string;
  source: string;
  text: string;
}

/** Every object the app can show a sheet for, and the topic it is filed under. */
const SUBJECTS = [
  'sun',
  'moon',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'stars',
  'space station',
];

async function main() {
  const { _internals } = await import('../../src/lib/facts.ts');
  const path = fileURLToPath(new URL('../../public/data/corpus.json', import.meta.url));
  const corpus = JSON.parse(readFileSync(path, 'utf8')) as { passages: StoredPassage[] };

  console.log('\nfacts available per subject');
  const everyFact: { topic: string; text: string; source: string }[] = [];

  for (const topic of SUBJECTS) {
    const passages = corpus.passages.filter((p) => p.topic.toLowerCase() === topic);
    const facts = _internals.collect(passages);
    for (const fact of facts) everyFact.push({ topic, text: fact.text, source: fact.source });

    /*
     * Three is the floor because the sheet invites a second tap in as many
     * words. An object with one fact makes that invitation a lie, and an object
     * with none leaves a labelled panel with nothing under it.
     */
    check(`${topic} has facts to rotate through`, facts.length >= 3, `${facts.length}`);
  }

  console.log(`\nreading all ${everyFact.length} of them`);

  const dangling = everyFact.filter((f) =>
    /^(it|its|they|their|this|these|those|that|he|she|there|however|but|and|so|then|also|yet|still|instead|meanwhile|therefore|thus|in addition|furthermore|moreover|for one thing|on the other hand|as a result|of course|in fact|for example|for instance)\b/i.test(
      f.text,
    ),
  );
  check(
    'none of them starts by pointing at a sentence that is not there',
    dangling.length === 0,
    dangling[0]?.text.slice(0, 90) ?? '',
  );

  const unfinished = everyFact.filter((f) => !/[.!?]$/.test(f.text));
  check(
    'none of them is half a sentence',
    unfinished.length === 0,
    unfinished[0]?.text.slice(-60) ?? '',
  );

  const wrongLength = everyFact.filter((f) => f.text.length < 60 || f.text.length > 230);
  check('none is too short to say anything or too long to read', wrongLength.length === 0);

  const unsourced = everyFact.filter((f) => !/(^|\.)nasa\.gov\//.test(f.source));
  check(
    'every one can be traced back to a NASA page',
    unsourced.length === 0,
    unsourced[0]?.source ?? '',
  );

  /*
   * Balance is worth checking on its own. Sorting by how interesting a sentence
   * looks is a preference, not a filter, and a scoring bug that quietly
   * promoted one page's sentences above every other would show up here as a
   * subject whose facts all came from the same URL.
   */
  console.log('');
  const lopsided = SUBJECTS.filter((topic) => {
    const mine = everyFact.filter((f) => f.topic === topic);
    if (mine.length < 8) return false;
    const sources = new Set(mine.slice(0, 8).map((f) => f.source));
    return sources.size < 2 && new Set(mine.map((f) => f.source)).size > 1;
  });
  check(
    'no subject draws its first handful from one page when it has more',
    lopsided.length === 0,
    lopsided.join(', '),
  );

  console.log('\na sample, as somebody would meet them');
  for (const topic of ['venus', 'saturn', 'space station']) {
    const mine = everyFact.filter((f) => f.topic === topic);
    console.log(`  ${topic}: ${mine[0]?.text.slice(0, 96) ?? '(none)'}…`);
  }

  console.log('');
  if (failures.length) {
    console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log(`PASS  ${everyFact.length} facts, every one of them able to stand on its own`);
}

main().catch((err) => {
  console.error('facts check failed to run:', err.message ?? err);
  process.exit(1);
});
