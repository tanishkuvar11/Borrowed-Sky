/**
 * The sky, as a set of functions a model is allowed to call.
 *
 * WHY THIS EXISTS
 *
 * Until now the guide was handed a finished snapshot of the sky and asked to
 * write a sentence about it. That works, and it is also the reason the AI in
 * this app was replaceable: the deterministic narrator reads the same snapshot
 * and says almost the same thing, because neither of them is doing anything a
 * template could not. The model was rephrasing, not reasoning.
 *
 * A snapshot can only answer questions about the moment it was taken. "Is that
 * orange thing low in the east a planet or a star?" needs a search over what is
 * actually in that direction. "What will be up when I get back at midnight?"
 * needs the sky recomputed for a time that has not happened. "What is near
 * Antares?" needs the catalogue. None of those fit in a frame prepared in
 * advance, because the frame would have to contain every answer to every
 * question before the question is asked.
 *
 * So the model gets tools instead. It still computes nothing: every function
 * here runs astronomy-engine, SGP4 and the shipped catalogue, in the browser,
 * exactly as the rest of the app does. What changes is who decides what to
 * compute. The model can ask where something is; it cannot say where something
 * is.
 *
 * WHERE THIS RUNS
 *
 * In the browser, deliberately. The endpoint relays the model's requests back
 * to the client and the client answers them, so the claim on the landing page
 * stays literally true: the sky is computed on the machine you are standing
 * next to, and what is sent away is a question and a set of results, never a
 * position that some server worked out about you.
 *
 * WHAT COMES BACK
 *
 * Plain JSON with named, unit-suffixed fields, because the answer is checked.
 * Every number a tool returns joins the pool the grounding guard tests the
 * model's sentence against, so a claim the tools did not support is refused in
 * exactly the way an invented one always was.
 */

import { Body, MakeTime, SearchRiseSet, SearchHourAngle } from 'astronomy-engine';

import {
  angularSeparation,
  eqjToHorMatrix,
  horVectorToAltAz,
  rotateEqjToHor,
  type Vec3,
} from './frames.js';
import {
  BODY_FACTS,
  computeConditions,
  computeSolarSystem,
  nakedEyeVisible,
  toObserver,
} from './solar.js';
import {
  compassPoint,
  heightInWords,
  satellitesAboveHorizon,
  SATELLITE_FACTS,
  type TleSet,
} from './satellites.js';
import type { StarCatalog } from './starfield.js';
import type { ObserverSite, SkyBody } from './types.js';

/** Everything the tools need in order to answer without inventing anything. */
export interface SkyToolContext {
  site: ObserverSite;
  /** Null until the catalogue has loaded; star questions say so rather than guess. */
  catalog: StarCatalog | null;
  /** Null when Celestrak could not be reached; satellite questions say so. */
  tleSet: TleSet | null;
}

/**
 * A tool as watsonx wants it declared.
 *
 * Kept as plain data rather than generated from the implementations, because
 * this is the half the model reads and it is worth writing for that audience:
 * the descriptions are instructions to a reader who cannot see the code.
 */
