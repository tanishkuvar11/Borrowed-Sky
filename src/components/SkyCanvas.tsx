/**
 * The live sky.
 *
 * Every position drawn here is computed. Behind the objects sit three scene
 * layers that are also readings rather than backdrop: the galactic band on its
 * real bearing, the afterglow on the Sun's real azimuth, and — the one frank
 * exception — a stylised foreground of hills and water, fenced strictly below
 * the true horizon so it can never stand in front of anything real.
 *
 * The elevation scale down the right edge is the instrument's signature: it
 * reads out exactly how high the phone is aimed, the way an alidade tells you
 * where a theodolite is pointed. Heading is read off the compass strip below.
 */

import { useCallback, useEffect, useRef } from 'react';
import { MakeTime } from 'astronomy-engine';

import {
  buildHorizonBasis,
  buildViewMatrix,
  eqjToHorMatrix,
  horVector,
  projectionScale,
  type Camera,
  type Vec3,
  type ViewBasis,
} from '../lib/astro/frames';
import {
  STAR_COLORS,
  STAR_COLORS_NIGHT,
  starRadius,
  type ConstellationFigure,
  type StarCatalog,
} from '../lib/astro/starfield';
import { toObserver } from '../lib/astro/solar';
import { compassPoint } from '../lib/astro/satellites';
import { buildMilkyWay, type MilkyWayPatch } from '../lib/astro/milkyway';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';

/**
 * Fixed in J2000, so this is computed once for the life of the page rather than
 * per frame — the galaxy does not move on any timescale this app cares about.
 */
