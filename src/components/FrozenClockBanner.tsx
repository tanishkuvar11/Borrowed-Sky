/**
 * A persistent marker for when the app is pinned to a past or future moment.
 *
 * The whole instrument normally computes for right now. When a ?at= parameter
 * holds it at a specific instant, nothing on the sky screen announces that,
 * which means somebody standing outside could be looking at a different sky
 * from the one in their hand and have no way to know. That is worse than any
 * wrong number.
 *
 * This component makes the held state impossible to miss. It says which moment
 * is being shown, in the observer's own timezone, and offers one tap back to
 * the live sky. It reads as an instrument held at a setting -- the same words
 * a calibrated instrument would use -- rather than as a warning or an error.
 *
 * It renders nothing when the clock is live, so the absent case costs nothing
 * at all.
 */

import type { ObserverSite } from '../lib/astro/types';

export function FrozenClockBanner({
  pinnedInstant,
  site,
  onReturnToLive,
}: {
  pinnedInstant: Date;
  site: ObserverSite;
  onReturnToLive: () => void;
}) {
  /*
   * Full date and time rather than just the time, because the pinned instant
   * may be on a different day from today, and a time without a date is ambiguous
   * in exactly the situations this banner exists to prevent.
   *
   * The observer's own timezone is used when available; the device's zone is
   * the fallback, the same rule the rest of the app follows.
   */
  const label = new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: site.timezone,
  }).format(pinnedInstant);

  return (
    <div className="frozen-clock" role="status" aria-live="polite">
      <span className="frozen-clock__label">
        <span className="frozen-clock__key">Held at</span>
        <span className="frozen-clock__time">{label}</span>
      </span>
      <button className="frozen-clock__dismiss" onClick={onReturnToLive}>
        Return to live sky
      </button>
    </div>
  );
}
