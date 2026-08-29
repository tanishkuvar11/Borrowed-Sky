/**
 * How far through a scrolling element the page has travelled, 0 to 1.
 *
 * Read on a rAF tick rather than on the scroll event itself. Scroll fires far
 * more often than the screen refreshes, and the reader here drives a canvas
 * that redraws the whole sky; doing that work per event would spend most of it
 * on frames nobody sees.
 *
 * Nothing here hijacks the scroll. The page scrolls at the speed the platform
 * says it should; this only reports where it got to, so momentum, rubber-band
 * and accessibility settings all keep behaving the way the user expects.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
  );
}

export function useScrollProgress(ref: RefObject<HTMLElement | null>): number {
  const [progress, setProgress] = useState(0);
  const frame = useRef(0);
  const last = useRef(-1);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // With reduced motion the page is a document, not a sequence: report the
    // settled end state once and never animate toward it.
    if (prefersReducedMotion()) {
      setProgress(1);
      return;
    }

    const measure = () => {
      frame.current = 0;
      const rect = element.getBoundingClientRect();
      // Distance the element can travel before its bottom reaches the viewport
      // bottom. Guard the zero case: a short page would divide by nothing.
      const travel = rect.height - window.innerHeight;
      const next = travel <= 0 ? 0 : Math.min(1, Math.max(0, -rect.top / travel));
      /*
       * How much scrolling is worth a redraw.
       *
       * Every change here rebuilds the whole scene: the camera has moved, so
       * the cached frame is stale and five thousand stars are reprojected. At
       * a twentieth of this the page was rebuilding on scroll noise finer than
       * the movement it produced, which a phone absorbs and a tablet does not,
       * having about two and a half times the pixels to fill.
       *
       * Measured on an 834 by 1194 frame, scrolled end to end: the ninety
       * fifth percentile frame went from 83 ms to 50 ms. Wider than this the
       * gain flattens and the sky starts to pan in visible steps, which trades
       * a stutter for a judder.
       */
      if (Math.abs(next - last.current) < 0.002) return;
      last.current = next;
      setProgress(next);
    };

    const request = () => {
      if (frame.current) return;
      frame.current = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener('scroll', request, { passive: true });
    window.addEventListener('resize', request);
    return () => {
      window.removeEventListener('scroll', request);
      window.removeEventListener('resize', request);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [ref]);

  return progress;
}

/**
 * Maps a slice of overall progress onto its own 0–1 range.
 *
 * Sections need to animate across the part of the scroll where they are on
 * screen, not across the whole page, and clamping rather than extrapolating
 * keeps a section settled once its slice is behind us.
 */
export function span(progress: number, from: number, to: number): number {
  if (to <= from) return 0;
  return Math.min(1, Math.max(0, (progress - from) / (to - from)));
}

/** Slow in, slow out. Mechanical rather than bouncy, to match the instrument. */
export function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