const MILKY_WAY = buildMilkyWay();

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/** A marker the user can tap, recorded during the draw so hit-testing is free. */
interface HitTarget {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface SkyCanvasProps {
  catalog: StarCatalog | null;
  constellations: ConstellationFigure[];
  bodies: SkyBody[];
  site: ObserverSite;
  now: Date;
  camera: Camera;
  conditions: SkyConditions | null;
  selectedId: string | null;
  showConstellations: boolean;
  showGrid: boolean;
  /** Draw the whole scene on a red-only ramp to preserve dark adaptation. */
  nightVision: boolean;
  onSelect: (id: string | null) => void;
  onPan: (deltaAzimuth: number, deltaAltitude: number) => void;
  onZoom: (factor: number) => void;
}

/**
 * The renderer's two palettes.
 *
 * Night-vision mode has to reach the canvas, not just the surrounding chrome —
 * the sky is most of the screen, and a bright blue field would undo the dark
 * adaptation the mode exists to protect. So the colours are data rather than
 * literals, and the whole scene is drawn from whichever set is active.
 */
interface SkyPalette {
  skyTop: [number, number, number];
  skyTopDay: [number, number, number];
  skyBottom: [number, number, number];
  skyBottomDay: [number, number, number];
  grid: string;
  ground: string;
  horizonHaze: string;
  horizonLine: string;
  /** Tint for the galactic band. Alpha is applied per patch at draw time. */
  milkyWay: [number, number, number];
  /** Afterglow on the Sun's real bearing: inner core, outer falloff. */
  glowCore: string;
  glowEdge: string;
  ridgeFar: string;
  ridgeNear: string;
  water: string;
  waterSheen: string;
  labelRing: string;
  labelLeader: string;
  labelName: string;
  labelData: string;
  cardinalMajor: string;
  cardinalMinor: string;
  figureLine: string;
  figureLabel: string;
  starGlow: string;
  starLabel: string;
  starColors: string[];
  moonShadow: string;
  selection: string;
  bodyLabel: string;
  satelliteLabel: string;
  satelliteEclipsed: string;
  tapeBackground: string;
  tapeRule: string;
  tickMajor: string;
  tickMinor: string;
  tapeLabel: string;
  index: string;
  bodies: Record<string, { fill: string; glow: string }>;
}

const DAY_PALETTE: SkyPalette = {
  skyTop: [7, 7, 15],
  skyTopDay: [24, 44, 96],
  skyBottom: [16, 12, 32],
  skyBottomDay: [86, 96, 150],
  grid: 'rgba(201, 162, 39, 0.13)',
  // Opaque on purpose: the ground has to stop the galactic band dead, or the
  // sky appears to continue through the earth.
  ground: 'rgb(6, 6, 14)',
  horizonHaze: 'rgba(7, 7, 15, 0.55)',
  horizonLine: 'rgba(201, 162, 39, 0.5)',
  milkyWay: [186, 178, 214],
  glowCore: 'rgba(224, 135, 155, ALPHA)',
  glowEdge: 'rgba(201, 162, 39, 0)',
  // Distant ridges are hazier and so lighter; the near ridge is a hard
  // silhouette. Aerial perspective, which is what sells the depth.
  ridgeFar: 'rgb(34, 27, 55)',
  ridgeNear: 'rgb(13, 10, 25)',
  water: 'rgb(18, 15, 36)',
  waterSheen: 'rgba(224, 152, 122, 0.3)',
  labelRing: 'rgba(232, 204, 122, 0.9)',
  labelLeader: 'rgba(201, 162, 39, 0.55)',
  labelName: 'rgba(242, 237, 224, 0.96)',
  labelData: 'rgba(201, 162, 39, 0.82)',
  cardinalMajor: 'rgba(232, 204, 122, 0.95)',
  cardinalMinor: 'rgba(201, 162, 39, 0.6)',
  figureLine: 'rgba(120, 170, 200, 0.26)',
  figureLabel: 'rgba(140, 180, 205, 0.5)',
  starGlow: 'rgba(242, 237, 224, ALPHA)',
  starLabel: 'rgba(207, 200, 184, 0.82)',
  starColors: STAR_COLORS,
  moonShadow: 'rgba(20, 20, 51, 0.86)',
  selection: 'rgba(232, 204, 122, 0.95)',
  bodyLabel: 'rgba(242, 237, 224, 0.92)',
  satelliteLabel: 'rgba(79, 216, 196, 0.95)',
  satelliteEclipsed: 'rgba(224, 135, 155, 0.85)',
  tapeBackground: 'rgba(7, 7, 15, 0.62)',
  tapeRule: 'rgba(201, 162, 39, 0.28)',
  tickMajor: 'rgba(232, 204, 122, 0.9)',
  tickMinor: 'rgba(201, 162, 39, 0.4)',
  tapeLabel: 'rgba(242, 237, 224, 0.9)',
  index: 'rgba(232, 204, 122, 1)',
  bodies: {
    sun: { fill: '#FFE9A8', glow: 'rgba(255, 216, 112, 0.55)' },
    moon: { fill: '#F2EDE0', glow: 'rgba(242, 237, 224, 0.35)' },
    planet: { fill: '#E8CC7A', glow: 'rgba(232, 204, 122, 0.30)' },
    satellite: { fill: '#4FD8C4', glow: 'rgba(79, 216, 196, 0.40)' },
  },
};

const NIGHT_PALETTE: SkyPalette = {
  skyTop: [8, 1, 1],
  skyTopDay: [46, 6, 4],
  skyBottom: [16, 3, 2],
  skyBottomDay: [78, 14, 10],
  grid: 'rgba(255, 106, 77, 0.13)',
  ground: 'rgb(5, 0, 0)',
  horizonHaze: 'rgba(8, 1, 1, 0.6)',
  horizonLine: 'rgba(255, 106, 77, 0.5)',
  milkyWay: [188, 82, 62],
  glowCore: 'rgba(194, 64, 47, ALPHA)',
  glowEdge: 'rgba(194, 64, 47, 0)',
  ridgeFar: 'rgb(48, 10, 7)',
  ridgeNear: 'rgb(15, 2, 1)',
  water: 'rgb(26, 5, 3)',
  waterSheen: 'rgba(255, 106, 77, 0.22)',
  labelRing: 'rgba(255, 122, 92, 0.9)',
  labelLeader: 'rgba(194, 64, 47, 0.6)',
  labelName: 'rgba(255, 156, 130, 0.96)',
  labelData: 'rgba(194, 64, 47, 0.9)',
  cardinalMajor: 'rgba(255, 122, 92, 0.95)',
  cardinalMinor: 'rgba(194, 64, 47, 0.7)',
  figureLine: 'rgba(190, 70, 52, 0.3)',
  figureLabel: 'rgba(190, 80, 62, 0.55)',
  starGlow: 'rgba(255, 130, 100, ALPHA)',
  starLabel: 'rgba(214, 112, 92, 0.85)',
  starColors: STAR_COLORS_NIGHT,
  moonShadow: 'rgba(24, 4, 3, 0.88)',
  selection: 'rgba(255, 122, 92, 0.95)',
  bodyLabel: 'rgba(255, 156, 130, 0.92)',
  satelliteLabel: 'rgba(255, 140, 110, 0.95)',
  satelliteEclipsed: 'rgba(150, 46, 34, 0.9)',
  tapeBackground: 'rgba(8, 1, 1, 0.66)',
  tapeRule: 'rgba(255, 106, 77, 0.28)',
  tickMajor: 'rgba(255, 122, 92, 0.9)',
  tickMinor: 'rgba(194, 64, 47, 0.45)',
  tapeLabel: 'rgba(255, 156, 130, 0.9)',
  index: 'rgba(255, 122, 92, 1)',
  bodies: {
    sun: { fill: '#FF9C82', glow: 'rgba(255, 106, 77, 0.5)' },
    moon: { fill: '#FF9C82', glow: 'rgba(255, 122, 92, 0.32)' },
    planet: { fill: '#F2704F', glow: 'rgba(255, 106, 77, 0.28)' },
    satellite: { fill: '#FF7A5C', glow: 'rgba(255, 122, 92, 0.4)' },
  },
};

/**
 * Palette for the frame currently being drawn.
 *
 * Module-scoped rather than threaded through a dozen draw calls: the whole
 * scene is painted in one synchronous pass, so this is set once at the top of
 * each frame and read by everything below it.
 */
let palette: SkyPalette = DAY_PALETTE;

export function SkyCanvas({
  catalog,
  constellations,
  bodies,
  site,
  now,
  camera,
  conditions,
  selectedId,
  showConstellations,
  showGrid,
  nightVision,
  onSelect,
  onPan,
  onZoom,
}: SkyCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const targetsRef = useRef<HitTarget[]>([]);

  // The draw loop reads these through a ref so a new frame never has to wait
  // for React to re-render — the canvas animates at its own rate.
  const stateRef = useRef({
    catalog,
    constellations,
    bodies,
    site,
    now,
    camera,
    conditions,
    selectedId,
    showConstellations,
    showGrid,
    nightVision,
  });
  stateRef.current = {
    catalog,
    constellations,
    bodies,
    site,
    now,
    camera,
    conditions,
    selectedId,
    showConstellations,
    showGrid,
    nightVision,
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let frame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;

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

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const s = stateRef.current;
      if (!width || !height) return;

      palette = s.nightVision ? NIGHT_PALETTE : DAY_PALETTE;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) / 2;
      const scale = projectionScale(s.camera.fov, radius);

      const targets: HitTarget[] = [];

      drawBackground(ctx, width, height, s.conditions);

      const observerObj = toObserver(s.site);
      const time = MakeTime(s.now);
      const eqjToHor = eqjToHorMatrix(time, observerObj);
      const view = buildViewMatrix(s.camera, eqjToHor);
      const horBasis = buildHorizonBasis(s.camera);

      // Project a horizontal-frame direction. Returns null when it falls behind
      // the viewer, where the stereographic projection is unbounded.
      const projectHor = (alt: number, az: number) => {
        const v = horVector(alt, az);
        return projectVector(v, horBasis, cx, cy, scale);
      };

      // Faintest first: the band sits behind everything, and the afterglow is
      // atmosphere in front of it but still behind every object.
      drawMilkyWay(ctx, MILKY_WAY, view, cx, cy, scale, width, height, s.conditions);
      drawAfterglow(ctx, projectHor, s.conditions, width, height);

      if (s.showGrid) drawAltAzGrid(ctx, projectHor);
      if (s.showConstellations && s.catalog) {
        drawConstellations(ctx, s.constellations, view, cx, cy, scale);
      }
      if (s.catalog) {
        drawStars(ctx, s.catalog, view, cx, cy, scale, radius, s.camera.fov, s.conditions, targets);
      }
      drawGround(ctx, horBasis, cx, cy, scale, width, height);
      drawScenery(ctx, horBasis, cx, cy, scale, width, height, s.conditions);
      drawHorizon(ctx, projectHor, width, height);
      drawCardinals(ctx, projectHor);
      drawBodies(ctx, s.bodies, horBasis, cx, cy, scale, width, height, s.selectedId, targets);

      // Heading is read off the compass strip below the canvas; what stays here
      // is the elevation scale, laid out linearly and calibrated against the
      // projection's exact rate at the index mark, the way a real tape is ruled.
      drawAltitudeTape(ctx, width, height, s.camera, scale * (Math.PI / 360));

      targetsRef.current = targets;

      // Canvas contents are invisible to the DOM, so in development the current
      // tap targets are published on the element for integration tests to aim at.
      // Stripped from production builds.
      if (import.meta.env.DEV) {
        (canvas as HTMLCanvasElement & { __targets?: HitTarget[] }).__targets = targets;
      }
    };

    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);

  // --- interaction ---------------------------------------------------------

  const dragRef = useRef<{ x: number; y: number; moved: number; pointers: Map<number, { x: number; y: number }> }>({
    x: 0,
    y: 0,
    moved: 0,
    pointers: new Map(),
  });
  const pinchRef = useRef<number | null>(null);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    const drag = dragRef.current;
    drag.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    drag.x = event.clientX;
    drag.y = event.clientY;
    drag.moved = 0;
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      if (!drag.pointers.has(event.pointerId)) return;
      drag.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

      // Two fingers: pinch to change field of view.
      if (drag.pointers.size === 2) {
        const [a, b] = [...drag.pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinchRef.current !== null && distance > 0) {
          onZoom(pinchRef.current / distance);
        }
        pinchRef.current = distance;
        return;
      }

      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.moved += Math.hypot(dx, dy);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const degreesPerPixel = camera.fov / rect.width;
      onPan(-dx * degreesPerPixel, dy * degreesPerPixel);
    },
    [camera.fov, onPan, onZoom],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      drag.pointers.delete(event.pointerId);
      if (drag.pointers.size < 2) pinchRef.current = null;

      // A tap, not a drag: pick whatever marker is nearest the finger.
      if (drag.moved < 8) {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;

        let best: HitTarget | null = null;
        let bestDistance = Infinity;
        for (const target of targetsRef.current) {
          const distance = Math.hypot(target.x - px, target.y - py);
          // Generous slop: fingers are wide and stars are small.
          if (distance < Math.max(target.radius + 18, 22) && distance < bestDistance) {
            best = target;
            bestDistance = distance;
          }
        }
        onSelect(best ? best.id : null);
      }
    },
    [onSelect],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLCanvasElement>) => {
      onZoom(event.deltaY > 0 ? 1.08 : 1 / 1.08);
    },
    [onZoom],
  );

  return (
    <canvas
      ref={canvasRef}
      className="sky-canvas"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
      aria-label="Live sky map. Drag to look around, pinch to zoom, tap an object to identify it."
      role="img"
    />
  );
}

