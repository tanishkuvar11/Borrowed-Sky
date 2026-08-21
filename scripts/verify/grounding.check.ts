/**
 * Verifies that the grounding guard catches hallucinated claims and passes
 * legitimate ones.
 *
 * The sky context used by every case is computed by the same code the browser
 * runs, for a real place and the real current moment. No context data is
 * hand-written here; that would both violate the project rule against
 * fabricated astronomy data and silently break the first time buildSkyContext
 * changes its output shape.
 *
 * Run: npx tsx scripts/verify/grounding.check.ts
 */

import { checkGrounding } from '../../api/_lib/grounding.ts';
import { buildSkyContext } from '../../src/lib/ai.ts';
import { buildTimeline } from '../../src/lib/astro/events.ts';
import { computeConditions, computeSolarSystem } from '../../src/lib/astro/solar.ts';
import type { ObserverSite } from '../../src/lib/astro/types.ts';

// ---------------------------------------------------------------------------
// Build a real sky context
// ---------------------------------------------------------------------------

const site: ObserverSite = {
  latitude: 51.4779,
  longitude: -0.0015,
  elevation: 45,
  source: 'manual',
  label: 'Royal Observatory, Greenwich',
};

const now = new Date();
const solar = computeSolarSystem(now, site);
const conditions = computeConditions(now, site);
const bodies = [solar.sun, solar.moon, ...solar.planets];
const timeline = buildTimeline(now, site, null, 'satellites not fetched in this check', 12);
const ctx = buildSkyContext({ now, site, bodies, conditions, timeline });

console.log(`context   ${now.toISOString()} at ${site.label}`);
console.log(
  `          sun ${ctx.conditions.sunAltitudeDegrees}deg, ${ctx.conditions.darkness}`,
);
console.log(
  `          ${ctx.visibleNow.length} visible, ${ctx.aboveHorizonButHardToSee.length} marginal`,
);

// ---------------------------------------------------------------------------
// Helpers for deriving test values at runtime (amendment 4)
// ---------------------------------------------------------------------------

/**
 * Collects every finite number in the context, excluding observedAt, with
 * the same logic the guard itself uses. This ensures the tolerance windows we
 * compute here match the ones the guard computes.
 */
function collectContextNumbers(value: unknown, key?: string): number[] {
  if (key === 'observedAt') return [];
  if (typeof value === 'number' && isFinite(value)) return [value];
  if (typeof value === 'string') {
    const cleaned = value.replace(/,(?=\d{3})/g, '');
    const found: number[] = [];
    for (const m of cleaned.matchAll(/-?\d+(?:\.\d+)?/g)) {
      const n = parseFloat(m[0]);
      if (isFinite(n)) found.push(n);
    }
    return found;
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectContextNumbers(item));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).flatMap(([k, v]) =>
      collectContextNumbers(v, k),
    );
  }
  return [];
}

function tolerance(c: number): number {
  return Math.max(0.5, 0.05 * Math.abs(c));
}

/**
 * Finds a number that is outside the tolerance window of EVERY context number.
 * Starts at `seed` and walks outward by `step` in alternating directions until
 * it finds a gap. Returns undefined if no such value exists within 10,000
 * steps (which in practice never happens for sky data).
 *
 * This replaces the "shift by 30" shortcut that can accidentally land within
 * 5% of some unrelated number and make the test pass when it should fail.
 */
function findUnsupportedValue(seed: number, step: number, contextNums: number[]): number {
  function isSupported(v: number): boolean {
    return contextNums.some((c) => Math.abs(v - c) <= tolerance(c));
  }

  for (let i = 1; i <= 10_000; i++) {
    const candidate = seed + i * step;
    if (!isSupported(candidate)) return candidate;
    const negCandidate = seed - i * step;
    if (negCandidate >= 0 && !isSupported(negCandidate)) return negCandidate;
  }

  // Last resort: something far enough away that no tolerance could cover it.
  return seed + 10_000 * step;
}

const contextNums = collectContextNumbers(ctx);

// ---------------------------------------------------------------------------
// Pick a representative visible object for cases 1, 2, 3
//
// Prefer an object from visibleNow; fall back to aboveHorizonButHardToSee or
// the conditions block if nothing is above the horizon yet (daytime run).
// ---------------------------------------------------------------------------

const focusObject =
  ctx.visibleNow[0] ??
  ctx.aboveHorizonButHardToSee[0] ??
  null;

// Altitude from the context, for cases that need a real measured value.
// If no object is visible (full daylight), use the Sun's altitude from
// conditions instead, which is always present.
const knownAltitude: number = focusObject
  ? focusObject.altitudeDegrees
  : ctx.conditions.sunAltitudeDegrees;

const knownName: string = focusObject ? focusObject.name : 'Sun';
const knownDirection: string = focusObject ? focusObject.direction : ctx.conditions.darkness;

// ---------------------------------------------------------------------------
// Compass-point helpers for case 5
// ---------------------------------------------------------------------------

