/**
 * Retrieval, measured rather than assumed.
 *
 * Two things can go wrong with a corpus lookup and neither of them raises an
 * error. It can return the wrong passage, and it can return a passage when the
 * honest answer is that it has nothing. Both produce a confident citation for
 * something the source never said, which is worse than no citation at all,
 * because a citation is the thing that makes an answer look checkable.
 *
 * So this asks real questions and nonsense questions and prints where each one
 * lands. The real ones have to find the passage about the thing they asked
 * about. The nonsense ones have to fall below the floor the reader uses, and
 * the gap between the two groups is the evidence that the floor is a
 * measurement and not a preference.
 *
 * The question is embedded by whichever model the corpus says built it. That
 * is the whole discipline of this file in one line: vectors from two models
 * compare fine and mean nothing.
 *
 * Run: npx tsx scripts/verify/corpus.check.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

interface Corpus {
  embeddingModel: string;
  dimensions: number;
  retrievedAt: string;
  passages: { topic: string; title: string; source: string; text: string; vector: number[] }[];
}

/** The floor src/lib/corpus.ts applies. Kept in step by being asserted below. */
const MIN_SCORE = 0.65;

/** Questions somebody would actually type, and the topic that should answer them. */
const REAL: { question: string; topic: string }[] = [
  { question: 'Why is Mars red?', topic: 'Mars' },
  { question: 'Why does the Moon change shape?', topic: 'Moon' },
  { question: 'What are Saturn’s rings made of?', topic: 'Saturn' },
  { question: 'How hot is the surface of Venus?', topic: 'Venus' },
  { question: 'What is the Great Red Spot?', topic: 'Jupiter' },
  { question: 'How far away is the Sun?', topic: 'Sun' },
];

/** Nothing in a corpus of NASA astronomy writing should answer these. */
const NONSENSE = [
  'How do I refinance a mortgage?',
  'What is the best way to poach an egg?',
  'Write me a bash script that renames files',
];

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function normalise(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum) || 1;
  return vector.map((v) => Math.round((v / length) * 10000) / 10000);
}

/**
 * Embeds through the model the corpus names, or explains why it cannot.
 *
 * Only the local path is implemented here. A check that spends hosted quota
 * every time it runs is a check people stop running, and the thing being
 * tested is the retrieval arithmetic rather than any particular embedder.
 */
async function embedWith(model: string, texts: string[]): Promise<number[][]> {
  if (!model.startsWith('ollama:')) {
    throw new Error(
      `This corpus was built with ${model}. Rebuild it locally to check retrieval: node scripts/build-corpus.mjs`,
    );
  }
  const name = model.slice('ollama:'.length);
  const base = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');

  const res = await fetch(`${base}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: name, input: texts }),
  });
  if (!res.ok) throw new Error(`ollama embeddings responded ${res.status}`);
  const json = (await res.json()) as { embeddings?: number[][]; error?: string };
  if (json.error) throw new Error(json.error);
  return (json.embeddings ?? []).map(normalise);
}

function best(corpus: Corpus, vector: number[]) {
  let top = { topic: '', title: '', score: -1 };
  for (const passage of corpus.passages) {
    const score = dot(vector, passage.vector);
    if (score > top.score) top = { topic: passage.topic, title: passage.title, score };
  }
  return top;
}

async function main() {
  const path = fileURLToPath(new URL('../../public/data/corpus.json', import.meta.url));
  const corpus = JSON.parse(readFileSync(path, 'utf8')) as Corpus;

  console.log(`\ncorpus    ${corpus.passages.length} passages, ${corpus.dimensions}d`);
  console.log(`built by  ${corpus.embeddingModel}`);
  console.log(`retrieved ${corpus.retrievedAt.slice(0, 10)}`);

  console.log('\nwhat is in it');
  check('it is not empty', corpus.passages.length >= 40, `${corpus.passages.length} passages`);
  check(
    'every passage records where it came from',
    corpus.passages.every((p) => /^https?:\/\//.test(p.source) && p.text.length > 100),
  );
  check(
    'every source is NASA, so every passage is public domain',
    corpus.passages.every((p) => /(^|\.)nasa\.gov\//.test(p.source)),
    [...new Set(corpus.passages.map((p) => new URL(p.source).hostname))].join(', '),
  );
  check(
    'every vector is unit length and the right size',
    corpus.passages.every(
      (p) => p.vector.length === corpus.dimensions && Math.abs(dot(p.vector, p.vector) - 1) < 0.01,
    ),
  );

  const queries = [...REAL.map((r) => r.question), ...NONSENSE];
  const vectors = await embedWith(corpus.embeddingModel, queries);

  console.log('\nquestions somebody would ask');
  const realScores: number[] = [];
  REAL.forEach((item, i) => {
    const top = best(corpus, vectors[i]);
    realScores.push(top.score);
    check(
      `"${item.question}" finds ${item.topic}`,
      top.topic === item.topic && top.score >= MIN_SCORE,
      `${top.topic} at ${top.score.toFixed(2)}`,
    );
  });

  console.log('\nquestions it has no business answering');
  const nonsenseScores: number[] = [];
  NONSENSE.forEach((question, i) => {
    const top = best(corpus, vectors[REAL.length + i]);
    nonsenseScores.push(top.score);
    check(
      `"${question}" retrieves nothing`,
      top.score < MIN_SCORE,
      `nearest was ${top.topic} at ${top.score.toFixed(2)}`,
    );
  });

  /*
   * The gap is the point.
   *
   * A floor only means something if the two groups are actually separated by
   * it. If the worst real question and the best piece of nonsense sat a
   * hundredth apart, the threshold would be a coin toss dressed as a rule, and
   * this would be the check that said so.
   */
  const worstReal = Math.min(...realScores);
  const bestNonsense = Math.max(...nonsenseScores);
  console.log('');
  check(
    'the floor sits in a real gap, not between two neighbours',
    worstReal - bestNonsense > 0.1,
    `worst real ${worstReal.toFixed(2)}, best nonsense ${bestNonsense.toFixed(2)}, floor ${MIN_SCORE}`,
  );

  console.log('');
  if (failures.length) {
    console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('PASS  the corpus answers what it knows and declines what it does not');
}

main().catch((err) => {
  console.error('corpus check failed to run:', err.message ?? err);
  process.exit(1);
});
