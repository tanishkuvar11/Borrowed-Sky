/**
 * The overture's small marks.
 *
 * Kept apart from `icons.tsx`, which holds the app's navigation and control
 * icons: these are decoration for one page, drawn to sit beside 11px type at a
 * hairline weight rather than to be tapped. All of them inherit `currentColor`
 * so the brass ramp and night-vision mode reach them without a second palette.
 */

interface MarkProps {
  size?: number;
}

/** Location. The reading it sits beside is a pair of coordinates. */
export function IconPin({ size = 12 }: MarkProps) {
  return (
    <svg
      className="overture__mark-icon"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 11c2.2-2.9 3.4-4.9 3.4-6.4A3.4 3.4 0 0 0 2.6 4.6C2.6 6.1 3.8 8.1 6 11Z" />
      <circle cx="6" cy="4.6" r="1.2" />
    </svg>
  );
}

/** The instant being rendered. */
export function IconClock({ size = 12 }: MarkProps) {
  return (
    <svg
      className="overture__mark-icon"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="4.6" />
      <path d="M6 3.4V6l1.9 1.1" />
    </svg>
  );
}

/** Sun depth. A disc below a line, because that is literally what it reports. */
export function IconSunHorizon({ size = 12 }: MarkProps) {
  return (
    <svg
      className="overture__mark-icon"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1 7.4h10" />
      <path d="M3.4 7.4a2.6 2.6 0 0 1 5.2 0" />
      <path d="M6 2.2v1.1M2.4 3.6l.8.8M9.6 3.6l-.8.8" />
    </svg>
  );
}

/**
 * A four-pointed star, for the ends of rules. Drawn with quadratic curves
 * rather than straight diagonals so the arms pinch at the waist, which is what
 * makes it read as a glint instead of as a plus sign.
 */
export function IconSpark({ size = 10 }: MarkProps) {
  return (
    <svg
      className="overture__mark-icon"
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M6 0c.35 3.6 2.05 5.3 6 6-3.95.7-5.65 2.4-6 6-.35-3.6-2.05-5.3-6-6 3.95-.7 5.65-2.4 6-6Z" />
    </svg>
  );
}