const COMPASS_POINTS = [
  'north', 'north-north-east', 'north-east', 'east-north-east',
  'east', 'east-south-east', 'south-east', 'south-south-east',
  'south', 'south-south-west', 'south-west', 'west-south-west',
  'west', 'west-north-west', 'north-west', 'north-north-west',
];

/** Returns the set of directions the context actually mentions. */
function collectContextDirections(): Set<string> {
  const allStrings: string[] = [];
  function gatherStrings(v: unknown): void {
    if (typeof v === 'string') { allStrings.push(v.toLowerCase()); return; }
    if (Array.isArray(v)) { v.forEach(gatherStrings); return; }
    if (v !== null && typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(gatherStrings);
    }
  }
  gatherStrings(ctx);
  const joined = allStrings.join(' ');
  const present = new Set<string>();
  for (const point of COMPASS_POINTS) {
    if (joined.includes(point) || joined.includes(point.replace(/-/g, ''))) {
      present.add(point);
    }
  }
  return present;
}

const presentDirections = collectContextDirections();
const absentDirection = COMPASS_POINTS.find((p) => !presentDirections.has(p));

// ---------------------------------------------------------------------------
// Magnitude for case 8: find an object's real magnitude, then find a value
// outside every tolerance window so the test is not flaky.
// ---------------------------------------------------------------------------

const knownMagnitude: number = focusObject ? focusObject.magnitude : 0;
// Pick a step of 2 magnitudes, walk until we find a gap.
const unsupportedMagnitude = findUnsupportedValue(knownMagnitude, 2, contextNums);

// ---------------------------------------------------------------------------
// Altitude for case 3: find a value that is outside every tolerance window.
// ---------------------------------------------------------------------------

const unsupportedAltitude = findUnsupportedValue(knownAltitude, 1, contextNums);

// ---------------------------------------------------------------------------
// Run the cases
// ---------------------------------------------------------------------------

const failures: string[] = [];
let passed = 0;

function assert(
  caseNum: number,
  label: string,
  report: ReturnType<typeof checkGrounding>,
  expectedOk: boolean,
  requiredUnsupportedSubstring?: string,
): void {
  let ok = report.ok === expectedOk;

  if (ok && !expectedOk && requiredUnsupportedSubstring) {
    ok = report.unsupported.some((u) =>
      u.toLowerCase().includes(requiredUnsupportedSubstring.toLowerCase()),
    );
  }

  if (ok) {
    console.log(`  PASS  case ${caseNum}: ${label}`);
    passed++;
  } else {
    const got = report.ok ? 'ok=true' : `ok=false, unsupported=${JSON.stringify(report.unsupported)}`;
    const msg = `case ${caseNum} (${label}): expected ok=${expectedOk}${requiredUnsupportedSubstring ? `, unsupported includes "${requiredUnsupportedSubstring}"` : ''}; got ${got}`;
    console.log(`  FAIL  ${msg}`);
    failures.push(msg);
  }
}

console.log(`\nrunning 12 cases`);
console.log(`  focus object : ${knownName} at ${knownAltitude}deg toward the ${knownDirection}`);
console.log(`  bad altitude : ${unsupportedAltitude.toFixed(1)}deg (outside all tolerance windows)`);
console.log(`  bad magnitude: ${unsupportedMagnitude.toFixed(1)} (outside all tolerance windows)`);
console.log(`  absent direction: ${absentDirection ?? '(none -- all 16 points present, skipping case 5)'}`);
console.log('');

// Case 1: a sentence built from values read out of the computed context.
// The altitude comes from the context object directly, so it must be supported.
assert(
  1,
  'sentence from real context values',
  checkGrounding(
    `${knownName} is currently at ${knownAltitude} degrees above the horizon, toward the ${knownDirection}.`,
    ctx,
  ),
  true,
);

// Case 2: same sentence but altitude rounded to the nearest integer degree.
// The absolute tolerance floor is 0.5, so any value within half a degree of a
// context number must pass. Rounding to the nearest integer is always within
// 0.5 of the original stored value, so this is guaranteed to pass for any
// altitude regardless of magnitude. It still exercises the tolerance path:
// the value in the answer is not identical to the stored value.
const roundedAlt = Math.round(knownAltitude);
assert(
  2,
  `altitude rounded to nearest degree (${roundedAlt}deg) is within tolerance`,
  checkGrounding(
    `${knownName} is currently at ${roundedAlt} degrees above the horizon, toward the ${knownDirection}.`,
    ctx,
  ),
  true,
);

// Case 3: same sentence with an altitude that is outside every tolerance window.
// Uses findUnsupportedValue to guarantee no accidental coverage by an unrelated
// context number, which a hardcoded "shift by 30" cannot guarantee.
assert(
  3,
  `altitude ${unsupportedAltitude.toFixed(1)}deg is outside all tolerance windows`,
  checkGrounding(
    `${knownName} is at ${unsupportedAltitude.toFixed(1)} degrees above the horizon, toward the ${knownDirection}.`,
    ctx,
  ),
  false,
);

