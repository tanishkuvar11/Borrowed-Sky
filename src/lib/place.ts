/**
 * Asking what a coordinate is called.
 *
 * The only lookup in the app that is about the user rather than about the sky,
 * and the only one whose answer cannot be computed. Everything above the
 * horizon comes out of astronomy-engine, SGP4 and the catalogues this app
 * ships; a place name is a fact about people, and people had to write it down
 * somewhere first.
 *
 * The endpoint behind this rounds the coordinates before they reach anybody
 * else, and refuses to guess when the lookup fails. See api/place.ts, where all
 * of that reasoning lives, because that is where the request actually leaves.
 *
 * Nothing here blocks the sky. The plate shows the coordinates the moment there
 * are any, because those were computed and are true on their own; the name and
 * the timezone are an annotation that arrives when it arrives, or never.
 */

export interface Place {
  /** Something a person would say out loud: "Udupi, India". */
  name: string | null;
  /** The IANA zone at those coordinates, which need not be the device's. */
  timezone: string | null;
}

/**
 * Held per rounded coordinate, for the life of the page.
 *
 * Same rounding as the endpoint, so the key here and the key there agree and a
 * site nudged by a metre of GPS drift does not start a second request.
 */
const held = new Map<string, Promise<Place | null>>();

function key(latitude: number, longitude: number): string {
  return `${Math.round(latitude * 100) / 100},${Math.round(longitude * 100) / 100}`;
}

export function lookupPlace(latitude: number, longitude: number): Promise<Place | null> {
  const id = key(latitude, longitude);
  const existing = held.get(id);
  if (existing) return existing;

  const work = (async (): Promise<Place | null> => {
    try {
      const res = await fetch(
        `api/place?lat=${encodeURIComponent(latitude)}&lon=${encodeURIComponent(longitude)}`,
        { signal: AbortSignal.timeout(12_000) },
      );
      if (!res.ok) return null;
      const body = (await res.json()) as Partial<Place>;
      const name = typeof body.name === 'string' && body.name ? body.name : null;
      const timezone = typeof body.timezone === 'string' && body.timezone ? body.timezone : null;
      return name || timezone ? { name, timezone } : null;
    } catch {
      /*
       * A failed lookup is not an error state worth showing. The plate is
       * already telling the truth without it, and a line reading "could not
       * work out where you are" under a set of coordinates that plainly did
       * work would be worse than saying nothing.
       */
      return null;
    }
  })();

  held.set(id, work);
  return work;
}

/** The zone the browser is set to, which is the one every clock here is drawn in. */
export function deviceTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/**
 * Minutes east of UTC in a given zone at a given moment, or null if unknown.
 *
 * Exported for scripts/verify/place.check.ts, which asserts the half-hour and
 * negative offsets this has to parse correctly and which nothing in the app
 * would otherwise exercise until somebody in Newfoundland opened it.
 */
export function offsetMinutes(timeZone: string, at: Date): number | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(at)
      .find((part) => part.type === 'timeZoneName')?.value;
    if (!name) return null;

    // "GMT" on the nose, or "GMT+05:30". Zones on the meridian print the first.
    if (name === 'GMT' || name === 'UTC') return 0;
    const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
    if (!match) return null;
    const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
    return match[1] === '-' ? -minutes : minutes;
  } catch {
    return null;
  }
}

/**
 * True when the clocks on screen are not the clocks where the observer is.
 *
 * Compares what the two zones are actually set to at this moment rather than
 * comparing their names, which is a trap: browsers still report plenty of
 * legacy aliases, so a phone in India says "Asia/Calcutta" where the lookup
 * says "Asia/Kolkata", and a check on the strings calls that a mismatch and
 * warns somebody sitting at home that they are in the wrong timezone.
 *
 * Offsets also settle the honest cases correctly. Somewhere observing summer
 * time is genuinely an hour from its winter self, and two zones with different
 * names that happen to share an offset are, for the purpose of reading a clock,
 * the same place.
 */
export function clockDiffersFrom(timezone: string | null, at: Date): boolean {
  if (!timezone) return false;
  const there = offsetMinutes(timezone, at);
  if (there === null) return false;
  return there !== -at.getTimezoneOffset();
}
