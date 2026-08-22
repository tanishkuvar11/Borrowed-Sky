/**
 * The way into the guide, and nothing else.
 *
 * This was a standing briefing: it asked the model what was worth looking at
 * the moment the sky view mounted, and printed the answer in a panel over the
 * chart. Two things were wrong with that.
 *
 * It wrote across the sky. On a phone a paragraph nobody asked for lay over the
 * thing they opened the app to look at, and on a desktop it did the same in a
 * column. The guide is a screen of its own, one tap away, and somebody who
 * wants an answer can go and get one.
 *
 * And it spent a request to do it. Every arrival at the sky view fired a
 * completion, whether or not anybody read it, on an account with a finite
 * quota. The briefing was the single most expensive thing in the app and the
 * least asked for.
 *
 * So it is a button. The sight beside the label is still a sight rather than a
 * decoration, but there is nothing for it to be working on any more, and it
 * sits still.
 */

/** A ring and a reticle: the mark this app uses for the guide, everywhere. */
function GuideSight() {
  return (
    <span className="guide__sight" aria-hidden>
      <svg viewBox="0 0 48 48" width="18" height="18" fill="none" stroke="currentColor">
        <circle cx="24" cy="24" r="21" strokeWidth="0.8" opacity="0.35" />
        <circle cx="24" cy="24" r="13" strokeWidth="0.9" opacity="0.6" />
        <circle cx="24" cy="24" r="3.2" strokeWidth="1.1" />
        <path d="M24 1v7M24 40v7M1 24h7M40 24h7" strokeWidth="1.1" opacity="0.75" />
      </svg>
    </span>
  );
}

export function GuidePlaque({ onOpenGuide }: { onOpenGuide: () => void }) {
  return (
    <button className="guide-panel" onClick={onOpenGuide}>
      <span className="guide-panel__head">
        <GuideSight />

        <span className="guide-panel__title">
          AI Guide
          <span className="guide-panel__star" aria-hidden>
            ✦
          </span>
        </span>

        <span className="guide-panel__chevron" aria-hidden>
          <svg width="12" height="12" viewBox="0 0 14 14" fill="none" stroke="currentColor">
            <path d="M5 2l5 5-5 5" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
        </span>
      </span>
    </button>
  );
}