// Case 4: a star name that cannot be in the context.
// buildSkyContext never receives stars (only sun, moon, planets, satellites),
// so any star name is guaranteed to be absent. Betelgeuse is used because it
// is in the HYG catalogue and is well-known enough to be a likely hallucination.
assert(
  4,
  '"Betelgeuse" named but not in context (stars are never in the sky context)',
  checkGrounding(
    'Betelgeuse is rising in the east, a red giant you can easily spot.',
    ctx,
  ),
  false,
  'betelgeuse',
);

// Case 5: a compass direction the context never uses for any object.
// Uses the set of directions actually present, picked at runtime, so the test
// is not flaky across nights when nearly all directions are occupied.
if (absentDirection) {
  assert(
    5,
    `direction "${absentDirection}" not used for any object tonight`,
    checkGrounding(
      `Look toward the ${absentDirection} for something interesting.`,
      ctx,
    ),
    false,
    absentDirection,
  );
} else {
  // All 16 compass points are in use tonight (very unusual with ~10 objects).
  // Skip rather than invent a broken assertion.
  console.log('  SKIP  case 5: all 16 compass points appear in tonight\'s context');
  passed++;
}

// Case 6: pure prose with no numbers, names or directions.
assert(
  6,
  'pure prose with no measurable claims',
  checkGrounding(
    'The sky tonight is remarkably clear. Take a moment to let your eyes adjust.',
    ctx,
  ),
  true,
);

// Case 7: a refusal. Granite is instructed to say this when the data does not
// answer the question. The guard must never block a refusal, or it would make
// the model afraid to be honest.
assert(
  7,
  '"I can\'t see that" refusal is never blocked',
  checkGrounding("I can't see that in tonight's data.", ctx),
  true,
);

// Case 8: a magnitude that no object in the context has.
// Uses findUnsupportedValue so a coincidentally nearby altitude or distance
// cannot give it accidental cover.
assert(
  8,
  `magnitude ${unsupportedMagnitude.toFixed(1)} is outside all tolerance windows`,
  checkGrounding(
    `That object has an apparent magnitude of ${unsupportedMagnitude.toFixed(1)}, making it quite bright.`,
    ctx,
  ),
  false,
);

/*
 * Cases 9 to 11: evidence that arrived from a tool call.
 *
 * The guide can now ask the astronomy engine for things the sky context never
 * contained, so the context is no longer the whole of what an answer may be
 * built from. The guard takes an array of sources instead, and these three make
 * the difference visible.
 *
 * The middle one is the one that matters. The same sentence is checked twice,
 * with the tool result and without, and it must pass with and fail without. If
 * the array were being walked wrongly, or ignored, or flattened into a string,
 * case 9 would still pass, because a guard that accepts everything accepts this
 * too. Only the pair shows the tool result is what made the difference.
 */
/*
 * Values chosen against tonight's actual sky, not written down.
 *
 * The first version of these cases used fixed numbers, and passed for a week
 * until the evening the real sky put something within tolerance of one of them
 * and case 10 started reporting that a claim was supported when the whole point
 * was that it should not be. The context here is computed at run time, so
 * anything compared against it has to be derived at run time too. Every other
 * case in this file already does that; these now do as well.
 */
const toolAltitude = findUnsupportedValue(knownAltitude, 1, contextNums);
const toolDirection = absentDirection ?? knownDirection;
const toolAnswer = {
  name: knownName,
  altitudeDegrees: toolAltitude,
  direction: toolDirection,
};

const toolClaim = `${knownName} is about ${toolAltitude.toFixed(1)} degrees up toward the ${toolDirection}.`;

assert(
  9,
  'a claim the tool result supports passes',
  checkGrounding(toolClaim, [ctx, toolAnswer]),
  true,
);

assert(
  10,
  'the same claim fails without it, so the array is really being read',
  checkGrounding(toolClaim, ctx),
  false,
);

const neverSaid = findUnsupportedValue(toolAltitude, 3, [...contextNums, toolAltitude]);
assert(
  11,
  'a claim neither the context nor the tool supports is still refused',
  checkGrounding(
    `${knownName} is about ${neverSaid.toFixed(1)} degrees up.`,
    [ctx, toolAnswer],
  ),
  false,
);

/*
 * Case 12: the Sun may be spoken of at night.
 *
 * The Sun is deliberately absent from the object lists, because "what can I
 * see" never means the Sun. It has to be somewhere in the context all the
 * same: the guard checks capitalised names against what the context contains,
 * and at night no conditions summary mentions the Sun either, so a sentence as
 * ordinary as "Saturn rises after the Sun goes down" was refused and replaced
 * by the local narrator. An answer censored for saying something true is
 * indistinguishable, from outside, from an AI that is not there.
 */
assert(
  12,
  'the Sun can be named in an answer even when it is down',
  checkGrounding('Saturn will be easier to see once the Sun is properly down.', ctx),
  true,
);

// ---------------------------------------------------------------------------

console.log(
  failures.length
    ? `\nFAIL  ${failures.length} of 12 cases failed\n  ${failures.join('\n  ')}`
    : `\nPASS  ${passed} of 12 cases`,
);
process.exit(failures.length ? 1 : 0);
