/**
 * One true thing about whatever you just tapped.
 *
 * Every fact here is a sentence NASA wrote, lifted whole out of the corpus and
 * shown with the page it came from. None of it is generated, which is the
 * point: a fun fact is exactly the kind of small confident claim a language
 * model invents most easily and nobody ever checks, and this app is an argument
 * against exactly that.
 *
 * That also means these work with no model, no key and no network. The corpus
 * is already on the machine.
 *
 * PICKING ONE
 *
 * A sentence out of the middle of a paragraph often cannot stand up on its own:
 * "It is the hottest planet in the solar system" is true and useless without
 * the sentence before it. So candidates are filtered for whether they carry
 * their own subject, and preferred when they carry something concrete, because
 * a fact with a number in it is the kind somebody repeats.
 *
 * And they rotate. Tapping Venus twice and reading the same sentence is the
 * moment an app stops feeling like it knows anything.
 */

import { passagesAbout, type Passage } from './corpus';

export interface Fact {
  text: string;
  /** The NASA page the sentence came from, so the claim is checkable. */
  source: string;
  title: string;
}

/**
 * Sentences that cannot stand alone.
 *
 * Two ways a lifted sentence reaches backwards for something the reader cannot
 * see. A pronoun points at a subject named in the sentence before it, and a
 * connective points at an argument that was being made before it: "It is the
 * hottest planet" and "However, in 50 million years Phobos will break apart"
 * are both true and both read as the answer to a question nobody asked.
 */
const DANGLING =
  /^(it|its|they|their|this|these|those|that|he|she|there|such|both|each|one|however|but|and|so|then|also|yet|still|instead|meanwhile|otherwise|therefore|thus|besides|in addition|furthermore|moreover|for one thing|on the other hand|as a result|that said|even so|of course|in fact|for example|for instance)\b/i;

/** Sentences that are about the document rather than about the sky. */
const HOUSEKEEPING = /(click|scroll|read more|learn more|watch|subscribe|newsletter|credit:|image:|caption|this page|website|browser)/i;

function sentencesIn(text: string): string[] {
  return (
    text
      // Split on sentence enders, keeping abbreviations and decimals intact by
      // requiring a space and a capital after the stop.
      .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
      .map((s) => s.trim())
  );
}

/** True when a sentence can be shown on its own without confusing anybody. */
function standsAlone(sentence: string): boolean {
  if (sentence.length < 60 || sentence.length > 230) return false;
  if (!/[.!?]$/.test(sentence)) return false;
  if (DANGLING.test(sentence)) return false;
  if (HOUSEKEEPING.test(sentence)) return false;
  // A sentence that is mostly punctuation or a list of links is not a fact.
  if ((sentence.match(/[,;:]/g)?.length ?? 0) > 6) return false;
  return true;
}

/**
 * How interesting a sentence is, roughly.
 *
 * Numbers and superlatives are what make a fact repeatable. This is a
 * preference and not a filter: everything that survives standsAlone is true and
 * worth showing, and this only decides what gets shown first.
 */
function interest(sentence: string): number {
  let score = 0;
  if (/\d/.test(sentence)) score += 2;
  if (/\b(largest|smallest|hottest|coldest|fastest|slowest|only|first|most|brightest|closest|farthest)\b/i.test(sentence)) score += 2;
  if (/\b(would|could|enough to|about the size|times)\b/i.test(sentence)) score += 1;
  return score;
}

/** What the corpus files each object under. Anything absent has no facts. */
function topicFor(name: string, kind: string): string | null {
  const key = name.toLowerCase().replace(/^the\s+/, '').trim();
  const known = ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
  if (known.includes(key)) return key;
  if (kind === 'star') return 'stars';
  if (kind === 'satellite') return 'space station';
  return null;
}

/**
 * Which fact each object is up to, so a second tap is a second fact.
 *
 * Held for the life of the page rather than stored, because the point is
 * variety within one evening outside and not a reading history.
 */
const seen = new Map<string, number>();

export async function funFactFor(name: string, kind: string): Promise<Fact | null> {
  const topic = topicFor(name, kind);
  if (!topic) return null;

  const passages = await passagesAbout(topic);
  if (!passages.length) return null;

  const candidates = collect(passages);
  if (!candidates.length) return null;

  const next = (seen.get(topic) ?? -1) + 1;
  seen.set(topic, next);
  return candidates[next % candidates.length];
}

/** Every usable sentence about a topic, best first. */
function collect(passages: Passage[]): Fact[] {
  const facts: Fact[] = [];
  const already = new Set<string>();

  for (const passage of passages) {
    for (const sentence of sentencesIn(passage.text)) {
      if (!standsAlone(sentence)) continue;
      if (already.has(sentence)) continue;
      already.add(sentence);
      facts.push({ text: sentence, source: passage.source, title: passage.title });
    }
  }

  return facts.sort((a, b) => interest(b.text) - interest(a.text));
}

/** Exported for scripts/verify/facts.check.ts, which reads what this produces. */
export const _internals = { sentencesIn, standsAlone, interest, collect };
