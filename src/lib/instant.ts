/**
 * Reading a pinned instant from the URL.
 *
 * A link that includes ?at=<ISO 8601> opens the app at a specific moment
 * rather than tracking the live clock. The whole point is that a link with a
 * typo in it must degrade to the ordinary app rather than to a blank screen
 * or to 1970, so anything that cannot be parsed as a reasonable date is treated
 * the same as no parameter at all: the live clock runs.
 *
 * "Reasonable" is a calendar range check rather than an astronomy one: dates
 * before the space age (1957) or more than a century ahead are almost certainly
 * accidents rather than intent, and producing results for 99999-01-01 is more
 * confusing than falling back silently.
 */

const EARLIEST_YEAR = 1957;
const LATEST_YEAR = new Date().getFullYear() + 100;

/** The instant the URL asks for, or null for the ordinary live clock. */
export function requestedInstant(): Date | null {
  if (typeof window === 'undefined') return null;

  const raw = new URLSearchParams(window.location.search).get('at');
  if (!raw) return null;

  /*
   * Date.parse accepts far more than ISO 8601 and its error handling is
   * engine-dependent, so the check below rejects anything that does not look
   * like a full ISO instant before handing it to the engine. A partial date
   * such as "2026-09-27" would otherwise parse to midnight UTC, which is a
   * plausible but almost certainly wrong answer.
   *
   * The pattern requires a date, a T separator, hours and minutes, and a Z or
   * explicit offset. Fractional seconds are optional.
   */
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:\d{2})$/.test(raw)) {
    return null;
  }

  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;

  const year = new Date(ms).getFullYear();
  if (year < EARLIEST_YEAR || year > LATEST_YEAR) return null;

  return new Date(ms);
}
