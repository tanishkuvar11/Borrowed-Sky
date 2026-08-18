/**
 * Where the observer's eye is sitting relative to the frame.
 *
 * Published as two CSS custom properties in the range −1…1, which the optics
 * layer uses to shift the field stop and the vignette by a few pixels as the
 * pointer moves across the glass.
 *
 * This is the only parallax in the app, and it is deliberately the only one.
 * Everything above the horizon is at a computed position: a star is drawn where
 * the projection says it is, and nudging it a few pixels towards the cursor to
 * manufacture depth would be inventing a measurement, which is the one thing
 * this app does not do. What genuinely does move when you shift your eye across
 * an eyepiece is the optics — the field stop and the falloff are fixed to the
 * instrument, not to the sky, so they slide against it. Moving those is honest
 * and produces the same sense of depth, because the depth cue the eye is
 * actually reading is the relative motion, not which layer moved.
 *
 * Written to the DOM rather than to React state on purpose. This fires on every
 * pointer move, and a re-render per move would cost the whole tree; a custom
 * property write inside one animation frame costs a compositor transform.
 */

import { useEffect } from 'react';

export function useEyePosition(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    // A pointer that cannot hover has no eye position to report, and a phone
    // would only ever get this from a drag, where the sky is already moving.
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const root = document.documentElement;
    let frame = 0;
    let pending: { x: number; y: number } | null = null;

    const apply = () => {
      frame = 0;
      if (!pending) return;
      root.style.setProperty('--eye-x', pending.x.toFixed(4));
      root.style.setProperty('--eye-y', pending.y.toFixed(4));
      pending = null;
    };

    const onMove = (event: PointerEvent) => {
      pending = {
        x: (event.clientX / window.innerWidth) * 2 - 1,
        y: (event.clientY / window.innerHeight) * 2 - 1,
      };
      // Coalesced into one write per frame; pointermove can fire far faster.
      if (!frame) frame = requestAnimationFrame(apply);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty('--eye-x');
      root.style.removeProperty('--eye-y');
    };
  }, [enabled]);
}
