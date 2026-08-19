/**
 * Portraits of the bodies the app can show, from photographs.
 *
 * These were drawings, and drawings were the wrong answer here. This app
 * refuses to invent anything above the horizon — every position, magnitude and
 * distance on the screen is computed, and the guide is fenced off from
 * producing a number of its own — and then it illustrated Saturn with a
 * hand-placed ellipse. However carefully drawn, that is a picture somebody made
 * up sitting inside a page whose entire argument is that nothing here is.
 *
 * So they are spacecraft photographs now: MESSENGER, Magellan, Viking, Hubble,
 * Voyager 2, the Lunar Reconnaissance Orbiter. All public domain, fetched and
 * cut out by scripts/fetch-bodies.mjs, with each one's source and author
 * recorded in public/bodies/credits.json beside the files.
 *
 * Two things are still drawn, and both for the same reason. A star has no
 * resolvable disc at any magnification a person on the ground will reach, so a
 * photograph of one would be the app's first outright false statement; it gets
 * a point of light in a sighting ring, which is what it is. A satellite seen
 * from a garden is likewise a moving point, not a spacecraft you can make out.
 */

/** Bodies there is a photograph for. Anything else falls back to a point. */
const PHOTOGRAPHED = new Set([
  'Mercury',
  'Venus',
  'Mars',
  'Jupiter',
  'Saturn',
  'Uranus',
  'Neptune',
]);

/**
 * The fallback: a point of light with a sighting ring around it.
 *
 * Deliberately not a little globe. See the note above about stars.
 */
function PointMark({ size }: { size: number }) {
  return (
    <svg
      className="planet-mark"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="point-halo" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#f7f0dc" stopOpacity="0.85" />
          <stop offset="45%" stopColor="#e8cc7a" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#e8cc7a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="16" fill="url(#point-halo)" />
      <circle cx="24" cy="24" r="2.6" fill="#fdf8ea" />
      <circle cx="24" cy="24" r="11" fill="none" stroke="#c9a227" strokeWidth="0.7" opacity="0.45" />
    </svg>
  );
}

/**
 * The Moon, photographed, at tonight's computed phase.
 *
 * The photograph is of a full Moon, because that is the one that shows the
 * whole nearside; the phase is the app's own, drawn over it. The terminator is
 * the projection of a circle onto a sphere, so it is an ellipse whose
 * half-width runs from the Moon's radius at new, through nothing at half, to
 * the radius again at full — which is why the sweep flips at the halfway
 * point rather than the ellipse simply narrowing.
 *
 * The unlit part is left very dark rather than cut away. The Moon does not
 * stop existing on its shadowed side, and a crescent floating with nothing
 * behind it reads as a shape rather than as a lit sphere.
 */
function MoonMark({ size, illuminated }: { size: number; illuminated: number }) {
  const lit = Math.max(0, Math.min(1, illuminated));
  const rx = Math.abs(1 - 2 * lit) * 24;
  const sweep = lit > 0.5 ? 0 : 1;

  return (
    <svg
      className="planet-mark"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <clipPath id="moon-lit">
          <path d={`M24 0 A 24 24 0 0 1 24 48 A ${rx} 24 0 0 ${sweep} 24 0 Z`} />
        </clipPath>
      </defs>
      {/* The shadowed side: present, and almost black. */}
      <circle cx="24" cy="24" r="23.5" fill="#0b0b16" opacity="0.92" />
      <image
        href="bodies/moon.png"
        x="0"
        y="0"
        width="48"
        height="48"
        clipPath="url(#moon-lit)"
        preserveAspectRatio="xMidYMid meet"
      />
    </svg>
  );
}

export function PlanetMark({
  name,
  kind,
  illuminatedFraction,
  size = 34,
}: {
  name: string;
  kind: string;
  illuminatedFraction?: number;
  size?: number;
}) {
  if (kind === 'moon') {
    return <MoonMark size={size} illuminated={illuminatedFraction ?? 0.5} />;
  }

  if (!PHOTOGRAPHED.has(name)) return <PointMark size={size} />;

  /*
   * Sized by the attributes rather than inline style, so the element occupies
   * its box before the photograph has loaded — otherwise every row in the
   * object column jumps sideways as the images arrive — and so a stylesheet
   * can still overrule it. The phone layout does exactly that: the same
   * portrait is drawn smaller there, and an inline width would have won.
   */

  return (
    <img
      className="planet-mark"
      src={`bodies/${name.toLowerCase()}.png`}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      loading="lazy"
      decoding="async"
      draggable={false}
    />
  );
}
