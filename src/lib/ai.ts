/**
 * The narration layer.
 *
 * Two things matter here. First, the model is handed a finished description of
 * the sky and is never asked to work out where anything is; that job belongs
 * to astronomy-engine and SGP4. Second, when watsonx is unreachable or simply
 * not configured, the app does not go quiet and does not start guessing: it
 * falls back to a deterministic narrator that assembles sentences from the same
 * computed numbers. The interface always says which of the two spoke.
 */

import { compassPoint, heightInWords, SATELLITE_FACTS } from './astro/satellites';
import { BODY_FACTS } from './astro/solar';
import { skyQualityInput } from './astro/solar';
import { skyQuality } from './astro/skyquality';
import type { ObserverSite, SkyBody, SkyConditions } from './astro/types';
import type { SkyToolset } from './astro/tools';
import type { Passage } from './corpus';
import type { TonightTimeline } from './astro/events';

export type Tone = 'simple' | 'standard';
export type NarrationSource = 'granite' | 'local';

export interface GuideAnswer {
  text: string;
  source: NarrationSource;
  model?: string;
  /** Present when Granite was tried and could not answer. */
  note?: string;
  /**
   * The NASA passages the answer was allowed to explain from.
   *
   * Shown under the answer, because an explanation with a source is a
   * different kind of statement from one without, and this app's whole
   * argument is that the difference should be visible.
   */
  sources?: Passage[];
  /**
   * Which functions the model called to get here, if any.
   *
   * Shown to the person, because "it looked this up" is the difference between
   * an answer and an assertion, and this app's whole argument is that the
   * difference is visible.
   */
  toolsUsed?: string[];
  /**
   * True when the model would not take the tools and answered without them.
   *
   * Worth saying out loud. An answer written from the snapshot alone is a
   * different thing from one written after looking something up, and this is
   * the difference between a host that supports tool calling and one that does
   * not, which is not a thing to discover from the wording of an answer.
   */
  toolsDropped?: boolean;
}

// ---------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------

interface ContextObject {
  name: string;
  kind: string;
  designation?: string;
  altitudeDegrees: number;
  direction: string;
  heightInSky: string;
  magnitude: number;
  distance?: string;
  phase?: string;
  note?: string;
}

export interface SkyContext {
  observedAt: string;
  location: { latitudeDegrees: number; longitudeDegrees: number };
  conditions: {
    sunAltitudeDegrees: number;
    darkness: string;
    summary: string;
    moonPhase: string;
    moonIlluminatedPercent: number;
  };
  /**
   * Always present, above the horizon or under it.
   *
   * The Sun is left out of the lists below, because "what can I see" never
   * means the Sun and a list that started with it would be answering a
   * different question. But leaving it out of the context entirely had a
   * consequence nobody looked for: the guard checks every capitalised body
   * name in an answer against the context, so at night, when no summary
   * mentions the Sun either, a sentence as ordinary as "Saturn rises after the
   * Sun goes down" was unsupported, refused, and quietly replaced by the local
   * narrator. The AI looked absent when it was being censored for saying
   * something true.
   */
  sun: { name: 'Sun'; altitudeDegrees: number; direction: string; aboveHorizon: boolean };
  visibleNow: ContextObject[];
  aboveHorizonButHardToSee: ContextObject[];
  comingUp: { name: string; startsInMinutes: number; detail: string }[];
  focus?: ContextObject & { fact?: string };
}

function describeDistance(body: SkyBody): string | undefined {
  if (!body.distance) return undefined;
  const { value, unit } = body.distance;
  if (unit === 'km') {
    return value > 1_000_000
      ? `${(value / 1_000_000).toFixed(1)} million km away`
      : `${Math.round(value).toLocaleString()} km away`;
  }
  if (unit === 'au') {
    const lightMinutes = value * 8.317;
    return `${value.toFixed(2)} times as far away as the Sun; its light takes ${Math.round(lightMinutes)} minutes to reach us`;
  }
  return `${value.toFixed(1)} light years away`;
}

function toContextObject(body: SkyBody): ContextObject {
  return {
    name: body.name,
    kind: body.kind,
    designation: body.designation,
    altitudeDegrees: Math.round(body.altitude * 10) / 10,
    direction: compassPoint(body.azimuth),
    heightInSky: heightInWords(body.altitude),
    magnitude: Math.round(body.magnitude * 100) / 100,
    distance: describeDistance(body),
    phase: body.phaseName,
    note:
      body.kind === 'satellite'
        ? body.sunlit
          ? 'in sunlight and therefore visible as a moving point'
          : "in Earth's shadow right now, so it cannot be seen"
        : undefined,
  };
}

