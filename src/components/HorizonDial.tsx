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

      const brassBright = readVar('--brass-bright', '#e8cc7a');
      /*
       * The dial is made of brass, not of shadow.
       *
       * It used to be a wash of the same dark the panels are built on, which
       * made it a translucent veil lying over the sky with stars coming through
       * it: something the renderer had done to the picture rather than an
       * object in front of it. An instrument is a thing you could pick up.
       *
       * So the surface is metal, mixed here from the same brass the rest of the
       * app is engraved in, and shaded rather than faded: full opacity all the
       * way down, with the brightness falling off as the curve turns away from
       * the light. That is what stops it having a bottom edge. A band that goes
       * to transparent shows the sky through its own far side; a band that goes
       * into shadow simply stops being lit, which is what a curved metal
       * surface does, and it meets the rail below in darkness rather than in a
       * line.
       *
       * Mixed from the token rather than written as a literal so night vision
       * takes it with everything else: --brass-rgb swaps to a red under that
       * mode, and a gold bar across the bottom of an otherwise red screen is
       * exactly the leak the mode exists to prevent.
       */
      const brassRgb = readVar('--brass-rgb', '201 162 39');
      const [baseR, baseG, baseB] = brassRgb.split(/[\s,]+/).map(Number);

      /** The brass at a given fraction of full light. Opaque unless told otherwise. */
      const metal = (light: number, alpha = 1) => {
        const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
        return `rgba(${clamp(baseR * light)}, ${clamp(baseG * light)}, ${clamp(baseB * light)}, ${alpha})`;
      };

      /*
       * Engraving is cut, not printed: a dark bed with a lit lower lip where
       * the tool broke the surface. Both are neutral rather than tinted, so
       * they read as depth in the metal under either palette.
       */
      const cut = 'rgba(0, 0, 0, 0.62)';
      const lip = 'rgba(255, 246, 214, 0.22)';

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      /*
       * A flat strip, not an arc.
       *
       * It was drawn as a very shallow curve, on the argument that the real
       * horizon is convex and that saying so made the band read as the edge of
       * a world rather than as a control. That argument was right about what
       * the curve said and wrong about what it cost: to show a sag of any
       * visible size the band has to be tall enough to contain it, and the
       * whole thing was taking a fifth of the frame to make a point about
       * geometry. A scale is a scale. This one is now a rule, and the sky above
       * it is what the frame is for.
       *
       * The centre and the normal are kept as values rather than folded away,
       * because everything below is written in terms of them and a flat line is
       * simply the case where the normal points straight down.
       */
      const centreX = width / 2;
      const crest = 1;

      /** The rule is level, so this is the same height everywhere along it. */
      const arcY = (_dx: number) => crest;

      const pixelsPerDegree = width / DEGREES_ACROSS;

      // Everything under the arc is the dial's face, and it is opaque: it has to
      // stop the sky dead, or the stars appear to carry on through the metal.
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(0, arcY(-centreX));
      for (let x = 0; x <= width; x += 6) ctx.lineTo(x, arcY(x - centreX));
      ctx.lineTo(width, height);
      ctx.lineTo(0, height);
      ctx.closePath();
      ctx.clip();

      /*
       * Lit along the rim and falling away below it. The stops are close
       * together at the top, because that is where a curved surface turns
       * fastest away from a light above it, and the eye reads the rate of that
       * falloff as curvature. Spread evenly it looks like a painted stripe.
       */
      /*
       * Tuned for the strip's height, which is a third of what it was.
       *
       * The old ramp went to almost black by the bottom, which is what a tall
       * band needs if it is to look like a surface curving away. Over 44px the
       * same ramp is just a dark bar: there is no room for a falloff to read as
       * one, and the marks cut into it disappear along with the light. So the
       * metal stays lit nearly all the way down and only turns at the very
       * bottom edge, where it meets the rail.
       */
      const fill = ctx.createLinearGradient(0, crest, 0, height);
      fill.addColorStop(0, metal(1.34));
      fill.addColorStop(0.12, metal(1.08));
      fill.addColorStop(0.55, metal(0.88));
      fill.addColorStop(0.85, metal(0.66));
      fill.addColorStop(1, metal(0.4));
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, width, height);

      /*
       * One pass of brushed grain along the arc. Machined brass is not a smooth
       * gradient, and without this the face reads as a shape filled in rather
       * than as a surface. Kept far enough down in opacity to be felt and not
       * seen.
       */
      ctx.globalAlpha = 0.05;
      ctx.strokeStyle = lip;
      ctx.lineWidth = 1;
      for (let offset = 4; offset < height; offset += 3) {
        ctx.beginPath();
        ctx.moveTo(0, crest + offset);
        ctx.lineTo(width, crest + offset);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

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

      // Light spilling off the top edge onto the sky behind it. Metal this
      // bright against a dark sky always carries a little of this, and without
      // it the object looks cut out and pasted on.
      ctx.strokeStyle = brassBright;
      ctx.globalAlpha = 0.16;
      ctx.lineWidth = 9;
      ctx.filter = 'blur(6px)';
      rim();
      ctx.filter = 'none';

      // The edge itself: the lit lip of the metal where it turns over.
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = metal(1.75);
      rim();
      ctx.restore();

      // --- the graduations ---------------------------------------------------

      const from = Math.floor(shown - DEGREES_ACROSS / 2) - 1;
      const to = Math.ceil(shown + DEGREES_ACROSS / 2) + 1;

      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';

      /*
       * Lettering, stamped rather than printed. Same trick as the ticks: the
       * lit lip a pixel below, the dark bed on top. The alpha in force when
       * this is called is the fade for that mark, so the whole scale falls away
       * towards the ends together.
       */
      const engrave = (text: string, x: number, y: number) => {
        const alpha = ctx.globalAlpha;
        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = lip;
        ctx.fillText(text, x, y + 1);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = cut;
        ctx.fillText(text, x, y);
      };

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
        /*
         * Falls away towards the ends, the way a curved card turns from you.
         * Held much higher than it was: these used to be light marks on a dark
         * wash, where a faint one still shows, and they are now cut into lit
         * metal, where a faint one is simply not there.
         */
        const edge = 1 - Math.min(1, Math.abs(x - centreX) / (width / 2));
        const fade = (0.3 + 0.7 * Math.min(1, edge * 2.2)) * (major ? 1 : medium ? 0.8 : 0.5);

        /* Ticks hang from the rule, and the lettering stands under them. */
        const dx = x - centreX;
        const y = arcY(dx);
        // Straight down. On a curve these leaned outwards with the card; on a
        // level rule leaning would be a flourish with nothing behind it.
        const nx = 0;
        const ny = 1;
        const len = major ? 9 : medium ? 6 : 3;

        /*
         * Cut twice: the lit lower lip first, then the dark bed of the groove
         * over it, offset by a pixel along the same normal the tick runs on.
         * That one pixel of disagreement is the whole difference between a line
         * drawn on brass and a line taken out of it.
         */
        ctx.globalAlpha = fade * 0.7;
        ctx.strokeStyle = lip;
        ctx.lineWidth = major ? 1.4 : 1;
        ctx.beginPath();
        ctx.moveTo(x + nx, y + ny);
        ctx.lineTo(x + nx * (len + 1), y + ny * (len + 1));
        ctx.stroke();

        ctx.globalAlpha = fade;
        ctx.strokeStyle = cut;
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
          /*
           * Below the rim, standing on the metal, rather than above it in the
           * sky. Stamped into the face is where a dial's lettering is; floating
           * over the horizon line it was a caption on the picture instead, and
           * it fought the object labels in the chart above for the same band of
           * empty sky.
           */
          if (Math.abs(offset) > 3) {
            ctx.font = "500 13px 'Cabinet Grotesk', system-ui, sans-serif";
            engrave(cardinal, x, y + 22);
          }
        } else if (medium && normalised % 30 === 0) {
          ctx.font = "400 10px 'Share Tech Mono', ui-monospace, monospace";
          engrave(String(normalised), x, y + 18);
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