// ---------------------------------------------------------------------------
// drawing
// ---------------------------------------------------------------------------

interface Projected {
  x: number;
  y: number;
  altitude: number;
}

function projectVector(
  v: Vec3,
  basis: { right: Vec3; up: Vec3; forward: Vec3 },
  cx: number,
  cy: number,
  scale: number,
): Projected | null {
  const Z = v.x * basis.forward.x + v.y * basis.forward.y + v.z * basis.forward.z;
  if (Z <= -0.92) return null; // effectively behind the viewer
  const X = v.x * basis.right.x + v.y * basis.right.y + v.z * basis.right.z;
  const Y = v.x * basis.up.x + v.y * basis.up.y + v.z * basis.up.z;
  const k = scale / (1 + Z);
  return { x: cx + X * k, y: cy - Y * k, altitude: Math.asin(Math.max(-1, Math.min(1, v.z))) / DEG };
}

/**
 * Sky colour follows the real Sun altitude, so the background is itself a
 * readout: it is dark because the Sun is down, not because dark looks nice.
 */
function drawBackground(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  conditions: SkyConditions | null,
) {
  const sunAltitude = conditions?.sunAltitude ?? -30;
  // 1 at full darkness, 0 in daylight.
  const darkness = Math.max(0, Math.min(1, (-sunAltitude - 2) / 16));

  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  const top = mixColor(palette.skyTopDay, palette.skyTop, darkness);
  const bottom = mixColor(palette.skyBottomDay, palette.skyBottom, darkness);
  gradient.addColorStop(0, `rgb(${top.join(',')})`);
  gradient.addColorStop(1, `rgb(${bottom.join(',')})`);
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
}

function mixColor(a: number[], b: number[], t: number): number[] {
  return a.map((v, i) => Math.round(v * (1 - t) + b[i] * t));
}

/** How dark the sky is, 0 in daylight to 1 at full night. */
function darknessFactor(conditions: SkyConditions | null): number {
  const sunAltitude = conditions?.sunAltitude ?? -30;
  return Math.max(0, Math.min(1, (-sunAltitude - 2) / 16));
}

