/**
 * Finding the passage that answers a question.
 *
 * The corpus is NASA's own writing, cut into passages and embedded at build
 * time by scripts/build-corpus.mjs. This is the reading half: it embeds the
 * question through the one endpoint that needs a model, then compares it
 * against every passage here in the browser.
 *
 * A hundred and twenty passages is a hundred and twenty dot products, so there
 * is no index and no approximate search. Both would be machinery standing in
 * for arithmetic that takes under a millisecond, and an exact answer is easier
 * to be sure of than a fast one.
 *
 * THE REFUSAL
 *
 * Vectors from different models are not comparable. Nothing about mixing them
 * looks wrong: the arithmetic runs, the numbers come out between minus one and
 * one, and the passages that come back are noise wearing the shape of an
 * answer. It is the worst failure available to this file, because it produces
 * confident citations for the wrong thing, so it is the one thing checked
 * explicitly. If the corpus was built by a model other than the one embedding
 * the question, this retrieves nothing and says why. There is no degraded mode.
 */

export interface Passage {
  topic: string;
  title: string;
  /** The NASA page it was taken from, kept so an answer can cite it. */
  source: string;
  text: string;
}

interface StoredPassage extends Passage {
  vector: number[];
}

interface Corpus {
  embeddingModel: string;
  dimensions: number;
  retrievedAt: string;
  licence: string;
  passages: StoredPassage[];
}

export interface Retrieved extends Passage {
  /** Cosine similarity, both vectors being unit length. */
  score: number;
}

/** Held once for the life of the page, like the star catalogue. */
let corpusPromise: Promise<Corpus | null> | null = null;

function loadCorpus(): Promise<Corpus | null> {
  if (!corpusPromise) {
    corpusPromise = fetch('data/corpus.json')
      .then((res) => (res.ok ? (res.json() as Promise<Corpus>) : null))
      .catch(() => null);
  }
  return corpusPromise;
}

/**
 * Every passage filed under a topic, in the order the corpus stores them.
 *
 * Used by the fun facts, which do not search: they already know what the
 * subject is, because somebody just tapped it.
 */
export async function passagesAbout(topic: string): Promise<Passage[]> {
  const corpus = await loadCorpus();
  if (!corpus?.passages?.length) return [];
  const wanted = topic.toLowerCase().replace(/^the\s+/, '').trim();
  return corpus.passages
    .filter((p) => p.topic.toLowerCase() === wanted)
    .map(({ topic: t, title, source, text }) => ({ topic: t, title, source, text }));
}

/**
 * Below this, the nearest passage is not about the question.
 *
 * Retrieval always returns something: there is always a closest vector, even
 * when nothing in the corpus is relevant. Handing the model its best guess
 * about Neptune's winds in answer to a question about magnitude is how RAG
 * produces a confident citation for the wrong thing, so a floor is the
 * difference between "here is the passage" and "here is the least unrelated
 * passage I have".
 *
 * Set from the corpus rather than from taste. scripts/verify/corpus.check.ts
 * measures both groups: real questions land between 0.76 and 0.89, and the
 * closest a deliberately unrelated question got was 0.54. The first draft of
 * this number was 0.55, which is a hundredth above that and therefore a coin
 * toss wearing a rule's clothing. It sits in the middle of the gap now, which
 * is the only place a threshold can sit and mean anything.
 */
const MIN_SCORE = 0.65;

export interface Retrieval {
  passages: Retrieved[];
  /** Present when nothing could be retrieved, and worth saying out loud. */
  note?: string;
}

export async function retrieve(question: string, limit = 3): Promise<Retrieval> {
  const corpus = await loadCorpus();
  if (!corpus?.passages?.length) return { passages: [], note: 'no corpus is available' };

  let queryVector: number[];
  let queryModel: string;
  try {
    const res = await fetch('api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: [question] }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { passages: [], note: 'the question could not be embedded' };
    const json = (await res.json()) as { model?: string; vectors?: number[][] };
    if (!json.vectors?.[0]) return { passages: [], note: 'the embedder returned nothing' };
    queryVector = json.vectors[0];
    queryModel = json.model ?? 'unknown';
  } catch {
    return { passages: [], note: 'the embedder could not be reached' };
  }

  if (queryModel !== corpus.embeddingModel) {
    return {
      passages: [],
      note: `the corpus was built with ${corpus.embeddingModel} and this question was embedded with ${queryModel}, so they cannot be compared`,
    };
  }

  if (queryVector.length !== corpus.dimensions) {
    return { passages: [], note: 'the question and the corpus have different dimensions' };
  }

  const scored: Retrieved[] = corpus.passages.map((passage) => ({
    topic: passage.topic,
    title: passage.title,
    source: passage.source,
    text: passage.text,
    score: dot(queryVector, passage.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  const kept = scored.filter((p) => p.score >= MIN_SCORE).slice(0, limit);

  return kept.length
    ? { passages: kept }
    : { passages: [], note: 'nothing in the corpus is close enough to this question' };
}

/** Both vectors are unit length, so this is the cosine. */
function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
