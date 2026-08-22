/**
 * The ?at= URL parameter, parsed into an instant or rejected.
 *
 * The central requirement is that bad input is harmless: a link with a typo
 * in it must degrade to the live clock rather than to 1970 or a blank screen.
 * That makes the rejection cases at least as important as the accepted one, and
 * there are more of them: empty string, free text, an integer timestamp, an
 * impossible date, and the ordinary case of no parameter at all.
 *
 * Because requestedInstant reads window.location.search, a light shim stands
 * in for the browser object. The shim sets only the one property the function
 * reads, so anything that passes here is also passing against the actual API
 * rather than against a re-implementation of it.
 *
 * Run: npx tsx scripts/verify/instant.check.ts
 */

import { requestedInstant } from '../../src/lib/instant.ts';

const failures: string[] = [];

function check(label: string, ok: boolean, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/** Point the function at a fake URL for each test. */
function withSearch(search: string, fn: () => void) {
  const real = global.window;
  // @ts-ignore -- Node has no window; a plain object covers the one property read.
  global.window = { location: { search } };
  try {
    fn();
  } finally {
    // @ts-ignore
    global.window = real;
  }
}

console.log('\nthe accepted form');
withSearch('?at=2026-09-27T19:40:51Z', () => {
  const got = requestedInstant();
  check('a well-formed ISO instant is accepted', got !== null, got?.toISOString() ?? 'null');
  check(
    'and it resolves to the right millisecond',
    got?.getTime() === new Date('2026-09-27T19:40:51Z').getTime(),
    got?.toISOString() ?? '',
  );
});

/*
 * A past but historically meaningful date -- the launch of Sputnik -- verifies
 * that the earliest-year floor is set below 1957 and not accidentally above it.
 */
withSearch('?at=1957-10-04T19:12:00Z', () => {
  const got = requestedInstant();
  check('the sputnik launch is accepted', got !== null, got?.toISOString() ?? 'null');
});

/*
 * A URL encodes a literal + as %2B in the query string. The raw + character
 * means space in application/x-www-form-urlencoded, which is what URLSearchParams
 * reads, so the correctly encoded form of +02:00 in a URL is %2B02:00. A test
 * that writes + directly in the search string would be testing the wrong input.
 */
console.log('\nexplicit offset instead of Z (percent-encoded as a URL carries it)');
withSearch('?at=2026-09-27T21%3A40%3A51%2B02%3A00', () => {
  const got = requestedInstant();
  check('a percent-encoded UTC offset is accepted', got !== null, got?.toISOString() ?? 'null');
  check(
    'and resolves to the same moment as the Z form',
    got?.getTime() === new Date('2026-09-27T19:40:51Z').getTime(),
    got?.toISOString() ?? '',
  );
});

console.log('\nthe four bad inputs from the spec, each of which must return null');

/*
 * Empty value: ?at= with nothing after it. The function must not guess "now"
 * or "epoch" -- it must return null and leave the live clock running.
 */
withSearch('?at=', () => {
  check('empty ?at= is rejected', requestedInstant() === null);
});

/*
 * Free text: a human word that Date.parse might accept on some engines ("today",
 * "tomorrow", "next Friday"). The regex must stop all of these before they reach
 * the parser.
 */
withSearch('?at=tomorrow', () => {
  check('free text is rejected', requestedInstant() === null);
});

/*
 * Raw integer timestamp: thirteen-digit milliseconds. Superficially numeric
 * and easily confused with a valid value, but it is not an ISO 8601 instant and
 * must not be silently cast to a Date.
 */
withSearch('?at=99999999999999', () => {
  check('an integer timestamp is rejected', requestedInstant() === null);
});

/*
 * An impossible calendar date: month 13, day 45, hour 99. The regex passes it
 * because the digits are in the right shape; the year-range check alone does
 * not catch it. The engine will either reject it or roll it forward into a
 * valid date, both of which must still produce null here.
 */
withSearch('?at=2026-13-45T99:99Z', () => {
  check('an impossible date is rejected', requestedInstant() === null);
});

console.log('\nabsent parameter');

/*
 * The most important case. No ?at= at all is the live-clock path, and nothing
 * in the app must change on a plain visit.
 */
withSearch('', () => {
  check('no ?at= returns null', requestedInstant() === null);
});

withSearch('?foo=bar', () => {
  check('unrelated parameters return null', requestedInstant() === null);
});

console.log('\nrange boundaries');

/*
 * Dates far outside a reasonable calendar window. The year-range check exists
 * precisely for these: 99999-01-01 would otherwise parse successfully, and the
 * app has no business computing a sky for a date ten millennia out.
 */
withSearch('?at=99999-01-01T00:00:00Z', () => {
  check('a date far in the future is rejected', requestedInstant() === null);
});
withSearch('?at=1800-01-01T00:00:00Z', () => {
  check('a date before the space age is rejected', requestedInstant() === null);
});

console.log('');
if (failures.length) {
  console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('PASS  the parser accepts good instants and rejects everything else');
