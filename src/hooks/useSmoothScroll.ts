/**
 * Smooth scrolling.
 *
 * A wheel event is a notch. Anything driven straight from it feels notched
 * however fast it responds, because the input itself arrives in steps. Lenis
 * replaces the browser's scroll position with an eased one that carries
 * momentum, so what the page reads is continuous.
 *
 * Fetched on demand: imported at the top of this file it would be pulled into
 * the main bundle by whoever imports the hook, putting it in front of every
 * returning visitor, who has already given their coordinates, goes straight to
 * the sky view and never scrolls a long page again.
 *
 * It drives its own animation frame. An earlier version ran Lenis from GSAP's
 * ticker so that ScrollTrigger and Lenis shared one clock, which mattered while
 * a pinned GSAP section existed. Nothing pins any more; the overture reads
 * scroll position directly, so that arrangement was importing an animation
 * library, thirty kilobytes of it, to schedule a callback.
 */

import { useEffect } from 'react';
import type Lenis from 'lenis';

export function useSmoothScroll(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    // Someone who has asked for less motion has not asked for their scroll to
    // be reinterpreted either. Native scrolling is the accessible default.
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    let cancelled = false;
    let teardown: (() => void) | null = null;

    void (async () => {
      const { default: LenisCtor } = await import('lenis');
      // The effect can be torn down while the import is still in flight.
      if (cancelled) return;

      const lenis = new LenisCtor({
        // Long enough to feel weighted, short enough that the page still goes
        // where you threw it.
        duration: 1.05,
        easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
        smoothWheel: true,
        // Touch devices already have momentum scrolling in hardware, and
        // doubling it up feels laggy rather than smooth.
        syncTouch: false,
      });

      let frame = requestAnimationFrame(function tick(time) {
        lenis.raf(time);
        frame = requestAnimationFrame(tick);
      });

      /*
       * Lenis owns the scroll position once it is running, so `window.scrollTo`
       * moves the document without Lenis noticing and nothing downstream
       * updates. Real input is unaffected (wheel and touch both go through
       * Lenis) but integration tests drive the page programmatically, so in
       * development the instance is published for them to steer.
       */
      if (import.meta.env.DEV) {
        (window as unknown as { __lenis?: Lenis }).__lenis = lenis;
      }

      teardown = () => {
        cancelAnimationFrame(frame);
        lenis.destroy();
        if (import.meta.env.DEV) {
          delete (window as unknown as { __lenis?: Lenis }).__lenis;
        }
      };
    })();

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, [enabled]);
}
