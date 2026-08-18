/**
 * The horizon: where the sky ends, ruled as a compass.
 *
 * This replaces a rectangular strip of compass card that sat under the sky in
 * its own frame. It worked, and it read as a navigation bar, because that is
 * what a full-width rectangle with content in it reads as no matter what the
 * content is. The heading is the same instrument either way; the difference is
 * whether it belongs to the scene.
 *
 * So it is drawn as an arc. The Earth's horizon is a circle seen from inside
 * it and it is very slightly convex from any real vantage point; exaggerating
 * that curve a little is enough to say "this is the edge of a world" rather
 * than "this is a control". The card slides along the arc, the graduations
 * stand perpendicular to it the way marks on a curved scale do, and the rim
 * carries a line of light because a horizon under a dark sky always does.
 *
 * It is still a repeater and not a projection. The scale is a fixed 96 degrees
 * across, borrowed from nothing, because a heading readout has to read the same
 * however the chart above it happens to be scaled; a scale that silently
 * changed with the field of view would be unreadable.
 *
 * It is also the app's proof that orientation tracking is live. When the
 * compass is driving, the card slides; when it is not, the strip says so rather
 * than sitting still and looking broken.
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

/** Which way round the compass a bearing is, as a name. */
function cardinalName(bearing: number): string {
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return points[Math.round((((bearing % 360) + 360) % 360) / 22.5) % 16];
}

export function HorizonDial({ heading, live }: { heading: number; live: boolean }) {
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

      /*
       * The arc. A very large radius, so the curve is a suggestion rather than
       * a bowl: sag works out at about a twenty-fifth of the width, which is
       * the amount that reads as "the ground falls away at the edges" without
       * reading as "this app is drawn on a ball".
       */
      const R = width * 3.2;
      const centreX = width / 2;
      const crest = height * 0.42;
      const centreY = crest + R;

      /** Height of the arc at a horizontal offset from the centre. */
      const arcY = (dx: number) => centreY - Math.sqrt(Math.max(0, R * R - dx * dx));

      const pixelsPerDegree = width / DEGREES_ACROSS;

      // Everything under the arc is ground, and ground is not translucent: it
      // has to stop the sky dead, or the stars appear to continue through it.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, arcY(-centreX));
      for (let x = 0; x <= width; x += 6) ctx.lineTo(x, arcY(x - centreX));
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.clip();

      const ground = ctx.createLinearGradient(0, crest, 0, height);
      ground.addColorStop(0, 'rgba(7, 7, 16, 0.82)');
      ground.addColorStop(0.28, 'rgba(4, 4, 11, 0.97)');
      ground.addColorStop(1, 'rgba(3, 3, 8, 1)');
      ctx.fillStyle = ground;
      ctx.fillRect(0, 0, width, height);
      ctx.restore();

      // The rim light. Two strokes: a wide, very faint one that is the airglow
      // sitting on the horizon, and a hairline that is the edge itself.
      const rim = () => {
        ctx.beginPath();
        ctx.moveTo(0, arcY(-centreX));
        for (let x = 0; x <= width; x += 4) ctx.lineTo(x, arcY(x - centreX));
        ctx.stroke();
      };

      ctx.save();
      ctx.lineCap = 'round';
      ctx.strokeStyle = brass;
      ctx.globalAlpha = 0.1;
      ctx.lineWidth = 9;
      ctx.filter = 'blur(6px)';
      rim();
      ctx.filter = 'none';

      /*
       * The edge itself, and held well below full. A hard bright gold line all
       * the way across is the loudest thing on the screen and turns the
       * horizon back into a rule; what is wanted is the light that collects
       * along an edge, which is faint and mostly noticed at the middle.
       */
      ctx.globalAlpha = 0.42;
      ctx.lineWidth = 1;
      ctx.strokeStyle = brassBright;
      rim();
      ctx.restore();

      // --- the graduations ---------------------------------------------------

      const from = Math.floor(shown - DEGREES_ACROSS / 2) - 1;
      const to = Math.ceil(shown + DEGREES_ACROSS / 2) + 1;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      for (let deg = from; deg <= to; deg++) {
        const normalised = ((deg % 360) + 360) % 360;
        if (normalised % 2 !== 0) continue;

        let offset = deg - shown;
        if (offset > 180) offset -= 360;
        if (offset < -180) offset += 360;
        const x = centreX + offset * pixelsPerDegree;
        if (x < -24 || x > width + 24) continue;

        const cardinal = CARDINALS[normalised];
        const major = cardinal !== undefined;
        const medium = normalised % 10 === 0;

        // Fade towards the ends, the way a curved card falls away from you.
        const edge = 1 - Math.min(1, Math.abs(x - centreX) / (width / 2));
        const fade = (0.15 + 0.85 * Math.min(1, edge * 2.2)) * (major ? 0.9 : medium ? 0.55 : 0.3);

        /*
         * Ticks stand perpendicular to the arc rather than straight down. On a
         * curve that is the whole difference between a scale engraved on the
         * instrument and a row of lines dropped on top of it: the marks at the
         * ends of a real dial lean outwards, because the dial does.
         */
        const dx = x - centreX;
        const y = arcY(dx);
        const lean = Math.asin(Math.max(-1, Math.min(1, dx / R)));
        const nx = Math.sin(lean);
        const ny = Math.cos(lean);
        const len = major ? 12 : medium ? 7 : 3.5;

        ctx.globalAlpha = fade;
        ctx.strokeStyle = major ? brassBright : brass;
        ctx.lineWidth = major ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + nx * len, y + ny * len);
        ctx.stroke();

        if (major) {
          /*
           * Except right under the index, where the dial is already printing
           * the same letter. Two E's a few pixels apart read as a rendering
           * fault, and the one on the dial is the one being pointed at.
           */
          if (Math.abs(offset) > 3) {
            ctx.font = "500 13px 'Cabinet Grotesk', system-ui, sans-serif";
            ctx.fillStyle = starlight;
            ctx.fillText(cardinal, x, y - 11);
          }
        } else if (medium && normalised % 30 === 0) {
          ctx.font = "400 10px 'Share Tech Mono', ui-monospace, monospace";
          ctx.fillStyle = brass;
          ctx.fillText(String(normalised), x, y - 9);
        }
      }

      ctx.globalAlpha = 1;
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={live ? 'horizon is-live' : 'horizon'}>
      <canvas ref={canvasRef} className="horizon__card" />

      {/*
        The index. A fixed dial the card runs beneath, carrying the one thing
        you actually want off this instrument: the name of the way you are
        facing, in words, over the mark it is measured at.
      */}
      <div className="horizon__index" aria-hidden>
        <span className="horizon__point">{cardinalName(heading)}</span>
        <span className="horizon__dial" />
      </div>

      <span className="visually-hidden" role="status">
        Heading {Math.round(heading)} degrees
        {live ? ', tracking your phone' : ', set by dragging'}
      </span>
    </div>
  );
}