/**
 * One soft blob, drawn once into an offscreen canvas and then stamped wherever
 * it is needed.
 *
 * Building a radial gradient is not cheap and the band needs hundreds of them
 * per frame. A gradient is fixed to the coordinates it was created with, so it
 * cannot be reused directly — but a pre-rendered sprite can be, and drawImage on
 * a cached bitmap is roughly an order of magnitude cheaper than filling a fresh
 * gradient. That difference is the whole reason the band can exist at all on the
 * hardware this is aimed at.
 */
let blobSprite: HTMLCanvasElement | null = null;
let blobSpriteTint = '';

function softBlob(tint: [number, number, number]): HTMLCanvasElement {
  const key = tint.join(',');
  if (blobSprite && blobSpriteTint === key) return blobSprite;

  const size = 64;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const g = sprite.getContext('2d');
  if (g) {
    const half = size / 2;
    const grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, `rgba(${key}, 0.55)`);
    grad.addColorStop(0.5, `rgba(${key}, 0.15)`);
    grad.addColorStop(1, `rgba(${key}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  blobSprite = sprite;
  blobSpriteTint = key;
  return sprite;
}

/**
 * The Milky Way.
 *
 * Positions come from the real galactic frame, so the band lies where the galaxy
 * actually is and the bright bulge sits towards Sagittarius. It fades out as the
 * sky brightens for the same reason it does outdoors — this is the faintest
 * thing the app draws, and the first to be lost to twilight or a bright Moon.
 */
function drawMilkyWay(
  ctx: CanvasRenderingContext2D,
  patches: MilkyWayPatch[],
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
  width: number,
  height: number,
  conditions: SkyConditions | null,
) {
  const darkness = darknessFactor(conditions);
  if (darkness < 0.12) return;

  // Moonlight washes the band out well before it touches the brighter stars.
  const moonWash =
    conditions && conditions.moonAltitude > 0
      ? 1 - 0.55 * conditions.moonIlluminatedFraction
      : 1;
  const ceiling = darkness * moonWash;
  if (ceiling < 0.05) return;

  const sprite = softBlob(palette.milkyWay);
  const pixelsPerDegree = scale * (Math.PI / 360);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';

  for (const patch of patches) {
    const point = projectEqj(patch.v.x, patch.v.y, patch.v.z, view, cx, cy, scale);
    if (!point) continue;

    const r = patch.size * pixelsPerDegree;
    if (r < 1) continue;
    if (point.x + r < 0 || point.x - r > width || point.y + r < 0 || point.y - r > height) continue;

    // Deliberately at the edge of visible. The real band is a faint glow you
    // have to be dark-adapted to notice, and drawing it any stronger turns the
    // sky into weather.
    ctx.globalAlpha = Math.min(0.14, patch.intensity * ceiling * 0.085);
    ctx.drawImage(sprite, point.x - r, point.y - r, r * 2, r * 2);
  }

  ctx.restore();
}

/**
 * The afterglow, on the bearing the Sun is actually on.
 *
 * Placed at the Sun's computed azimuth and scaled by its computed altitude, so
 * the warm patch low on the horizon points at where the Sun really went down.
 * Turn to face it and the glow stays put, which is the behaviour that makes it
 * a reading rather than a wallpaper.
 */
function drawAfterglow(
  ctx: CanvasRenderingContext2D,
  project: (alt: number, az: number) => Projected | null,
  conditions: SkyConditions | null,
  width: number,
  height: number,
) {
  if (!conditions) return;

  // Brightest around sunset and gone by the time the sky is properly dark; above
  // the horizon the sky gradient already carries the daylight.
  const depth = -conditions.sunAltitude;
  const strength = depth < -1 ? 0.55 : Math.max(0, 1 - Math.abs(depth - 2) / 13);
  if (strength <= 0.02) return;

  const anchor = project(0, conditions.sunAzimuth);
  if (!anchor) return;

  const reach = Math.max(width, height) * 0.75;
  if (
    anchor.x + reach < 0 ||
    anchor.x - reach > width ||
    anchor.y + reach < 0 ||
    anchor.y - reach > height
  ) {
    return;
  }

  const grad = ctx.createRadialGradient(anchor.x, anchor.y, 0, anchor.x, anchor.y, reach);
  grad.addColorStop(0, palette.glowCore.replace('ALPHA', (0.42 * strength).toFixed(3)));
  grad.addColorStop(0.35, palette.glowCore.replace('ALPHA', (0.16 * strength).toFixed(3)));
  grad.addColorStop(1, palette.glowEdge);

  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

/**
 * The screen-space circle of a given altitude.
 *
 * Stereographic projection maps every circle on the sphere to a circle in the
 * plane, so a line of constant altitude is exactly a circle and can be solved
 * for rather than traced. Substituting the inverse projection into
 * `zenith · v = sin(alt)` and collecting terms gives the centre and radius
 * below; `outside` says which side of it lies beneath that altitude.
 */
function altitudeCircle(
  basis: ViewBasis,
  altDeg: number,
  cx: number,
  cy: number,
  scale: number,
): { x: number; y: number; radius: number; outside: boolean } | null {
  const sinA = Math.sin(altDeg * DEG);
  const raw = basis.forward.z + sinA;

  /*
   * As the view levels off, this circle opens out towards a straight line and
   * its radius runs away to infinity. Rather than special-case the line — which
   * would mean a second code path for every fill and clip below — the divisor is
   * held just off zero. The circle that produces is enormous but finite, and
   * over the width of a phone screen it departs from the true straight line by
   * well under a pixel.
   *
   * Skipping the frame instead, which is what this used to do, meant the ground
   * disappeared whenever the phone was held level at the horizon.
   */
  const floor = 0.02;
  const d = Math.abs(raw) < floor ? (raw < 0 ? -floor : floor) : raw;

  const u0 = basis.right.z / d;
  const w0 = basis.up.z / d;
  const r2 = u0 * u0 + w0 * w0 + (basis.forward.z - sinA) / d;
  if (r2 <= 0) return null;

  return {
    x: cx + scale * u0,
    y: cy - scale * w0,
    radius: scale * Math.sqrt(r2),
    outside: d > 0,
  };
}

/**
 * Angles at which to sample a circle so the detail lands on screen.
 *
 * These circles are frequently vast — a nearly level view puts the centre tens
 * of thousands of pixels away — and at that size an evenly spaced walk around
 * the full turn spends every one of its samples off screen, leaving the arc that
 * is actually visible drawn as a single straight chord. So the arc subtending
 * the viewport gets the sample budget, and the remainder, which only has to
 * close the path for the fill, gets a handful.
 */
function arcSamples(
  circle: { x: number; y: number; radius: number },
  width: number,
  height: number,
  detail: number,
): number[] {
  const corners: [number, number][] = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  const inside = circle.x >= 0 && circle.x <= width && circle.y >= 0 && circle.y <= height;

  const angles = corners.map(([x, y]) => Math.atan2(y - circle.y, x - circle.x)).sort((a, b) => a - b);

  // The viewport spans the complement of the widest gap between corner angles.
  let gapStart = angles[3];
  let gapSize = angles[0] + TAU - angles[3];
  for (let i = 0; i < 3; i++) {
    const size = angles[i + 1] - angles[i];
    if (size > gapSize) {
      gapSize = size;
      gapStart = angles[i];
    }
  }

  const samples: number[] = [];
  if (inside || gapSize < 0.35) {
    for (let i = 0; i <= detail; i++) samples.push((i / detail) * TAU);
    return samples;
  }

  const from = gapStart + gapSize;
  const span = TAU - gapSize;
  const pad = span * 0.08;
  for (let i = 0; i <= detail; i++) samples.push(from - pad + ((span + 2 * pad) * i) / detail);
  // Close the loop back around the unseen side.
  const coarse = 24;
  for (let i = 1; i < coarse; i++) samples.push(from + span + pad + ((gapSize - 2 * pad) * i) / coarse);
  return samples;
}

/** Smooth periodic profile over azimuth — the same hills wherever you turn. */
function ridgeProfile(azDeg: number, phase: number): number {
  const a = azDeg * DEG;
  const value =
    0.5 * Math.sin(3 * a + phase) +
    0.3 * Math.sin(7 * a + phase * 1.7) +
    0.16 * Math.sin(13 * a + phase * 0.6) +
    0.09 * Math.sin(23 * a + phase * 2.3);
  return (value / 1.05 + 1) / 2; // → 0..1
}

/**
 * Foreground scenery: hills and water, below the horizon only.
 *
 * This is the one deliberately invented thing on the canvas, and it is fenced in
 * accordingly. It is drawn strictly beneath the true horizon — the brass line —
 * so it can never occlude a real object or imply a skyline that is not there.
 * Everything above that line is computed; this is the frame around it, and the
 * app says so.
 *
 * The silhouette is keyed to azimuth rather than to screen position, so the
 * hills stay put as you turn instead of sliding with the view.
 */
function drawScenery(
  ctx: CanvasRenderingContext2D,
  basis: ViewBasis,
  cx: number,
  cy: number,
  scale: number,
  width: number,
  height: number,
  conditions: SkyConditions | null,
) {
  const horizon = altitudeCircle(basis, 0, cx, cy, scale);
  if (!horizon) return;

  ctx.save();

  // Clip to the ground so no layer below can reach into the sky.
  pathBelow(ctx, horizon, width, height);
  ctx.clip();

  const layers: { alt: number; fill: string; relief: number; phase: number }[] = [
    { alt: -1.4, fill: palette.ridgeFar, relief: 1.0, phase: 0.0 },
    { alt: -4.5, fill: palette.ridgeNear, relief: 2.1, phase: 2.4 },
  ];

  for (const layer of layers) {
    const circle = altitudeCircle(basis, layer.alt, cx, cy, scale);
    if (!circle) continue;

    // Relief is capped in pixels so a wide field does not turn low hills into
    // mountains, and a narrow one does not flatten them away.
    const relief = Math.min(circle.radius * 0.06, Math.min(width, height) * 0.022 * layer.relief);

    ctx.beginPath();
    if (circle.outside) ctx.rect(0, 0, width, height);

    const thetas = arcSamples(circle, width, height, 200);
    for (let i = 0; i < thetas.length; i++) {
      const t = thetas[i];
      // Angle around the circle back to an azimuth, so the profile is world-locked.
      const px = circle.x + Math.cos(t) * circle.radius;
      const py = circle.y + Math.sin(t) * circle.radius;
      const u = (px - cx) / scale;
      const w = -(py - cy) / scale;
      const s = u * u + w * w;
      const k = 2 / (1 + s);
      const vx = u * k;
      const vy = w * k;
      const vz = (1 - s) / (1 + s);
      const north =
        vx * basis.right.x + vy * basis.up.x + vz * basis.forward.x;
      const west = vx * basis.right.y + vy * basis.up.y + vz * basis.forward.y;
      const az = (Math.atan2(-west, north) / DEG + 360) % 360;

      const r = circle.radius + relief * (ridgeProfile(az, layer.phase) - 0.5) * 2;
      const x = circle.x + Math.cos(t) * r;
      const y = circle.y + Math.sin(t) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();

    ctx.fillStyle = layer.fill;
    ctx.fill(circle.outside ? 'evenodd' : 'nonzero');
  }

  // Still water below the hills, catching the afterglow.
  const shore = altitudeCircle(basis, -8, cx, cy, scale);
  if (shore) {
    pathBelow(ctx, shore, width, height);
    ctx.fillStyle = palette.water;
    ctx.fill();

    // Water darkens towards the near shore: what it reflects there is the bank
    // behind you, not the sky. Without this it reads as a flat painted slab.
    const fade = ctx.createLinearGradient(0, height * 0.55, 0, height);
    fade.addColorStop(0, 'rgba(0, 0, 0, 0)');
    fade.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = fade;
    ctx.fill();

    if (conditions) {
      const depth = -conditions.sunAltitude;
      const strength = depth < -1 ? 0.5 : Math.max(0, 1 - Math.abs(depth - 2) / 13);
      if (strength > 0.02) {
        // The reflection sits on the Sun's bearing, mirrored below the horizon.
        const v = horVector(-6, conditions.sunAzimuth);
        const point = projectVector(v, basis, cx, cy, scale);
        if (point) {
          const reach = Math.min(width, height) * 0.6;
          const grad = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, reach);
          grad.addColorStop(0, palette.waterSheen);
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, width, height);
        }
      }
    }
  }

  ctx.restore();
}

function drawAltAzGrid(
  ctx: CanvasRenderingContext2D,
  project: (alt: number, az: number) => Projected | null,
) {
  ctx.strokeStyle = palette.grid;
  ctx.lineWidth = 1;

  // Circles of equal altitude.
  for (let alt = 0; alt <= 80; alt += 20) {
    strokePath(ctx, function* () {
      for (let az = 0; az <= 360; az += 3) yield project(alt, az);
    });
  }
  // Meridians of equal azimuth.
  for (let az = 0; az < 360; az += 30) {
    strokePath(ctx, function* () {
      for (let alt = 0; alt <= 88; alt += 3) yield project(alt, az);
    });
  }
}

/** Strokes a polyline, breaking it wherever a point falls behind the viewer. */
function strokePath(
  ctx: CanvasRenderingContext2D,
  points: () => Generator<Projected | null>,
) {
  ctx.beginPath();
  let drawing = false;
  let previous: Projected | null = null;
  for (const point of points()) {
    if (!point) {
      drawing = false;
      previous = null;
      continue;
    }
    // A large jump means the segment wrapped around the projection; break it.
    if (drawing && previous && Math.hypot(point.x - previous.x, point.y - previous.y) > 600) {
      drawing = false;
    }
    if (drawing) ctx.lineTo(point.x, point.y);
    else ctx.moveTo(point.x, point.y);
    drawing = true;
    previous = point;
  }
  ctx.stroke();
}

/** Traces the region below a given altitude. Leaves the path ready to fill or clip. */
function pathBelow(
  ctx: CanvasRenderingContext2D,
  circle: { x: number; y: number; radius: number; outside: boolean },
  width: number,
  height: number,
) {
  ctx.beginPath();
  if (circle.outside) {
    // The disc is the sky side, so fill the frame and punch the disc out with
    // the opposite winding.
    ctx.rect(0, 0, width, height);
    ctx.arc(circle.x, circle.y, circle.radius, 0, TAU, true);
  } else {
    ctx.arc(circle.x, circle.y, circle.radius, 0, TAU);
  }
}

/** Fills everything below the true horizon. */
function drawGround(
  ctx: CanvasRenderingContext2D,
  basis: ViewBasis,
  cx: number,
  cy: number,
  scale: number,
  width: number,
  height: number,
) {
  const horizon = altitudeCircle(basis, 0, cx, cy, scale);
  if (!horizon) return;

  ctx.save();
  ctx.fillStyle = palette.ground;
  pathBelow(ctx, horizon, width, height);
  ctx.fill();
  ctx.restore();
}

function drawHorizon(
  ctx: CanvasRenderingContext2D,
  project: (alt: number, az: number) => Projected | null,
  width: number,
  height: number,
) {
  // A soft band of haze just below the horizon, then the horizon itself.
  ctx.save();
  ctx.lineCap = 'round';

  ctx.strokeStyle = palette.horizonHaze;
  ctx.lineWidth = Math.max(24, Math.min(width, height) * 0.06);
  strokePath(ctx, function* () {
    for (let az = 0; az <= 360; az += 2) yield project(-1.4, az);
  });

  ctx.strokeStyle = palette.horizonLine;
  ctx.lineWidth = 1.4;
  strokePath(ctx, function* () {
    for (let az = 0; az <= 360; az += 2) yield project(0, az);
  });
  ctx.restore();
}

const CARDINALS: [number, string][] = [
  [0, 'N'],
  [45, 'NE'],
  [90, 'E'],
  [135, 'SE'],
  [180, 'S'],
  [225, 'SW'],
  [270, 'W'],
  [315, 'NW'],
];

function drawCardinals(
  ctx: CanvasRenderingContext2D,
  project: (alt: number, az: number) => Projected | null,
) {
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [az, label] of CARDINALS) {
    const point = project(2.5, az);
    if (!point) continue;
    const major = label.length === 1;
    ctx.font = `${major ? 700 : 500} ${major ? 13 : 11}px 'Cabinet Grotesk', system-ui, sans-serif`;
    ctx.fillStyle = major ? palette.cardinalMajor : palette.cardinalMinor;
    ctx.fillText(label, point.x, point.y);
  }
  ctx.restore();
}

function drawConstellations(
  ctx: CanvasRenderingContext2D,
  figures: ConstellationFigure[],
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
) {
  ctx.save();
  ctx.strokeStyle = palette.figureLine;
  ctx.lineWidth = 1;
  ctx.beginPath();

  for (const figure of figures) {
    const s = figure.segments;
    for (let i = 0; i < s.length; i += 6) {
      const a = projectEqj(s[i], s[i + 1], s[i + 2], view, cx, cy, scale);
      if (!a || a.altitude < 0) continue;
      const b = projectEqj(s[i + 3], s[i + 4], s[i + 5], view, cx, cy, scale);
      if (!b || b.altitude < 0) continue;
      if (Math.hypot(b.x - a.x, b.y - a.y) > 600) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
  }
  ctx.stroke();

  // Figure names, placed at the centroid and only when comfortably above the horizon.
  ctx.font = "500 10px 'Cabinet Grotesk', system-ui, sans-serif";
  ctx.fillStyle = palette.figureLabel;
  ctx.textAlign = 'center';
  ctx.letterSpacing = '0.14em';
  for (const figure of figures) {
    const v = figure.labelVector;
    const point = projectEqj(v.x, v.y, v.z, view, cx, cy, scale);
    if (!point || point.altitude < 12) continue;
    ctx.fillText(figure.name.toUpperCase(), point.x, point.y);
  }
  ctx.letterSpacing = '0px';
  ctx.restore();
}

function projectEqj(
  x: number,
  y: number,
  z: number,
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
): Projected | null {
  const Z = view[6] * x + view[7] * y + view[8] * z;
  if (Z <= -0.92) return null;
  const U = view[9] * x + view[10] * y + view[11] * z;
  const X = view[0] * x + view[1] * y + view[2] * z;
  const Y = view[3] * x + view[4] * y + view[5] * z;
  const k = scale / (1 + Z);
  return { x: cx + X * k, y: cy - Y * k, altitude: Math.asin(Math.max(-1, Math.min(1, U))) / DEG };
}

function drawStars(
  ctx: CanvasRenderingContext2D,
  catalog: StarCatalog,
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
  radius: number,
  fov: number,
  conditions: SkyConditions | null,
  targets: HitTarget[],
) {
  // Zooming in reveals fainter stars, the way more magnification would.
  const magLimit = Math.min(catalog.magLimit, 4.2 + Math.max(0, (70 - fov) / 70) * 2.3);
  const pixelScale = Math.max(0.75, Math.min(1.6, radius / 320));

  // In daylight the geometry is still correct but nothing is actually visible,
  // so the stars fade rather than implying you could see them.
  const sunAltitude = conditions?.sunAltitude ?? -30;
  const visibility = Math.max(0.16, Math.min(1, (-sunAltitude + 4) / 14));

  const buckets: number[][] = palette.starColors.map(() => []);
  const bright: { x: number; y: number; r: number; index: number }[] = [];

  const vectors = catalog.vectors;
  for (let i = 0; i < catalog.count; i++) {
    const mag = catalog.magnitude[i];
    // The catalogue is sorted brightest-first, so this exits early.
    if (mag > magLimit) break;

    const o = i * 3;
    const x = vectors[o];
    const y = vectors[o + 1];
    const z = vectors[o + 2];

    const U = view[9] * x + view[10] * y + view[11] * z;
    if (U <= 0) continue; // below the horizon
    const Z = view[6] * x + view[7] * y + view[8] * z;
    if (Z <= 0) continue; // behind the viewer

    const k = scale / (1 + Z);
    const px = cx + (view[0] * x + view[1] * y + view[2] * z) * k;
    const py = cy - (view[3] * x + view[4] * y + view[5] * z) * k;

    const r = starRadius(mag, magLimit, pixelScale);
    buckets[catalog.colorBucket[i]].push(px, py, r);

    if (mag < 1.6) bright.push({ x: px, y: py, r, index: i });
  }

  ctx.save();
  ctx.globalAlpha = visibility;
  for (let b = 0; b < buckets.length; b++) {
    const list = buckets[b];
    if (!list.length) continue;
    ctx.fillStyle = palette.starColors[b];
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 3) {
      const px = list[i];
      const py = list[i + 1];
      const r = list[i + 2];
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, TAU);
    }
    ctx.fill();
  }

  // The brightest stars get a halo and a name — the ones people actually use to
  // find their way around the sky.
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = "500 11px 'Cabinet Grotesk', system-ui, sans-serif";
  for (const star of bright) {
    const glow = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, star.r * 5);
    glow.addColorStop(0, palette.starGlow.replace('ALPHA', '0.5'));
    glow.addColorStop(1, palette.starGlow.replace('ALPHA', '0'));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(star.x, star.y, star.r * 5, 0, TAU);
    ctx.fill();

    const name = catalog.proper[star.index];
    if (name) {
      ctx.fillStyle = palette.starLabel;
      ctx.fillText(name, star.x + star.r + 7, star.y);
      // cx and cy are the frame centre, so 2cx and 2cy are its width and height.
      const onScreen =
        star.x > -24 && star.x < cx * 2 + 24 && star.y > -24 && star.y < cy * 2 + 24;
      if (onScreen) {
        targets.push({ id: `star-${star.index}`, x: star.x, y: star.y, radius: star.r });
      }
    }
  }
  ctx.restore();
}

/**
 * Sun, Moon, planets and satellites.
 *
 * These arrive already reduced to alt/az by the ephemeris, so unlike the star
 * catalogue they project through the horizontal basis directly.
 */
function drawBodies(
  ctx: CanvasRenderingContext2D,
  bodies: SkyBody[],
  basis: ViewBasis,
  cx: number,
  cy: number,
  scale: number,
  width: number,
  height: number,
  selectedId: string | null,
  targets: HitTarget[],
) {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  for (const body of bodies) {
    if (body.altitude < -2) continue;

    const point = projectVector(horVector(body.altitude, body.azimuth), basis, cx, cy, scale);
    if (!point) continue;

    const style =
      palette.bodies[body.kind === 'planet' ? 'planet' : body.kind] ?? palette.bodies.planet;

    // Marker size tracks brightness, with a floor so nothing becomes untappable.
    const size =
      body.kind === 'sun'
        ? 16
        : body.kind === 'moon'
          ? 14
          : body.kind === 'satellite'
            ? 5
            : Math.max(3.2, 7 - body.magnitude * 0.8);

    const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, size * 3.4);
    glow.addColorStop(0, style.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(point.x, point.y, size * 3.4, 0, TAU);
    ctx.fill();

    ctx.fillStyle = style.fill;
    ctx.beginPath();
    ctx.arc(point.x, point.y, size, 0, TAU);
    ctx.fill();

    // The Moon is drawn as an actual crescent, matching the computed phase.
    if (body.kind === 'moon' && body.illuminatedFraction !== undefined) {
      drawMoonPhase(ctx, point.x, point.y, size, body.illuminatedFraction);
    }

    // A satellite in Earth's shadow cannot be seen; say so rather than drawing
    // it as though it were shining.
    if (body.kind === 'satellite' && !body.sunlit) {
      ctx.strokeStyle = palette.satelliteEclipsed;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(point.x, point.y, size + 3, 0, TAU);
      ctx.stroke();
    }

    if (body.id === selectedId) {
      ctx.strokeStyle = palette.selection;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(point.x, point.y, size + 11, 0, TAU);
      ctx.stroke();
      // Engraved tick marks around the selection, like a reticle.
      for (let a = 0; a < 4; a++) {
        const angle = a * (TAU / 4) + TAU / 8;
        ctx.beginPath();
        ctx.moveTo(point.x + Math.cos(angle) * (size + 11), point.y + Math.sin(angle) * (size + 11));
        ctx.lineTo(point.x + Math.cos(angle) * (size + 17), point.y + Math.sin(angle) * (size + 17));
        ctx.stroke();
      }
    }

    // Only register something as tappable if it is actually on screen. A marker
    // projected off the edge is still drawn (harmlessly clipped) but must not
    // sit in the hit list, where it could win a tap near the border.
    const margin = size + 24;
    const onScreen =
      point.x > -margin &&
      point.x < width + margin &&
      point.y > -margin &&
      point.y < height + margin;

    if (onScreen) targets.push({ id: body.id, x: point.x, y: point.y, radius: size });

    // The label needs more room than the marker does: a leader and two lines of
    // text hanging off a marker that is itself past the edge leaves orphaned
    // words floating against the frame with nothing to point at.
    if (
      point.x > 4 &&
      point.x < width - 4 &&
      point.y > 12 &&
      point.y < height - 8
    ) {
      drawLeaderLabel(ctx, point.x, point.y, size, body, width);
    }
  }
  ctx.restore();
}

/**
 * The one-line reading that sits under a label.
 *
 * Chosen per kind for what is actually worth knowing about that object at a
 * glance: how bright a planet is, how far along the Moon is, and for a satellite
 * where to point, since it will not be there long.
 */
function readingFor(body: SkyBody): string {
  switch (body.kind) {
    case 'satellite':
      return `${body.sunlit ? '↑' : '·'} ${Math.round(body.altitude)}° ${compassPoint(body.azimuth)}`;
    case 'moon':
      return body.illuminatedFraction !== undefined
        ? `${Math.round(body.illuminatedFraction * 100)}% LIT`
        : `${Math.round(body.altitude)}° UP`;
    case 'sun':
      return `${Math.round(body.altitude)}° UP`;
    default:
      return `${body.magnitude > 0 ? '+' : ''}${body.magnitude.toFixed(1)} MAG`;
  }
}

/**
 * A marker's label, on a hairline leader.
 *
 * Set the way an engraved instrument names a part: a ring round the thing
 * itself, a fine line out to clear air, the name in the serif and the number
 * beneath it in the monospace. Splitting the two typefaces is what keeps a
 * reading from reading as prose.
 */
function drawLeaderLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  body: SkyBody,
  width: number,
) {
  // Lead away from the nearer edge so the text has room to sit.
  const dir = x > width * 0.62 ? -1 : 1;
  const ringRadius = size + 5;
  const rise = 13;
  const run = 26;

  const startX = x + dir * ringRadius * 0.72;
  const startY = y - ringRadius * 0.72;
  const kneeX = startX + dir * run;
  const kneeY = startY - rise;
  const endX = kneeX + dir * 14;

  ctx.save();

  ctx.strokeStyle = palette.labelRing;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, ringRadius, 0, TAU);
  ctx.stroke();

  ctx.strokeStyle = palette.labelLeader;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(kneeX, kneeY);
  ctx.lineTo(endX, kneeY);
  ctx.stroke();

  ctx.textAlign = dir > 0 ? 'left' : 'right';
  ctx.textBaseline = 'alphabetic';

  const textX = endX + dir * 5;
  ctx.font = "500 15px 'Newsreader', Georgia, serif";
  ctx.fillStyle = body.kind === 'satellite' ? palette.satelliteLabel : palette.labelName;
  ctx.fillText(body.name, textX, kneeY + 5);

  ctx.font = "500 9.5px 'IBM Plex Mono', ui-monospace, monospace";
  ctx.fillStyle = palette.labelData;
  ctx.letterSpacing = '0.08em';
  ctx.fillText(readingFor(body), textX, kneeY + 19);
  ctx.letterSpacing = '0px';

  ctx.restore();
}

function drawMoonPhase(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  illuminated: number,
) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, size, 0, TAU);
  ctx.clip();
  ctx.fillStyle = palette.moonShadow;
  // The terminator is an ellipse whose width tracks the illuminated fraction.
  const offset = (1 - 2 * illuminated) * size;
  ctx.beginPath();
  ctx.ellipse(x + offset, y, size, size, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** Altitude tape down the right edge: how far above the horizon you are aimed. */
function drawAltitudeTape(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: Camera,
  pixelsPerDegree: number,
) {
  const tapeWidth = 40;
  const x0 = width - tapeWidth;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, 0, tapeWidth, height);
  ctx.clip();

  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  for (let deg = -10; deg <= 90; deg += 5) {
    const y = height / 2 - (deg - camera.altitude) * pixelsPerDegree;
    if (y < 10 || y > height - 4) continue;

    const major = deg % 30 === 0;
    ctx.strokeStyle = major ? palette.tickMajor : palette.tickMinor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(width - (major ? 13 : 8), y);
    ctx.lineTo(width, y);
    ctx.stroke();

    if (major) {
      ctx.font = "500 10px 'IBM Plex Mono', monospace";
      ctx.fillStyle = palette.tapeLabel;
      ctx.fillText(`${deg}°`, width - 16, y);
    }
  }
  ctx.restore();
}
