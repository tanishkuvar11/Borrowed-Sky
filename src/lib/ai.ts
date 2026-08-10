/**
 * The narration layer.
 *
 * Two things matter here. First, the model is handed a finished description of
 * the sky and is never asked to work out where anything is — that job belongs
 * to astronomy-engine and SGP4. Second, when watsonx is unreachable or simply
 * not configured, the app does not go quiet and does not start guessing: it
 * falls back to a deterministic narrator that assembles sentences from the same
 * computed numbers. The interface always says which of the two spoke.
 */

import { compassPoint, heightInWords, SATELLITE_FACTS } from './astro/satellites';
import { BODY_FACTS } from './astro/solar';
import type { ObserverSite, SkyBody, SkyConditions } from './astro/types';
import type { TonightTimeline } from './astro/events';

export type Tone = 'simple' | 'standard';
export type NarrationSource = 'granite' | 'local';

export interface GuideAnswer {
  text: string;
  source: NarrationSource;
  model?: string;
  /** Present when Granite was tried and could not answer. */
  note?: string;
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
    return `${value.toFixed(2)} times the Earth-Sun distance — light takes ${Math.round(lightMinutes)} minutes to cross it`;
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
function limitingMagnitude(darkness: string): number {
  if (darkness === 'day') return -3.5;
  if (darkness === 'civil-twilight') return 1.5;
  if (darkness === 'nautical-twilight') return 3.5;
  return 5.5;
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
  const limit = limitingMagnitude(conditions.darkness);

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
      // Two decimals is about a kilometre — enough for the sky, and it keeps a
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
 * This is not a degraded placeholder — every number in it is the same number
 * Granite would have been given. It is plainer, and it says so.
 */
export function narrateLocally(context: SkyContext, tone: Tone, question?: string): string {
  const simple = tone === 'simple';

  if (context.focus) {
    const f = context.focus;
    const parts: string[] = [];

    parts.push(
      `${f.name} is ${f.heightInSky} toward the ${f.direction}, about ${Math.round(f.altitudeDegrees)} degrees above the horizon.`,
    );
    if (f.fact) parts.push(f.fact);
    if (f.phase) parts.push(`It is a ${f.phase.toLowerCase()} tonight.`);
    if (f.distance) parts.push(simple ? `It is ${f.distance}.` : `Distance right now: ${f.distance}.`);
    if (f.note) parts.push(`It is ${f.note}.`);

    if (!simple) {
      parts.push(
        `Apparent magnitude ${f.magnitude.toFixed(1)} — lower numbers mean brighter, and about 6 is the faintest the unaided eye can reach in a dark sky.`,
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

  const asked = question ? ' (Answered from the computed sky data, without the AI guide.)' : '';
  return opening + tail + asked;
}

// ---------------------------------------------------------------------------
// watsonx
// ---------------------------------------------------------------------------

export async function askGuide(options: {
  skyContext: SkyContext;
  tone: Tone;
  question?: string;
  signal?: AbortSignal;
}): Promise<GuideAnswer> {
  const { skyContext, tone, question, signal } = options;

  try {
    const res = await fetch('api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skyContext, tone, question }),
      signal,
    });

    if (res.ok) {
      const json = (await res.json()) as { text?: string; model?: string };
      if (json.text) return { text: json.text, source: 'granite', model: json.model };
      throw new Error('empty response');
    }

    const detail = (await res.json().catch(() => ({}))) as { error?: string };
    const note =
      detail.error === 'ai_unconfigured'
        ? 'The AI guide is not configured on this deployment, so this is the built-in narrator.'
        : detail.error === 'rate_limited'
          ? 'Too many questions in a row — this is the built-in narrator for now.'
          : 'The AI guide could not be reached, so this is the built-in narrator.';

    return { text: narrateLocally(skyContext, tone, question), source: 'local', note };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    return {
      text: narrateLocally(skyContext, tone, question),
      source: 'local',
      note: 'No connection to the AI guide, so this is the built-in narrator.',
    };
  }
}
