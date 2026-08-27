/**
 * What this device is actually doing, in its own words.
 *
 * Added because two rounds of tuning were done against headless Chrome on a
 * desktop and neither fixed the phone. Frame rate, render resolution and sensor
 * behaviour all differ enough between the two that measuring here and shipping
 * there is guessing, and the guesses were wrong. This reports the handful of
 * numbers that decide what the fix even is: whether panning is rough because
 * frames are slow or because the aim is, whether the renderer has quietly
 * dropped resolution to keep up, and whether the phone layout is in force at
 * all.
 *
 * Off unless asked for: append ?diag to the URL. It measures by watching —
 * its own frame loop, its own sensor listener, the canvas's own backing store —
 * so nothing it reports depends on the code it is reporting on, and nothing in
 * the app has to be modified to be observed.
 */

import { useEffect, useRef, useState } from 'react';

export function diagnosticsRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).has('diag');
}

interface Sample {
  fps: number;
  worst: number;
  css: string;
  backing: string;
  dpr: number;
  phoneCss: boolean;
  sensorHz: number;
  sensorSource: string;
  absolute: string;
  sky: string;
  /*
   * The raw compass, and the screen rotation it has to be corrected by.
   *
   * These were the missing rows. Everything above describes how hard the
   * device is working; none of it says what the compass is actually reporting,
   * which is the only thing that matters when the sky points the wrong way.
   */
  angle: string;
  euler: string;
  trueHeading: string;
}

export function Diagnostics() {
  const [sample, setSample] = useState<Sample | null>(null);
  const sensorRef = useRef({
    count: 0,
    absolute: 'none',
    source: 'none',
    alpha: null as number | null,
    beta: null as number | null,
    gamma: null as number | null,
    heading: null as number | null,
    accuracy: null as number | null,
  });

  useEffect(() => {
    /*
     * Count sensor arrivals independently of the app's own hook.
     *
     * A separate listener on the same events, so the rate reported is the
     * platform's rather than anything this app does with it. Passive, and it
     * never touches the reading.
     */
    const onEvent = (event: Event) => {
      const e = event as DeviceOrientationEvent & { webkitCompassHeading?: number };
      sensorRef.current.count += 1;
      sensorRef.current.source = event.type;
      sensorRef.current.absolute =
        typeof e.webkitCompassHeading === 'number'
          ? 'ios compass'
          : e.absolute
            ? 'yes'
            : 'no (relative)';
      sensorRef.current.alpha = e.alpha;
      sensorRef.current.beta = e.beta;
      sensorRef.current.gamma = e.gamma;
      sensorRef.current.heading =
        typeof e.webkitCompassHeading === 'number' ? e.webkitCompassHeading : null;
      const acc = (e as { webkitCompassAccuracy?: number }).webkitCompassAccuracy;
      sensorRef.current.accuracy = typeof acc === 'number' ? acc : null;
    };
    window.addEventListener('deviceorientation', onEvent);
    const hasAbsolute = 'ondeviceorientationabsolute' in window;
    if (hasAbsolute) window.addEventListener('deviceorientationabsolute', onEvent);

    let frame = 0;
    let last = performance.now();
    let windowStart = last;
    let frames = 0;
    let worst = 0;

    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = performance.now();
      const gap = now - last;
      last = now;
      frames += 1;
      // The worst frame in the window matters more than the average: a steady
      // 45 feels fine and a 60 with one 200ms hitch a second does not.
      if (gap > worst) worst = gap;

      if (now - windowStart < 1000) return;

      const canvas = document.querySelector<HTMLCanvasElement>('canvas.sky-canvas');
      const rect = canvas?.getBoundingClientRect();

      setSample({
        fps: Math.round((frames * 1000) / (now - windowStart)),
        worst: Math.round(worst),
        css: rect ? `${Math.round(rect.width)}x${Math.round(rect.height)}` : '-',
        backing: canvas ? `${canvas.width}x${canvas.height}` : '-',
        dpr: window.devicePixelRatio || 1,
        phoneCss: window.matchMedia('(max-width: 700px)').matches,
        sensorHz: Math.round((sensorRef.current.count * 1000) / (now - windowStart)),
        sensorSource: sensorRef.current.source,
        absolute: sensorRef.current.absolute,
        sky: `${window.innerWidth}x${window.innerHeight}`,
        angle: (() => {
          const modern = screen.orientation?.angle;
          const legacy = (window as unknown as { orientation?: number }).orientation;
          const type = screen.orientation?.type ?? '?';
          const used =
            typeof modern === 'number'
              ? `${modern} ${type}`
              : typeof legacy === 'number'
                ? `${((-legacy % 360) + 360) % 360} (window.orientation ${legacy})`
                : '0 (NEITHER AVAILABLE)';
          return used;
        })(),
        euler: (() => {
          const r = sensorRef.current;
          const n = (v: number | null) => (v === null ? '-' : v.toFixed(0));
          return `a ${n(r.alpha)}  b ${n(r.beta)}  g ${n(r.gamma)}`;
        })(),
        trueHeading: (() => {
          const r = sensorRef.current;
          if (r.heading === null) return 'NONE (no webkitCompassHeading)';
          return `${r.heading.toFixed(0)}  +/- ${r.accuracy === null ? '?' : r.accuracy}`;
        })(),
      });

      windowStart = now;
      frames = 0;
      worst = 0;
      sensorRef.current.count = 0;
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('deviceorientation', onEvent);
      if (hasAbsolute) window.removeEventListener('deviceorientationabsolute', onEvent);
    };
  }, []);

  if (!sample) return null;

  /*
   * The renderer halves its own backing store when frames run long, so the
   * ratio between the backing store and the CSS box says whether it has given
   * up resolution to keep up. Reported next to the frame rate because the two
   * only mean anything together: 60fps at a quarter of the pixels is a
   * different situation from 60fps at all of them.
   */
  const backing = sample.backing.split('x').map(Number)[0];
  const css = sample.css.split('x').map(Number)[0];
  const ratio = css ? (backing / css).toFixed(2) : '-';

  const rows: [string, string][] = [
    ['fps', `${sample.fps}   worst frame ${sample.worst}ms`],
    ['render', `${sample.backing} / ${sample.css} css = ${ratio}x  (dpr ${sample.dpr})`],
    ['viewport', `${sample.sky}   phone css: ${sample.phoneCss ? 'ON' : 'OFF'}`],
    ['sensor', `${sample.sensorHz} Hz   ${sample.sensorSource}`],
    ['north ref', sample.absolute],
    ['screen', sample.angle],
    ['euler', sample.euler],
    ['heading', sample.trueHeading],
    ['trusted', sample.absolute === 'ios compass' && sample.trueHeading.includes('/- -') ? 'NO (accuracy negative)' : 'yes'],
    ['dial', document.querySelector('.horizon__point')?.textContent?.trim() ?? '-'],
  ];

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        zIndex: 9999,
        padding: '6px 8px',
        margin: 4,
        font: '11px/1.45 ui-monospace, Menlo, Consolas, monospace',
        color: '#e8cc7a',
        background: 'rgba(2,2,6,0.86)',
        border: '1px solid rgba(232,204,122,0.4)',
        borderRadius: 6,
        pointerEvents: 'none',
        whiteSpace: 'pre',
      }}
    >
      {rows.map(([k, v]) => `${k.padEnd(10)} ${v}`).join('\n')}
    </div>
  );
}