/** Naked-eye limiting magnitude for the current sky brightness. */
/*
 * Four numbers chosen by hand, and what happened when they were replaced.
 *
 * A model was fitted to 170,000 Globe at Night observations, which are people
 * standing outside since 2006 reporting which star chart matched what they
 * could see. It learned a light pollution term and a Moon term, both of which
 * this has never had, and on held-out data it was about eight per cent better
 * than predicting a constant. That part was real.
 *
 * It was reverted because of what it did at the other end. Globe at Night
 * observers go outside when it is already dark, so the data holds almost no
 * twilight and no daylight at all, and the fitted Sun term came out at 0.156
 * chart steps across the entire ninety degrees. The model put the midday sky
 * and the midnight sky within a twentieth of a step of each other: applied
 * here it reported a limiting magnitude of 4.72 with the Sun forty five degrees
 * up, which would have listed several hundred stars as visible at noon.
 *
 * The lesson is not that the model was bad. It is that the data covered the
 * night and the app is used in the daytime too, and a fit is only evidence
 * where the observations are. These four numbers are crude everywhere and
 * wrong nowhere, which for this particular job is the better trade.
 *
 * If it is tried again: keep this for the Sun, and let a model correct it for
 * the Moon and for light pollution once the sky is genuinely dark, which is the
 * only region the data can speak about.
 */
function limitingMagnitude(darkness: string): number {
  if (darkness === 'day') return -3.5;
  if (darkness === 'civil-twilight') return 1.5;
  if (darkness === 'nautical-twilight') return 3.5;
  return 5.5;
}

/** The Sun as the context always carries it: named, placed, and honest about being down. */
function sunContext(bodies: SkyBody[]): SkyContext['sun'] {
  const sun = bodies.find((b) => b.kind === 'sun');
  return {
    name: 'Sun',
    altitudeDegrees: sun ? Math.round(sun.altitude * 10) / 10 : 0,
    direction: sun ? compassPoint(sun.azimuth) : 'unknown',
    aboveHorizon: sun ? sun.altitude > 0 : false,
  };
}

export function buildSkyContext(options: {
  now: Date;
  site: ObserverSite;
  bodies: SkyBody[];
  conditions: SkyConditions;
  timeline: TonightTimeline | null;
  focus?: SkyBody | null;
  focusFact?: string;
}): SkyContext {
  const { now, site, bodies, conditions, timeline, focus, focusFact } = options;
  /*
   * The four numbers, plus what the model knows about tonight.
   *
   * The correction is zero outside astronomical night and zero where nobody has
   * reported an observation, so this is the same limit the app has always used
   * except on a dark night in a place the data has seen.
   */
  const limit =
    limitingMagnitude(conditions.darkness) +
    skyQuality(skyQualityInput(site, conditions)).adjustment;

  const above = bodies.filter((b) => b.altitude > 3 && b.kind !== 'sun');
  const visible = above.filter((b) => b.magnitude <= limit || b.kind === 'moon');
  const marginal = above.filter((b) => !visible.includes(b));

  const comingUp = (timeline?.spans ?? [])
    .filter((s) => s.start > now)
    .slice(0, 4)
    .map((s) => ({
      name: s.name,
      startsInMinutes: Math.round((s.start.getTime() - now.getTime()) / 60_000),
      detail: s.detail,
    }));

  return {
    observedAt: now.toISOString(),
    location: {
      // Two decimals is about a kilometre, enough for the sky, and it keeps a
      // precise home address out of the request.
      latitudeDegrees: Math.round(site.latitude * 100) / 100,
      longitudeDegrees: Math.round(site.longitude * 100) / 100,
    },
    conditions: {
      sunAltitudeDegrees: Math.round(conditions.sunAltitude * 10) / 10,
      darkness: conditions.darkness,
      summary: conditions.summary,
      moonPhase: conditions.moonPhaseName,
      moonIlluminatedPercent: Math.round(conditions.moonIlluminatedFraction * 100),
    },
    sun: sunContext(bodies),
    visibleNow: visible.map(toContextObject),
    aboveHorizonButHardToSee: marginal.map(toContextObject),
    comingUp,
    focus: focus ? { ...toContextObject(focus), fact: focusFact } : undefined,
  };
}

/** The static fact for a body, if we have one. Never invented at call time. */
export function factFor(body: SkyBody): string | undefined {
  if (body.kind === 'satellite' && body.noradId) return SATELLITE_FACTS[body.noradId];
  return BODY_FACTS[body.name];
}

// ---------------------------------------------------------------------------
// deterministic narrator
// ---------------------------------------------------------------------------