export interface ToolDeclaration {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

export const SKY_TOOLS: ToolDeclaration[] = [
  {
    type: 'function',
    function: {
      name: 'where_is',
      description:
        'Find one named object in the observer’s sky right now, or at a given time. ' +
        'Works for the Sun, the Moon, the planets, the space stations, and any star in the ' +
        'catalogue by its proper name. Returns its height, its compass direction and its ' +
        'brightness, and says plainly whether it is above the horizon.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The object’s common name, for example "Saturn", "Vega", "the Moon".',
          },
          at: {
            type: 'string',
            description: 'Optional ISO 8601 instant. Omit for now.',
          },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rise_set',
      description:
        'When one object next rises, reaches its highest point, and sets, for this observer. ' +
        'Searched numerically rather than looked up. Available for the Sun, the Moon and the ' +
        'planets; other objects report that this cannot be answered for them.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The object’s common name.' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'what_is_up',
      description:
        'Everything above the observer’s horizon at a moment, brightest first, with how ' +
        'high and which way. Use this to answer questions about a time other than now, such ' +
        'as later tonight or before dawn.',
      parameters: {
        type: 'object',
        properties: {
          at: {
            type: 'string',
            description: 'Optional ISO 8601 instant. Omit for now.',
          },
          only_visible: {
            type: 'boolean',
            description:
              'When true, list only what could actually be seen with the unaided eye in the ' +
              'sky conditions at that moment. Defaults to true.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'identify',
      description:
        'Work out what somebody is pointing at from a plain description of where they are ' +
        'looking. Give the compass direction and roughly how high, and this returns the ' +
        'candidates in that part of the sky, nearest first, with how far each one is from ' +
        'the described spot. Use it for "what is that bright thing over there" questions.',
      parameters: {
        type: 'object',
        properties: {
          direction: {
            type: 'string',
            description:
              'A compass direction: "north", "south-east", "west-south-west", and so on.',
          },
          height: {
            type: 'string',
            description:
              'Roughly how high: "on the horizon", "low", "a third of the way up", ' +
              '"halfway up", "high overhead", or a number of degrees.',
          },
        },
        required: ['direction'],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// resolving names
// ---------------------------------------------------------------------------

const PLANET_BODIES: Record<string, Body> = {
  mercury: Body.Mercury,
  venus: Body.Venus,
  mars: Body.Mars,
  jupiter: Body.Jupiter,
  saturn: Body.Saturn,
  uranus: Body.Uranus,
  neptune: Body.Neptune,
  sun: Body.Sun,
  moon: Body.Moon,
};

/** "the Moon" and "moon" and "The  Moon" are all the Moon. */
function normalise(name: string): string {
  return name
    .toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Everything above the horizon at a moment, computed the same way the sky view
 * computes it, so a tool answer and the chart can never disagree.
 */
function bodiesAt(at: Date, ctx: SkyToolContext): SkyBody[] {
  const { sun, moon, planets } = computeSolarSystem(at, ctx.site);
  const satellites = ctx.tleSet
    ? satellitesAboveHorizon(ctx.tleSet.records, at, ctx.site, 0)
    : [];
  return [sun, moon, ...planets, ...satellites];
}

/** Every star in the catalogue, placed for this observer at this instant. */
function starsAt(at: Date, ctx: SkyToolContext): { index: number; altitude: number; azimuth: number }[] {
  const { catalog } = ctx;
  if (!catalog) return [];
  const matrix = eqjToHorMatrix(at, toObserver(ctx.site));
  const out: { index: number; altitude: number; azimuth: number }[] = [];
  for (let i = 0; i < catalog.count; i++) {
    const v: Vec3 = {
      x: catalog.vectors[i * 3],
      y: catalog.vectors[i * 3 + 1],
      z: catalog.vectors[i * 3 + 2],
    };
    const { altitude, azimuth } = horVectorToAltAz(rotateEqjToHor(matrix, v));
    if (altitude > 0) out.push({ index: i, altitude, azimuth });
  }
  return out;
}

// ---------------------------------------------------------------------------
// shaping answers
// ---------------------------------------------------------------------------

/**
 * One object as the model should see it.
 *
 * Units are in the field names on purpose. A bare `altitude: 41.2` invites a
 * reader to decide for itself whether that is degrees or something else, and
 * the reader here is a language model with opinions.
 */
function describe(body: SkyBody) {
  return {
    name: body.name,
    kind: body.kind,
    aboveHorizon: body.altitude > 0,
    altitudeDegrees: Math.round(body.altitude * 10) / 10,
    azimuthDegrees: Math.round(body.azimuth * 10) / 10,
    direction: compassPoint(body.azimuth),
    heightInSky: heightInWords(body.altitude),
    magnitude: Math.round(body.magnitude * 100) / 100,
    ...(body.distance
      ? { distance: `${Math.round(body.distance.value * 100) / 100} ${body.distance.unit}` }
      : {}),
    ...(body.illuminatedFraction !== undefined
      ? { illuminatedPercent: Math.round(body.illuminatedFraction * 100) }
      : {}),
    ...(BODY_FACTS[body.name] ? { fact: BODY_FACTS[body.name] } : {}),
    ...(body.noradId && SATELLITE_FACTS[body.noradId]
      ? { fact: SATELLITE_FACTS[body.noradId] }
      : {}),
  };
}

/** A time the model can repeat back to a person without converting anything. */
function clockAt(date: Date, site: ObserverSite): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: site.timezone,
  });
}

// ---------------------------------------------------------------------------
// the tools themselves
// ---------------------------------------------------------------------------

export type ToolResult = { ok: true; result: unknown } | { ok: false; error: string };

/**
 * A named direction as degrees, or null.
 *
 * Read back out of compassPoint rather than tabulated separately, so the words
 * the model is told to use and the words this understands cannot drift apart.
 */
function directionToAzimuth(text: string): number | null {
  const wanted = text.toLowerCase().replace(/[\s_]+/g, '-').trim();
  for (let azimuth = 0; azimuth < 360; azimuth += 22.5) {
    if (compassPoint(azimuth).toLowerCase() === wanted) return azimuth;
  }
  const abbreviations: Record<string, number> = {
    n: 0, nne: 22.5, ne: 45, ene: 67.5,
    e: 90, ese: 112.5, se: 135, sse: 157.5,
    s: 180, ssw: 202.5, sw: 225, wsw: 247.5,
    w: 270, wnw: 292.5, nw: 315, nnw: 337.5,
  };
  const short = wanted.replace(/-/g, '');
  return short in abbreviations ? abbreviations[short] : null;
}

/** A described height as degrees. Deliberately coarse: so is the description. */
function heightToAltitude(text: string | undefined): number {
  if (!text) return 35;
  const asNumber = Number.parseFloat(text);
  if (Number.isFinite(asNumber) && /deg|°|\d/.test(text) && asNumber >= 0 && asNumber <= 90) {
    return asNumber;
  }
  const t = text.toLowerCase();
  if (/horizon|just above|very low/.test(t)) return 5;
  if (/low/.test(t)) return 15;
  if (/third/.test(t)) return 30;
  if (/half|middle/.test(t)) return 45;
  if (/high|overhead|zenith|straight up/.test(t)) return 75;
  return 35;
}

function toolWhereIs(args: Record<string, unknown>, ctx: SkyToolContext): ToolResult {
  const name = typeof args.name === 'string' ? args.name : '';
  if (!name) return { ok: false, error: 'A name is required.' };

  const at = typeof args.at === 'string' && args.at ? new Date(args.at) : new Date();
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'That time could not be read.' };

  const key = normalise(name);

  const body = bodiesAt(at, ctx).find((b) => normalise(b.name) === key);
  if (body) return { ok: true, result: { at: at.toISOString(), ...describe(body) } };

  if (!ctx.catalog) {
    return {
      ok: false,
      error: `"${name}" is not one of the Sun, Moon, planets or tracked satellites, and the star catalogue has not loaded, so it cannot be looked up.`,
    };
  }

  const stars = starsAt(at, ctx);
  for (const star of stars) {
    if (normalise(ctx.catalog.proper[star.index] || '') === key) {
      const index = star.index;
      return {
        ok: true,
        result: {
          at: at.toISOString(),
          name: ctx.catalog.proper[index],
          kind: 'star',
          aboveHorizon: true,
          altitudeDegrees: Math.round(star.altitude * 10) / 10,
          azimuthDegrees: Math.round(star.azimuth * 10) / 10,
          direction: compassPoint(star.azimuth),
          heightInSky: heightInWords(star.altitude),
          magnitude: Math.round(ctx.catalog.magnitude[index] * 100) / 100,
          constellation: ctx.catalog.constellation[index] || undefined,
          ...(ctx.catalog.distanceLy[index] > 0
            ? { distance: `${Math.round(ctx.catalog.distanceLy[index])} light years` }
            : {}),
        },
      };
    }
  }

  /*
   * A named star that is not above the horizon is a different answer from a
   * name nobody recognises, and the difference matters to the person asking.
   */
  const known = ctx.catalog.proper.some((p) => normalise(p || '') === key);
  if (known) return { ok: false, error: `${name} is below the horizon from here at that moment.` };

  /*
   * "We could not reach the orbital elements" and "there is no such object" are
   * different facts, and only one of them is about the observer's sky. Saying
   * the second when the first is true would have the guide tell somebody the
   * space station does not exist because Celestrak was slow.
   */
  if (!ctx.tleSet && /iss|zarya|tiangong|css|station/i.test(key)) {
    return {
      ok: false,
      error: `Orbital elements could not be reached, so satellites cannot be located right now. This is a missing data source, not a missing object.`,
    };
  }

  return { ok: false, error: `"${name}" is not in this app’s catalogue of objects.` };
}

function toolRiseSet(args: Record<string, unknown>, ctx: SkyToolContext): ToolResult {
  const name = typeof args.name === 'string' ? args.name : '';
  const key = normalise(name);
  const body = PLANET_BODIES[key];
  if (!body) {
    return {
      ok: false,
      error: `Rise and set times are computed for the Sun, the Moon and the planets. "${name}" is not one of those.`,
    };
  }

  const observer = toObserver(ctx.site);
  const start = MakeTime(new Date());
  const rise = SearchRiseSet(body, observer, +1, start, 2);
  const set = SearchRiseSet(body, observer, -1, start, 2);
  const transit = SearchHourAngle(body, observer, 0, start);

  return {
    ok: true,
    result: {
      name,
      nextRise: rise ? { iso: rise.date.toISOString(), clock: clockAt(rise.date, ctx.site) } : null,
      nextHighestPoint: transit
        ? {
            iso: transit.time.date.toISOString(),
            clock: clockAt(transit.time.date, ctx.site),
            altitudeDegrees: Math.round(transit.hor.altitude * 10) / 10,
          }
        : null,
      nextSet: set ? { iso: set.date.toISOString(), clock: clockAt(set.date, ctx.site) } : null,
      // Said out loud, because "null" is not an answer a person can use and the
      // circumpolar case is a real one this app is expected to get right.
      note:
        rise || set
          ? undefined
          : 'This object neither rises nor sets from here within the next two days.',
    },
  };
}

function toolWhatIsUp(args: Record<string, unknown>, ctx: SkyToolContext): ToolResult {
  const at = typeof args.at === 'string' && args.at ? new Date(args.at) : new Date();
  if (Number.isNaN(at.getTime())) return { ok: false, error: 'That time could not be read.' };
  const onlyVisible = args.only_visible !== false;

  const conditions = computeConditions(at, ctx.site);
  const bodies = bodiesAt(at, ctx)
    .filter((b) => b.altitude > 0 && b.kind !== 'sun')
    .filter((b) => !onlyVisible || nakedEyeVisible(b, conditions.darkness))
    .sort((a, b) => a.magnitude - b.magnitude);

  return {
    ok: true,
    result: {
      at: at.toISOString(),
      clock: clockAt(at, ctx.site),
      conditions: {
        sunAltitudeDegrees: Math.round(conditions.sunAltitude * 10) / 10,
        darkness: conditions.darkness,
        summary: conditions.summary,
      },
      objects: bodies.map(describe),
      note: bodies.length
        ? undefined
        : onlyVisible
          ? 'Nothing bright enough to see with the unaided eye is above the horizon then.'
          : 'Nothing is above the horizon then.',
    },
  };
}

function toolIdentify(args: Record<string, unknown>, ctx: SkyToolContext): ToolResult {
  const direction = typeof args.direction === 'string' ? args.direction : '';
  const azimuth = directionToAzimuth(direction);
  if (azimuth === null) {
    return {
      ok: false,
      error: `"${direction}" is not a compass direction this can read. Use words like "south-east" or "west-south-west".`,
    };
  }

  const altitude = heightToAltitude(typeof args.height === 'string' ? args.height : undefined);
  const at = new Date();
  const conditions = computeConditions(at, ctx.site);

  /*
   * Everything the eye could pick out, ranked by how far it is from where the
   * person says they are looking. A description like "low in the south-east" is
   * worth perhaps twenty degrees of precision, so this offers candidates and
   * their separations and lets the model and the person settle it between them,
   * rather than declaring a winner out of a coarse input.
   */
  const wanted = { altitude, azimuth };
  const candidates: { object: ReturnType<typeof describe>; degreesAway: number }[] = [];

  for (const body of bodiesAt(at, ctx)) {
    if (body.altitude <= 0 || body.kind === 'sun') continue;
    if (!nakedEyeVisible(body, conditions.darkness)) continue;
    candidates.push({
      object: describe(body),
      degreesAway: Math.round(separation(wanted, body) * 10) / 10,
    });
  }

  if (ctx.catalog) {
    for (const star of starsAt(at, ctx)) {
      const magnitude = ctx.catalog.magnitude[star.index];
      // The brightest handful only. A description of where somebody is looking
      // cannot distinguish between the four hundred stars inside its own error.
      if (magnitude > 2.2) continue;
      const away = separation(wanted, { altitude: star.altitude, azimuth: star.azimuth });
      candidates.push({
        object: {
          name: ctx.catalog.proper[star.index] || ctx.catalog.bayer[star.index] || 'star',
          kind: 'star',
          aboveHorizon: true,
          altitudeDegrees: Math.round(star.altitude * 10) / 10,
          azimuthDegrees: Math.round(star.azimuth * 10) / 10,
          direction: compassPoint(star.azimuth),
          heightInSky: heightInWords(star.altitude),
          magnitude: Math.round(magnitude * 100) / 100,
        } as ReturnType<typeof describe>,
        degreesAway: Math.round(away * 10) / 10,
      });
    }
  }

  candidates.sort((a, b) => a.degreesAway - b.degreesAway);

  return {
    ok: true,
    result: {
      lookingToward: { direction: compassPoint(azimuth), approximateAltitudeDegrees: altitude },
      candidates: candidates.slice(0, 5),
      note: candidates.length
        ? 'Separations are from the described spot, which is only accurate to about twenty degrees.'
        : 'Nothing bright enough to see with the unaided eye is in that part of the sky right now.',
    },
  };
}

/** Angle between two alt/az points, via the shared vector helper. */
function separation(
  a: { altitude: number; azimuth: number },
  b: { altitude: number; azimuth: number },
): number {
  return angularSeparation(a.altitude, a.azimuth, b.altitude, b.azimuth);
}

/**
 * Runs one tool call.
 *
 * Never throws. A model that asks for something impossible gets a sentence
 * explaining why, which it can pass on to the person, and that is a far better
 * outcome than a stack trace on one side and an invented answer on the other.
 */
export function runSkyTool(
  name: string,
  args: Record<string, unknown>,
  ctx: SkyToolContext,
): ToolResult {
  try {
    switch (name) {
      case 'where_is':
        return toolWhereIs(args, ctx);
      case 'rise_set':
        return toolRiseSet(args, ctx);
      case 'what_is_up':
        return toolWhatIsUp(args, ctx);
      case 'identify':
        return toolIdentify(args, ctx);
      default:
        return { ok: false, error: `There is no tool called "${name}".` };
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'That could not be computed.',
    };
  }
}

/**
 * The tools bound to one observer, ready to hand to the guide.
 *
 * The adapter exists so the caller never touches the raw call shape. Arguments
 * arrive from the model as a JSON string, which may be malformed, and results
 * go back as JSON, so both edges are handled once here rather than at every
 * call site.
 */
export interface SkyToolset {
  declarations: ToolDeclaration[];
  /** Never throws. A refusal is an answer, and the model is expected to read it. */
  run(name: string, argumentsJson: string | undefined): unknown;
}

export function createSkyToolset(ctx: SkyToolContext): SkyToolset {
  return {
    declarations: SKY_TOOLS,
    run(name, argumentsJson) {
      let args: Record<string, unknown> = {};
      if (argumentsJson) {
        try {
          const parsed = JSON.parse(argumentsJson);
          if (parsed && typeof parsed === 'object') args = parsed as Record<string, unknown>;
        } catch {
          /*
           * Told, not swallowed. A model that emits malformed arguments will
           * emit them again unless something says so, and "your arguments were
           * not valid JSON" is a thing it can act on.
           */
          return { error: `The arguments to ${name} were not valid JSON.` };
        }
      }
      const answer = runSkyTool(name, args, ctx);
      return answer.ok ? answer.result : { error: answer.error };
    },
  };
}
