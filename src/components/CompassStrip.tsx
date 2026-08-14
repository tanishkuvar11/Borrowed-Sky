/**
 * The heading repeater: a brass-framed strip of compass card under the sky.
 *
 * Ruled at a fixed 96 degrees across the strip rather than borrowed from the
 * projection, because this is a separate instrument from the sky view, a
 * repeater reads the same however the chart above it is scaled, and a scale that
 * silently changed with the field of view would be unreadable.
 *
 * It is also the app's proof that orientation tracking is live. When the compass
 * is driving, the card slides; when it is not, the strip says so instead of
 * sitting still and looking broken.
 */

import { useEffect, useRef } from 'react';

const DEGREES_ACROSS = 96;

const CARDINALS: Record<number, string> = {
  0: 'N',
  45: 'NE',
  90: 'E',
  135: 'SE',
  180: 'S',
  225: 'SW',
  270: 'W',
  315: 'NW',
};

export function CompassStrip({ heading, live }: { heading: number; live: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const headingRef = useRef(heading);
  headingRef.current = heading;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let frame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

    // Eased follow. The card settles onto a new heading rather than snapping to
    // it, which is what makes a mechanical instrument feel damped instead of
    // twitchy, and it costs nothing, because the raw value is still the one
    // printed in the readout.
    let shown = headingRef.current;

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    const styles = getComputedStyle(document.documentElement);
    const readVar = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      if (!width || !height) return;

      // Chase the target the short way round, so passing north does not send
      // the card the wrong way through 359 degrees.
      let delta = headingRef.current - shown;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;
      shown = (shown + delta * 0.18 + 360) % 360;

      const brass = readVar('--brass', '#c9a227');
      const brassBright = readVar('--brass-bright', '#e8cc7a');
      const starlight = readVar('--starlight', '#f2ede0');

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      const pixelsPerDegree = width / DEGREES_ACROSS;
      const centre = width / 2;
      const baseline = height - 9;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      const from = Math.floor(shown - DEGREES_ACROSS / 2) - 1;
      const to = Math.ceil(shown + DEGREES_ACROSS / 2) + 1;

      for (let deg = from; deg <= to; deg++) {
        const normalised = ((deg % 360) + 360) % 360;
        if (normalised % 5 !== 0) continue;

        let offset = deg - shown;
        if (offset > 180) offset -= 360;
        if (offset < -180) offset += 360;
        const x = centre + offset * pixelsPerDegree;
        if (x < -24 || x > width + 24) continue;

        const cardinal = CARDINALS[normalised];
        const major = cardinal !== undefined;
        const medium = normalised % 10 === 0;

        // Fade towards the ends, the way a curved card falls away from you.
        const edge = 1 - Math.min(1, Math.abs(x - centre) / (width / 2));
        ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, edge * 2.4);

        ctx.strokeStyle = major ? brassBright : brass;
        ctx.lineWidth = major ? 1.3 : 1;
        ctx.beginPath();
        ctx.moveTo(x, baseline);
        ctx.lineTo(x, baseline - (major ? 12 : medium ? 8 : 5));
        ctx.stroke();

        if (major) {
          ctx.font = "700 13px 'Cabinet Grotesk', system-ui, sans-serif";
          ctx.fillStyle = starlight;
          ctx.fillText(cardinal, x, baseline - 17);
        } else if (medium && normalised % 30 === 0) {
          ctx.font = "500 10px 'IBM Plex Mono', ui-monospace, monospace";
          ctx.fillStyle = brass;
          ctx.fillText(String(normalised), x, baseline - 13);
        }
      }

      ctx.globalAlpha = 1;

      // The index: a fixed pointer the card runs beneath.
      ctx.fillStyle = brassBright;
      ctx.beginPath();
      ctx.moveTo(centre, 9);
      ctx.lineTo(centre - 6, 0.5);
      ctx.lineTo(centre + 6, 0.5);
      ctx.closePath();
      ctx.fill();
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={live ? 'compass-strip is-live' : 'compass-strip'}>
      <canvas ref={canvasRef} className="compass-strip__card" />
      <span className="compass-strip__boss" aria-hidden />
      <span className="visually-hidden" role="status">
        Heading {Math.round(heading)} degrees
        {live ? ', tracking your phone' : ', set by dragging'}
      </span>
    </div>
  );
}
