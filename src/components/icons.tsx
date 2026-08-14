/**
 * Thin-line instrument icons.
 *
 * Drawn as strokes rather than filled shapes, so they read as engraving on the
 * brass rather than as app furniture. Everything inherits `currentColor`, which
 * is what lets the whole set turn red in night-vision mode without a second
 * copy of any of it.
 */

interface IconProps {
  size?: number;
  className?: string;
}

function frame({ size = 22, className }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    className,
    'aria-hidden': true,
    focusable: false,
  };
}

/** Sky: a sighting reticle. */
export function IconSky(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 1.6v3M12 19.4v3M1.6 12h3M19.4 12h3" />
    </svg>
  );
}

/** Explore: a refractor on its tripod. */
export function IconExplore(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M3.4 13.1 15.6 7.2a1.4 1.4 0 0 1 1.9.7l1 2.1a1.4 1.4 0 0 1-.7 1.9L5.6 17.8a1.4 1.4 0 0 1-1.9-.7l-1-2.1a1.4 1.4 0 0 1 .7-1.9Z" />
      <path d="m11.6 14.4 2 5.9M10.2 20.4h5.6M18.6 5.7l1.6-1.7M20.6 9.1l2.1-.6" />
    </svg>
  );
}

/** Tonight: the sky after dark. */
export function IconTonight(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M19.4 14.6A7.6 7.6 0 0 1 9.4 4.6a7.8 7.8 0 1 0 10 10Z" />
      <path d="M16.4 3.2l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7Z" />
    </svg>
  );
}

/** Logbook: an open journal. */
export function IconLogbook(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M12 6.6C10.3 5.3 8 4.7 4.2 4.7v12.6c3.8 0 6.1.6 7.8 1.9 1.7-1.3 4-1.9 7.8-1.9V4.7c-3.8 0-6.1.6-7.8 1.9Z" />
      <path d="M12 6.6v12.6" />
    </svg>
  );
}

/** Menu. Three rules, like the scale marks everywhere else. */
export function IconMenu(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <path d="M5 8h14M5 12h14M5 16h14" />
    </svg>
  );
}

/** Compass rose: the orientation control. */
export function IconCompassRose(props: IconProps) {
  return (
    <svg {...frame(props)}>
      <circle cx="12" cy="12" r="8.4" />
      <path d="m12 2.6 1.9 8.1L22 12l-8.1 1.9L12 21.4l-1.9-8.1L2 12l8.1-1.3Z" />
      <circle cx="12" cy="12" r="1.5" />
    </svg>
  );
}

/** The centre emblem: an astrolabe rete. */
export function IconEmblem({ size = 30, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      fill="none"
      stroke="currentColor"
      strokeWidth={0.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
      focusable={false}
    >
      <circle cx="20" cy="20" r="15.5" />
      <circle cx="20" cy="20" r="11.5" />
      <circle cx="20" cy="20" r="4.4" />
      {/* A nine-pointed star polygon, the way a rete is pierced. */}
      <path
        d={Array.from({ length: 9 }, (_, i) => {
          const a = (i * 4 * (360 / 9) - 90) * (Math.PI / 180);
          return `${i === 0 ? 'M' : 'L'}${(20 + Math.cos(a) * 11.5).toFixed(2)} ${(
            20 +
            Math.sin(a) * 11.5
          ).toFixed(2)}`;
        }).join(' ') + ' Z'}
      />
      <path d="M20 4.5v31M4.5 20h31" strokeWidth={0.6} />
    </svg>
  );
}

/** Armillary sphere: the guide's mark. */
export function IconArmillary({ size = 44, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      className={className}
      aria-hidden
      focusable={false}
    >
      <circle cx="24" cy="24" r="16" />
      <ellipse cx="24" cy="24" rx="16" ry="6" />
      <ellipse cx="24" cy="24" rx="6.5" ry="16" />
      <ellipse cx="24" cy="24" rx="16" ry="6" transform="rotate(-24 24 24)" />
      <path d="M24 8v32" strokeWidth={0.7} />
      <circle cx="24" cy="24" r="2.4" />
    </svg>
  );
}

/**
 * A working clock face for the readout panel.
 *
 * The hands are placed from the same instant the digits beside them are read
 * from, so the dial is a second presentation of the time rather than an
 * ornament that happens to look like one.
 */
export function ClockFace({ date, size = 40 }: { date: Date; size?: number }) {
  const hours = date.getHours() % 12;
  const minutes = date.getMinutes();
  const hourAngle = (hours + minutes / 60) * 30 - 90;
  const minuteAngle = minutes * 6 - 90;
  const hand = (angleDeg: number, length: number) => {
    const a = angleDeg * (Math.PI / 180);
    return `M24 24 L${(24 + Math.cos(a) * length).toFixed(2)} ${(24 + Math.sin(a) * length).toFixed(2)}`;
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      aria-hidden
      focusable={false}
    >
      <circle cx="24" cy="24" r="20" strokeWidth={1.1} />
      <circle cx="24" cy="24" r="17" strokeWidth={0.5} opacity={0.55} />
      {Array.from({ length: 12 }, (_, i) => {
        const a = (i * 30 - 90) * (Math.PI / 180);
        const major = i % 3 === 0;
        const r1 = major ? 13.5 : 15.5;
        return (
          <path
            key={i}
            d={`M${(24 + Math.cos(a) * r1).toFixed(2)} ${(24 + Math.sin(a) * r1).toFixed(2)} L${(
              24 +
              Math.cos(a) * 17.5
            ).toFixed(2)} ${(24 + Math.sin(a) * 17.5).toFixed(2)}`}
            strokeWidth={major ? 1.3 : 0.7}
          />
        );
      })}
      <path d={hand(hourAngle, 9)} strokeWidth={1.6} />
      <path d={hand(minuteAngle, 13.5)} strokeWidth={1} />
      <circle cx="24" cy="24" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}