function sentenceList(items: string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Builds an answer from the computed data alone, with no model involved.
 *
 * This is not a degraded placeholder: every number in it is the same number
 * Granite would have been given. It is plainer, and it says so.
 */
export function narrateLocally(context: SkyContext, tone: Tone, question?: string): string {
  const simple = tone === 'simple';

  if (context.focus) {
    const f = context.focus;
    const parts: string[] = [];

    /*
     * A number of degrees is the one part of this a ten-year-old cannot use.
     * Nobody standing in a garden can convert twenty four degrees into where to
     * point, so the simple voice keeps the words and drops the reading. The
     * standard voice still gets it, because an adult beginner can work with it.
     */
    parts.push(
      simple
        ? `${f.name} is ${f.heightInSky} toward the ${f.direction}.`
        : `${f.name} is ${f.heightInSky} toward the ${f.direction}, about ${Math.round(f.altitudeDegrees)} degrees above the horizon.`,
    );
    if (f.fact) parts.push(f.fact);
    if (f.phase) parts.push(`It is a ${f.phase.toLowerCase()} tonight.`);
    /*
     * A planet's distance is given as two clauses: a multiple of the Earth to
     * Sun gap, and the time its light takes to arrive. The second is the half a
     * child can picture, so the simple voice keeps only that one.
     */
    if (f.distance) {
      const lightClause = f.distance.split('; ')[1];
      parts.push(
        simple
          ? lightClause
            ? `${lightClause.charAt(0).toUpperCase()}${lightClause.slice(1)}.`
            : `It is ${f.distance}.`
          : `Distance right now: ${f.distance}.`,
      );
    }
    if (f.note) parts.push(`It is ${f.note}.`);

    if (!simple) {
      parts.push(
        `Apparent magnitude ${f.magnitude.toFixed(1)}. Lower numbers mean brighter, and about 6 is the faintest the unaided eye can reach in a dark sky.`,
      );
    }
    return parts.join(' ');
  }

  if (context.visibleNow.length === 0) {
    const reason =
      context.conditions.darkness === 'day'
        ? 'The Sun is still up, so nothing is visible yet.'
        : 'Nothing bright is above the horizon from here at the moment.';
    const next = context.comingUp[0];
    return next
      ? `${reason} ${next.name} is next, in about ${next.startsInMinutes} minutes. ${next.detail}`
      : `${reason} ${context.conditions.summary}`;
  }

  const named = context.visibleNow
    .slice(0, 4)
    .map((o) => `${o.name} ${o.heightInSky} toward the ${o.direction}`);

  const opening = simple
    ? `Right now you can see ${sentenceList(named)}.`
    : `${context.conditions.summary} Above you: ${sentenceList(named)}.`;

  const next = context.comingUp[0];
  const tail = next
    ? ` Coming up: ${next.name} in about ${next.startsInMinutes} minutes.`
    : '';

  /*
   * The provenance line under every answer already says which voice spoke, so
   * repeating it inside the sentence only adds a clause a child has to read
   * past. The standard voice keeps it, where the aside costs nothing.
   */
  const asked = question && !simple ? ' (Answered from the computed sky data, without the AI guide.)' : '';
  return opening + tail + asked;
}

// ---------------------------------------------------------------------------
// watsonx
// ---------------------------------------------------------------------------

export async function askGuide(options: {
  skyContext: SkyContext;
  tone: Tone;
  question?: string;
  /**
   * The sky, as functions the model may call. Omit and it answers from the
   * snapshot alone, which is what the plaque on the chart wants: a caption
   * needs no lookups and should not spend two round trips deciding that.
   */
  tools?: SkyToolset;
  /**
   * Passages retrieved for this question, if any were.
   *
   * Retrieval happens before the call rather than as a tool the model may
   * choose, because the questions that need background are exactly the ones a
   * model answers confidently from memory without noticing it needs anything.
   * Waiting to be asked is the wrong design for a source of truth.
   */
  sources?: Passage[];
  signal?: AbortSignal;
}): Promise<GuideAnswer> {
  const { skyContext, tone, question, tools, sources, signal } = options;

  /*
   * The loop.
   *
   * The model may answer, or it may ask for something first. The endpoint is
   * stateless and the tools run here, on this machine, so a lookup is a round
   * trip: it hands back what the model wants, this computes it out of
   * astronomy-engine and posts the result back for the model to read.
   *
   * Bounded, and low. Every pass costs a call to watsonx and several seconds of
   * somebody standing outside in the dark. Three is enough for "what is that
   * bright thing in the south-east, and when does it set", which is about as
   * compound as a real question gets; a model still asking on the fourth is
   * looping, and the honest response to that is the narrator rather than
   * another minute of waiting.
   */
  const MAX_ROUNDS = 3;
  let transcript: unknown[] = [];
  const used: string[] = [];

  /*
   * A deadline on the whole exchange, rounds included.
   *
   * There was none, and a fetch with no timeout does not fail: it waits. Every
   * refusal this endpoint can make is handled a few lines below, but a request
   * that never comes back makes none of them, so the guide sat asking with a
   * spinner and no way out. That is the failure a person is most likely to
   * meet, because it is what a stalled connection and an overloaded upstream
   * both look like from here.
   *
   * Generous on purpose. A healthy answer takes seconds and three rounds of
   * tool calls take a few more, so this is not a latency budget and should
   * never fire on a working endpoint. It is a promise that the question ends.
   */
  const DEADLINE_MS = 30_000;
  const deadline = new AbortController();
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    deadline.abort();
  }, DEADLINE_MS);

  /*
   * The caller's own signal still cancels, and the two are told apart on the
   * way out: a caller aborting means the component went away and the answer is
   * no longer wanted, which must not be answered by the narrator, while the
   * deadline expiring means nobody is coming and the narrator is exactly right.
   */
  const onCallerAbort = () => deadline.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });
  const stopWaiting = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  };

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      /*
       * The last round is asked without the functions, deliberately.
       *
       * A model that can call a function will keep calling functions, and the
       * small Granites are especially prone to it: look something up, look the
       * next thing up, look the first thing up again. Three rounds of that and
       * the loop fell out of the bottom with a transcript full of good tool
       * results and nothing written from them, which is the whole of 'the AI
       * guide did not settle on an answer' — the guide had settled on plenty,
       * it had just never been made to say any of it.
       *
       * Taking the functions away on the final pass turns that dead end into
       * an answer. Everything already looked up is still in the transcript, so
       * the model is not being asked to guess; it is being told that this is
       * the turn where it writes the answer out of what it has.
       */
      const offerTools = tools && round < MAX_ROUNDS - 1;
      const res = await fetch('api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skyContext,
          tone,
          question,
          ...(offerTools ? { tools: tools.declarations } : {}),
          ...(sources?.length ? { sources } : {}),
          ...(transcript.length ? { transcript } : {}),
        }),
        signal: deadline.signal,
      });

      if (!res.ok) return fallback(res, skyContext, tone, question, used);

      const json = (await res.json()) as {
        kind?: string;
        text?: string;
        model?: string;
        calls?: { id: string; name: string; arguments?: string }[];
        toolsDropped?: boolean;
        transcript?: unknown[];
      };

      if (json.kind === 'tool_calls' && json.calls?.length && tools) {
        const answers = json.calls.map((call) => {
          used.push(call.name);
          return {
            role: 'tool',
            tool_call_id: call.id,
            /*
             * The result verbatim, as JSON. Not summarised on the way past:
             * this string is both what the model reads and what the grounding
             * guard later tests the answer against, and a summary would let a
             * number reach one and not the other.
             */
            content: JSON.stringify(tools.run(call.name, call.arguments)),
          };
        });
        transcript = [...(json.transcript ?? []), ...answers];
        continue;
      }

      if (json.text) {
        return {
          text: json.text,
          source: 'granite',
          model: json.model,
          toolsUsed: used.length ? [...new Set(used)] : undefined,
          toolsDropped: json.toolsDropped || undefined,
          sources: sources?.length ? sources : undefined,
        };
      }

      break;
    }

    // Out of rounds, or an answer that never arrived.
    return {
      text: narrateLocally(skyContext, tone, question),
      source: 'local',
      note: 'The AI guide did not settle on an answer, so this is the built-in narrator.',
    };
  } catch (err) {
    if (expired) {
      return {
        text: narrateLocally(skyContext, tone, question),
        source: 'local',
        note: 'The AI guide did not answer in time, so this is the built-in narrator.',
      };
    }
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return {
      text: narrateLocally(skyContext, tone, question),
      source: 'local',
      note: 'No connection to the AI guide, so this is the built-in narrator.',
    };
  } finally {
    stopWaiting();
  }
}

/** What the interface says when Granite was tried and could not answer. */
async function fallback(
  res: Response,
  skyContext: SkyContext,
  tone: Tone,
  question: string | undefined,
  used: string[],
): Promise<GuideAnswer> {
  const detail = (await res.json().catch(() => ({}))) as { error?: string };
  const note =
    detail.error === 'ai_unconfigured'
      ? 'The AI guide is not configured on this deployment, so this is the built-in narrator.'
      : detail.error === 'rate_limited'
        ? 'Too many questions in a row; this is the built-in narrator for now.'
        : detail.error === 'ai_ungrounded'
          ? "The AI guide's answer mentioned something that isn't in tonight's computed data or in anything it looked up, so the built-in narrator answered instead."
          : 'The AI guide could not be reached, so this is the built-in narrator.';

  return {
    text: narrateLocally(skyContext, tone, question),
    source: 'local',
    note,
    toolsUsed: used.length ? [...new Set(used)] : undefined,
  };
}

