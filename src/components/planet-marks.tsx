/**
 * Little portraits of the planets, for the object list.
 *
 * A row that says "Saturn" and shows a dot says the same thing about Saturn as
 * it does about Neptune, and the whole point of the list is that these are
 * different worlds. So each one is drawn as itself: the colours are the ones
 * the planet actually shows in a small telescope, the banding runs the way the
 * banding runs, and Saturn gets its rings at something close to their real
 * proportion and tilt.
 *
 * These are illustrations, and the app is careful about that distinction. They
 * carry no measurement: nothing here is read off, scaled to, or derived from a
 * computed quantity, and every number the user is actually shown comes from
 * the ephemeris and is set in the readout face. What this is doing is telling
 * two rows apart at a glance, which is a job for a picture.
 */

const MARKS: Record<string, (id: string) => JSX.Element> = {
  /*
   * Saturn: the ring plane passes behind the globe at the top and in front of
   * it at the bottom, which is the single detail that makes a ringed planet
   * read as a solid body with a ring around it rather than a circle with a
   * line through it. The globe is drawn between the two halves to get it.
   */
  Saturn: (id) => (
    <>
      <defs>
        <linearGradient id={`${id}-globe`} x1="0.25" y1="0" x2="0.8" y2="1">
          <stop offset="0%" stopColor="#f6e2b4" />
          <stop offset="42%" stopColor="#d9b877" />
          <stop offset="78%" stopColor="#8d6c38" />
          <stop offset="100%" stopColor="#4a3618" />
        </linearGradient>
        <linearGradient id={`${id}-ring`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#6b5326" />
          <stop offset="24%" stopColor="#e6ce97" />
          <stop offset="52%" stopColor="#b99a55" />
          <stop offset="78%" stopColor="#efdcae" />
          <stop offset="100%" stopColor="#5d4720" />
        </linearGradient>
        {/* Everything above the globe's centre line: the far half of the ring. */}
        <clipPath id={`${id}-far`}>
          <rect x="0" y="0" width="48" height="24" />
        </clipPath>
        <clipPath id={`${id}-near`}>
          <rect x="0" y="24" width="48" height="24" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${id}-far)`}>
        <ellipse
          cx="24"
          cy="24"
          rx="21"
          ry="6"
          fill="none"
          stroke={`url(#${id}-ring)`}
          strokeWidth="4.2"
          transform="rotate(-16 24 24)"
        />
      </g>

      <circle cx="24" cy="24" r="11.5" fill={`url(#${id}-globe)`} />
      {/* Belts. Faint, and following the globe's curve rather than straight. */}
      <path
        d="M13.4 20.2a11.5 11.5 0 0 0 21.2 0"
        fill="none"
        stroke="#8d6c38"
        strokeWidth="0.9"
        opacity="0.45"
      />
      <path
        d="M12.9 26.6a11.5 11.5 0 0 0 22.2 0"
        fill="none"
        stroke="#8d6c38"
        strokeWidth="1.1"
        opacity="0.34"
      />

      <g clipPath={`url(#${id}-near)`}>
        <ellipse
          cx="24"
          cy="24"
          rx="21"
          ry="6"
          fill="none"
          stroke={`url(#${id}-ring)`}
          strokeWidth="4.2"
          transform="rotate(-16 24 24)"
        />
      </g>

      {/* The shadow the globe throws across the near side of its own rings. */}
      <ellipse
        cx="27"
        cy="30"
        rx="7"
        ry="3.4"
        fill="#0a0812"
        opacity="0.34"
        transform="rotate(-16 24 24)"
      />
    </>
  ),

  /*
   * Neptune: an almost featureless deep blue, which is what methane absorption
   * in a cold, quiet atmosphere actually looks like. The one marking is a
   * brighter band and a pale cloud streak, both of which Voyager saw.
   */
  Neptune: (id) => (
    <>
      <defs>
        <radialGradient id={`${id}-globe`} cx="0.34" cy="0.28" r="0.85">
          <stop offset="0%" stopColor="#7fb4f2" />
          <stop offset="38%" stopColor="#3a72c4" />
          <stop offset="76%" stopColor="#1c3f84" />
          <stop offset="100%" stopColor="#0a1738" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="14" fill={`url(#${id}-globe)`} />
      <path
        d="M11.4 18.6a14 14 0 0 0 25.2 0"
        fill="none"
        stroke="#9cc8f7"
        strokeWidth="1"
        opacity="0.3"
      />
      <path
        d="M11.8 30a14 14 0 0 0 24.4 0"
        fill="none"
        stroke="#0d2050"
        strokeWidth="1.6"
        opacity="0.4"
      />
    </>
  ),

  /*
   * Jupiter: the belts and zones are the planet's whole visual identity, and
   * the Great Red Spot sits in the South Equatorial Belt, below centre.
   */
  Jupiter: (id) => (
    <>
      <defs>
        <radialGradient id={`${id}-globe`} cx="0.34" cy="0.28" r="0.85">
          <stop offset="0%" stopColor="#f8e6c8" />
          <stop offset="44%" stopColor="#d8b489" />
          <stop offset="80%" stopColor="#8f6640" />
          <stop offset="100%" stopColor="#3d2716" />
        </radialGradient>
        <clipPath id={`${id}-disc`}>
          <circle cx="24" cy="24" r="14" />
        </clipPath>
      </defs>
      <circle cx="24" cy="24" r="14" fill={`url(#${id}-globe)`} />
      <g clipPath={`url(#${id}-disc)`} opacity="0.5">
        <rect x="8" y="16.5" width="32" height="2.4" fill="#8a5f3c" />
        <rect x="8" y="21.5" width="32" height="1.6" fill="#c69a6c" />
        <rect x="8" y="26" width="32" height="3" fill="#8a5f3c" />
        <rect x="8" y="31.5" width="32" height="1.8" fill="#9c7048" />
        <ellipse cx="19" cy="27.4" rx="3.4" ry="1.7" fill="#b8543a" opacity="0.85" />
      </g>
    </>
  ),

  /* Mars: iron oxide, and a polar cap bright enough to see from a garden. */
  Mars: (id) => (
    <>
      <defs>
        <radialGradient id={`${id}-globe`} cx="0.34" cy="0.28" r="0.85">
          <stop offset="0%" stopColor="#f4b183" />
          <stop offset="42%" stopColor="#c9663a" />
          <stop offset="80%" stopColor="#7d3418" />
          <stop offset="100%" stopColor="#33130a" />
        </radialGradient>
        <clipPath id={`${id}-disc`}>
          <circle cx="24" cy="24" r="12.5" />
        </clipPath>
      </defs>
      <circle cx="24" cy="24" r="12.5" fill={`url(#${id}-globe)`} />
      <g clipPath={`url(#${id}-disc)`}>
        <ellipse cx="22" cy="13.5" rx="7" ry="3" fill="#f2e4d6" opacity="0.7" />
        <ellipse cx="27" cy="27" rx="6" ry="3.4" fill="#5e2612" opacity="0.4" />
      </g>
    </>
  ),

  /* Venus: total cloud cover, so a smooth pale disc and nothing else. */
  Venus: (id) => (
    <>
      <defs>
        <radialGradient id={`${id}-globe`} cx="0.34" cy="0.28" r="0.85">
          <stop offset="0%" stopColor="#fff8e4" />
          <stop offset="46%" stopColor="#e8d2a0" />
          <stop offset="82%" stopColor="#a08a52" />
          <stop offset="100%" stopColor="#3c3018" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="13" fill={`url(#${id}-globe)`} />
    </>
  ),

  /* Mercury: airless, cratered, and the colour of dark basalt. */
  Mercury: (id) => (
    <>
      <defs>
        <radialGradient id={`${id}-globe`} cx="0.34" cy="0.28" r="0.85">
          <stop offset="0%" stopColor="#d6cfc4" />
          <stop offset="44%" stopColor="#948b7e" />
          <stop offset="82%" stopColor="#4e4740" />
          <stop offset="100%" stopColor="#1c1915" />
        </radialGradient>
        <clipPath id={`${id}-disc`}>
          <circle cx="24" cy="24" r="10.5" />
        </clipPath>
      </defs>
      <circle cx="24" cy="24" r="10.5" fill={`url(#${id}-globe)`} />
      <g clipPath={`url(#${id}-disc)`} opacity="0.3">
        <circle cx="20" cy="21" r="2.6" fill="#4e4740" />
        <circle cx="27" cy="27" r="1.8" fill="#4e4740" />
        <circle cx="22.5" cy="29" r="1.2" fill="#4e4740" />
      </g>
    </>
  ),

  /* Uranus: the same methane blue as Neptune but paler, and blank. */
  Uranus: (id) => (
    <>
      <defs>
        <radialGradient id={`${id}-globe`} cx="0.34" cy="0.28" r="0.85">
          <stop offset="0%" stopColor="#cdf3f2" />
          <stop offset="42%" stopColor="#8fd0d4" />
          <stop offset="80%" stopColor="#427e8c" />
          <stop offset="100%" stopColor="#12303a" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="13" fill={`url(#${id}-globe)`} />
    </>
  ),
};

/**
 * The fallback: a point of light with a sighting ring around it.
 *
 * Used for stars and satellites, and it is deliberately not a little globe.
 * A star has no disc at any magnification a person on the ground will reach,
 * and drawing one would be the first outright false statement in the app.
 */
function pointMark(id: string) {
  return (
    <>
      <defs>
        <radialGradient id={`${id}-halo`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0%" stopColor="#f7f0dc" stopOpacity="0.85" />
          <stop offset="45%" stopColor="#e8cc7a" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#e8cc7a" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="16" fill={`url(#${id}-halo)`} />
      <circle cx="24" cy="24" r="2.6" fill="#fdf8ea" />
      <circle
        cx="24"
        cy="24"
        r="11"
        fill="none"
        stroke="#c9a227"
        strokeWidth="0.7"
        opacity="0.45"
      />
    </>
  );
}

/**
 * The Moon, drawn at its computed phase.
 *
 * The one mark here that is not purely illustrative: the terminator follows
 * the illuminated fraction the ephemeris returns, so the thumbnail is showing
 * tonight's Moon rather than a generic one.
 */
function moonMark(id: string, illuminated: number) {
  const lit = Math.max(0, Math.min(1, illuminated));
  // The terminator is the projection of a circle, so it is an ellipse whose
  // half-width runs from +r at new, through 0 at half, to −r at full.
  const rx = Math.abs(1 - 2 * lit) * 12;
  const sweep = lit > 0.5 ? 0 : 1;

  return (
    <>
      <defs>
        <radialGradient id={`${id}-globe`} cx="0.36" cy="0.3" r="0.85">
          <stop offset="0%" stopColor="#fbf7ea" />
          <stop offset="55%" stopColor="#d8d2c2" />
          <stop offset="100%" stopColor="#8d8778" />
        </radialGradient>
      </defs>
      <circle cx="24" cy="24" r="12" fill="#141428" opacity="0.55" />
      <path
        d={`M24 12 A 12 12 0 0 1 24 36 A ${rx} 12 0 0 ${sweep} 24 12 Z`}
        fill={`url(#${id}-globe)`}
      />
      <circle cx="20" cy="20" r="2.4" fill="#a8a294" opacity="0.35" />
      <circle cx="27" cy="27" r="1.7" fill="#a8a294" opacity="0.3" />
    </>
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
  /*
   * SVG gradient ids are global to the document, so two marks on screen at once
   * would otherwise share whichever definition rendered last, and every planet
   * in the list would come out the colour of the first one.
   */
  const id = `mark-${kind}-${name.replace(/[^a-z0-9]/gi, '')}`;

  const body =
    kind === 'moon'
      ? moonMark(id, illuminatedFraction ?? 0.5)
      : (MARKS[name] ?? pointMark)(id);

  return (
    <svg
      className="planet-mark"
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
    >
      {body}
    </svg>
  );
}
