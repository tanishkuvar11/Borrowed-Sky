/**
 * The live sky.
 *
 * Every position drawn here is computed. Behind the objects sit three scene
 * layers that are also readings rather than backdrop: the galactic band on its
 * real bearing, the afterglow on the Sun's real azimuth, and (the one frank
 * exception) a stylised foreground of hills and water, fenced strictly below
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
import { nakedEyeLimit, skyQualityInput, toObserver } from '../lib/astro/solar';
import { compassPoint } from '../lib/astro/satellites';
import {
  buildDust,
  buildMilkyWay,
  type DustPatch,
  type MilkyWayPatch,
} from '../lib/astro/milkyway';

import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';

/**
 * Fixed in J2000, so this is computed once for the life of the page rather than
 * per frame; the galaxy does not move on any timescale this app cares about.
 */
const MILKY_WAY = buildMilkyWay();
const MILKY_WAY_DUST = buildDust();

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

/**
 * Whether the viewer has asked for less movement.
 *
 * Read once and then watched, because every idle animation in the renderer is
 * a decoration and none of them is worth making somebody ill. When this is on,
 * the scene still draws — it simply stops breathing.
 */
const REDUCED_MOTION =
  typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

function stillPreferred(): boolean {
  return REDUCED_MOTION?.matches ?? false;
}

/**
 * Atmospheric transparency, as a multiplier on the faintest things drawn.
 *
 * Real skies are not steady. Thin high cloud and changing humidity make the
 * limiting magnitude wander over minutes, and the band is always the first
 * thing to go and the first to come back. Two slow incommensurate periods, so
 * the cycle never obviously repeats.
 *
 * This modulates brightness only. Nothing here moves anything: an object's
 * position is computed, and nudging it to look alive would be inventing a
 * measurement, which is the one thing this app does not do.
 *
 * It reaches the bright stars' haloes and nothing else. The faint field and
 * the galactic band are cached between frames — that is what makes this scene
 * affordable at all — and breathing them would mean rebuilding both caches
 * sixty times a second to animate something at the very edge of perceptible.
 * The haloes are where it actually reads anyway.
 */
function seeingAt(ms: number): number {
  if (stillPreferred()) return 1;
  const t = ms / 1000;
  return 1 + 0.06 * Math.sin(t / 11.3) + 0.035 * Math.sin(t / 4.7 + 1.9);
}

/**
 * The frame the sky is painted on, between the moves that change it.
 *
 * Almost everything on this canvas is fixed until the view turns: the band,
 * the star field, the figure lines, the ground and the horizon do not care
 * what time it is at sixty hertz. Only the objects, their labels, the
 * scintillation and the reticle do. Redrawing the first group to animate the
 * second was costing about nine tenths of every frame, on a scene that a trace
 * showed to be almost entirely rasterisation.
 *
 * So the fixed part is rendered once into this and stamped until the key
 * changes. Opaque, because it carries the sky's own background, which means
 * stamping it also clears the frame.
 */
let sceneBuffer: HTMLCanvasElement | null = null;
let sceneKey = '';

/**
 * Where text has already been put this frame.
 *
 * The sky does not space its contents out for our convenience: two satellites
 * a degree apart will happily stack their names on top of each other, and
 * three overlapping words are worse than one word and two dots, because the
 * pile is unreadable *and* it hides that there are three things there. So
 * every label asks for its box first, and a label that cannot get one is not
 * drawn. The marker underneath it always is.
 *
 * Reserved in order of how much the label is worth: bodies, then the named
 * stars, then the figure names, which are the most replaceable because the
 * lines they sit on already say where the figure is.
 */
const labelSlots: { x: number; y: number; w: number; h: number }[] = [];

/** Takes the box if it is free. Returns false if something is already there. */
function claimLabel(x: number, y: number, w: number, h: number): boolean {
  // A little slack around each box, so two labels can be adjacent without
  // their descenders and capitals appearing to touch.
  const pad = 3;
  for (const slot of labelSlots) {
    if (
      x < slot.x + slot.w + pad &&
      x + w + pad > slot.x &&
      y < slot.y + slot.h + pad &&
      y + h + pad > slot.y
    ) {
      return false;
    }
  }
  labelSlots.push({ x, y, w, h });
  return true;
}

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
  /**
   * Where to point, asked at the moment of drawing.
   *
   * Present only while the compass is driving the view. A sensor reading is
   * not a frame — they arrive irregularly, and at a rate the platform picks —
   * so taking the aim from a prop meant the sky moved in the sensor's steps
   * and held still between them. Given this, the loop asks for an aim once per
   * frame instead, and the filter behind it advances by real elapsed time.
   *
   * When it is absent the `camera` prop is the aim, which is the case for
   * dragging, slewing and every desktop view.
   */
  sampleCamera?: (nowMs: number) => Camera;
  conditions: SkyConditions | null;
  selectedId: string | null;
  showConstellations: boolean;
  showGrid: boolean;
  /**
   * Panels floating over the canvas that labels must keep clear of.
   *
   * The label system can only see what the canvas drew, so it happily put a
   * satellite's name underneath the guide panel, where it is invisible and has
   * taken a slot a readable label could have used. These are read each frame
   * and reserved before anything else, which is the only way the two layers
   * can agree about space they cannot otherwise see.
   */
  obstacles?: React.RefObject<HTMLElement | null>[];
  /**
   * The measuring furniture: cardinal marks and the elevation tape. On in the
   * app, where the canvas is an instrument you read. Off on the overture, where
   * it is a view you look at and the scale would be chrome without a purpose.
   */
  chrome?: boolean;
  /**
   * Compass bearing to stand the Greenwich observatory silhouette on, or null.
   *
   * Scenery, in the same category as the hills and fenced the same way: drawn
   * inside the ground clip, so it lives strictly below the true horizon and can
   * never occlude a computed object. It exists for the overture, which is
   * always Greenwich and says so; the app proper passes null, because there it
   * would be putting a building on a horizon it knows nothing about.
   */
  landmarkAzimuth?: number | null;
  /**
   * How present the landmark is, 0 to 1.
   *
   * The horizon alone cannot decide this. Its projected circle changes sense as
   * the camera tilts, so the building is revealed and hidden again rather than
   * being covered once, and the caller is the only thing that knows how far
   * through the scroll it is.
   */
  landmarkFade?: number;
  /** Draw the whole scene on a red-only ramp to preserve dark adaptation. */
  nightVision: boolean;
  skyModel: boolean;
  onSelect: (id: string | null) => void;
  onPan: (deltaAzimuth: number, deltaAltitude: number) => void;
  onZoom: (factor: number) => void;
}

/**
 * The renderer's two palettes.
 *
 * Night-vision mode has to reach the canvas, not just the surrounding chrome.
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
  /**
   * The two ends of the galactic band's colour ramp. Every patch is drawn in a
   * mix of these set by its own temperature, so the reddened inner plane and
   * the bluer outer arms are painted as the different things they are.
   */
  milkyWayWarm: [number, number, number];
  milkyWayCool: [number, number, number];
  /** Afterglow on the Sun's real bearing: inner core, outer falloff. */
  glowCore: string;
  glowEdge: string;
  ridgeFar: string;
  /** The observatory silhouette on the far bank, and its roofline rim. */
  landmark: string;
  landmarkRim: string;
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
  /*
   * Daylight, lifted.
   *
   * These two were a dusk blue, so the app said "the Sun is up" over a sky
   * that looked like an hour after sunset. Everywhere else this project
   * refuses to show one thing and state another, and a daytime sky is not a
   * detail somebody has to squint at to notice.
   *
   * Not a real daylight blue, though, and that is the compromise rather than
   * an oversight. The whole interface is light on dark: brass rules, starlight
   * labels, faint markers. Paint a true sky behind that and the labels wash
   * out and the fainter objects go with them. This is as far up as the type
   * survives, which reads as day without costing the instrument its legibility.
   */
  skyTopDay: [24, 44, 96],
  skyBottom: [16, 12, 32],
  skyBottomDay: [86, 96, 150],
  grid: 'rgba(201, 162, 39, 0.13)',
  // Opaque on purpose: the ground has to stop the galactic band dead, or the
  // sky appears to continue through the earth.
  ground: 'rgb(6, 6, 14)',
  horizonHaze: 'rgba(7, 7, 15, 0.55)',
  horizonLine: 'rgba(201, 162, 39, 0.5)',
  milkyWayWarm: [255, 176, 88],
  milkyWayCool: [96, 122, 178],
  glowCore: 'rgba(224, 135, 155, ALPHA)',
  glowEdge: 'rgba(201, 162, 39, 0)',
  // Distant ridges are hazier and so lighter; the near ridge is a hard
  // silhouette. Aerial perspective, which is what sells the depth.
  ridgeFar: 'rgb(34, 27, 55)',
  landmark: 'rgb(6, 5, 13)',
  landmarkRim: 'rgba(255, 178, 120, ALPHA)',
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
  milkyWayWarm: [196, 84, 62],
  milkyWayCool: [140, 58, 46],
  glowCore: 'rgba(194, 64, 47, ALPHA)',
  glowEdge: 'rgba(194, 64, 47, 0)',
  ridgeFar: 'rgb(48, 10, 7)',
  landmark: 'rgb(6, 1, 1)',
  landmarkRim: 'rgba(255, 122, 92, ALPHA)',
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
  sampleCamera,
  conditions,
  selectedId,
  showConstellations,
  showGrid,
  obstacles,
  chrome = true,
  landmarkAzimuth = null,
  landmarkFade = 1,
  nightVision,
  skyModel,
  onSelect,
  onPan,
  onZoom,
}: SkyCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const targetsRef = useRef<HitTarget[]>([]);

  // The draw loop reads these through a ref so a new frame never has to wait
  // for React to re-render; the canvas animates at its own rate.
  const stateRef = useRef({
    catalog,
    constellations,
    bodies,
    site,
    now,
    camera,
    sampleCamera,
    conditions,
    selectedId,
    showConstellations,
    showGrid,
    obstacles,
    chrome,
    landmarkAzimuth,
    landmarkFade,
    nightVision,
    skyModel,
  });
  stateRef.current = {
    catalog,
    constellations,
    bodies,
    site,
    now,
    camera,
    sampleCamera,
    conditions,
    selectedId,
    showConstellations,
    showGrid,
    obstacles,
    chrome,
    landmarkAzimuth,
    landmarkFade,
    nightVision,
    skyModel,
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

    /*
     * How much of the device's pixel ratio the sky is actually drawn at.
     *
     * This scene is fill-bound and nothing else: a trace of a frame is 86%
     * rasterisation and 8% JavaScript, and the frame rate tracks the backing
     * store's area almost exactly. On a retina screen that means the honest
     * choice between "sharp" and "smooth" is being made by the device's pixel
     * ratio, which knows nothing about how hard this particular scene is.
     *
     * So it is measured instead. The renderer starts at full ratio and steps
     * down only if frames are genuinely arriving late, and steps back up when
     * there is headroom again. A fast machine sees no difference; a slow one
     * gets a slightly softer sky at a frame rate that does not stutter, which
     * is the right way round — the stars are points and the band is a diffuse
     * glow, and neither has detail that a fraction of a pixel was carrying.
     */
    const MAX_RATIO = Math.min(window.devicePixelRatio || 1, 2);

    /*
     * The ratios it is allowed to use, and why it is a list rather than a slide.
     *
     * Stepping down trades sharpness for frame rate, and it used to do that by
     * arithmetic: subtract a quarter, a half, three quarters. On a screen at a
     * ratio of two that produces 1.75, 1.5, 1.25, none of which divide into two.
     * The canvas is then drawn at one size and stretched to another by a
     * fraction, and a fractional resample is the blurriest thing this renderer
     * can do. A tablet sitting at 1.5 was drawing 1230 pixels across and
     * showing them on 1640, and it was reported, correctly, as everything
     * looking pixelated, text included, since the labels share that buffer.
     *
     * So the ladder has two rungs and both of them map cleanly: full, and half.
     * Half of two is one, which is an honest two-to-one and reads as slightly
     * soft rather than smeared.
     *
     * A display barely above one has no rung to fall to. Halving 1.25 would be
     * 0.625, far worse than the stutter it was meant to cure, so those keep
     * one rung and stay sharp at whatever rate they manage.
     */
    const RATIOS = MAX_RATIO > 1.5 ? [MAX_RATIO, MAX_RATIO / 2] : [MAX_RATIO];
    const MIN_RATIO = RATIOS[RATIOS.length - 1];
    let ratio = MAX_RATIO;

    const resize = () => {
      dpr = ratio;
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    /*
     * Frame pacing, as a rolling median over the last two seconds or so.
     *
     * Median rather than mean because a single garbage collection or a tab
     * switch should not be able to talk the renderer into dropping quality,
     * and a run of consecutive verdicts is required on top of that. The
     * thresholds leave a wide dead band between them: stepping down at worse
     * than about 42fps and up at better than about 55 means the two decisions
     * cannot chase each other.
     */
    const intervals: number[] = [];
    let lastFrameAt = 0;
    let fastRuns = 0;

    const pace = (now: number) => {
      if (lastFrameAt) intervals.push(now - lastFrameAt);
      lastFrameAt = now;
      if (intervals.length < 24) return;

      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[sorted.length >> 1];
      intervals.length = 0;

      if (median > 22 && ratio > MIN_RATIO) {
        /*
         * Down at once, and by however much is needed.
         *
         * The first version took a sample of ninety frames and wanted two
         * consecutive verdicts before moving one step — which on a machine
         * that was struggling meant the better part of a minute of stutter
         * before anything happened, and four of those before it arrived. The
         * whole point is to get out of trouble quickly; being cautious about
         * *entering* a lower resolution is caution in the wrong direction.
         *
         * The step is sized from how far over budget the frame is, so a
         * machine that is badly behind lands near the bottom immediately
         * instead of walking there.
         */
        // Down a rung. There is only ever one below full, so this lands there.
        ratio = MIN_RATIO;
        fastRuns = 0;
        resize();
      } else if (median < 17 && ratio < MAX_RATIO) {
        fastRuns += 1;
        // Slower to climb than to fall. Being briefly soft is a much smaller
        // fault than oscillating between sharp and soft every second.
        if (fastRuns >= 6) {
          fastRuns = 0;
          // Back up a rung, which is straight to full: the only step there is.
          ratio = MAX_RATIO;
          resize();
        }
      } else {
        fastRuns = 0;
      }
    };

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const s = stateRef.current;
      if (!width || !height) return;
      pace(performance.now());

      palette = s.nightVision ? NIGHT_PALETTE : DAY_PALETTE;

      const clock = performance.now();
      const seeing = seeingAt(clock);

      /*
       * Where the view points this frame.
       *
       * While the compass is live this is asked for rather than handed down,
       * so the aim advances on the display's clock instead of the sensor's.
       * Everything downstream reads `camera` and does not care which it got.
       */
      const camera = s.sampleCamera ? s.sampleCamera(clock) : s.camera;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.min(width, height) / 2;
      const scale = projectionScale(camera.fov, radius);

      const targets: HitTarget[] = [];
      labelSlots.length = 0;

      // The floating panels claim their space before any label asks for some.
      if (s.obstacles) {
        const frame = canvas.getBoundingClientRect();
        for (const ref of s.obstacles) {
          const el = ref.current;
          if (!el) continue;
          const box = el.getBoundingClientRect();
          if (!box.width || !box.height) continue;
          labelSlots.push({
            x: box.left - frame.left,
            y: box.top - frame.top,
            w: box.width,
            h: box.height,
          });
        }
      }

      const observerObj = toObserver(s.site);
      const time = MakeTime(s.now);
      const eqjToHor = eqjToHorMatrix(time, observerObj);
      const view = buildViewMatrix(camera, eqjToHor);
      const horBasis = buildHorizonBasis(camera);

      // Project a horizontal-frame direction. Returns null when it falls behind
      // the viewer, where the stereographic projection is unbounded.
      const projectHor = (alt: number, az: number) => {
        const v = horVector(alt, az);
        return projectVector(v, horBasis, cx, cy, scale);
      };

      /*
       * Everything the view holds still. Rounded where rounding is invisible —
       * the view matrix to three places is about a twentieth of a degree, and
       * the sky's brightness to two — so that sidereal drift and the ticking
       * clock rebuild this every several seconds rather than every frame.
       */
      const bw = Math.round(width * dpr);
      const bh = Math.round(height * dpr);
      let key = `${bw}x${bh}|${s.nightVision}|${s.showGrid}|${s.showConstellations}|${s.chrome}`;
      key += `|${(s.conditions?.sunAltitude ?? 0).toFixed(2)}`;
      key += `|${(s.conditions?.moonAltitude ?? 0).toFixed(1)}`;
      key += `|${(s.conditions?.moonIlluminatedFraction ?? 0).toFixed(2)}`;
      /*
       * The fitted reach, in the key by its value rather than its inputs. Two
       * different skies that the model scores the same should share a cached
       * scene, and a Moon climbing through a city sky should rebuild one.
       */
      const reach = s.skyModel ? eyeReach(s.site, s.conditions) : null;
      key += `|${s.skyModel ? (reach === null ? 'n' : reach.toFixed(2)) : 'off'}`;
      key += `|${s.landmarkAzimuth ?? 'n'}|${(s.landmarkFade ?? 1).toFixed(2)}`;
      for (let i = 0; i < 12; i++) key += `|${view[i].toFixed(3)}`;

      const scene = (sceneBuffer ??= document.createElement('canvas'));
      if (scene.width !== bw || scene.height !== bh) {
        scene.width = bw;
        scene.height = bh;
        sceneKey = '';
      }

      if (key !== sceneKey) {
        sceneKey = key;
        const g = scene.getContext('2d', { alpha: false });
        if (g) {
          g.setTransform(dpr, 0, 0, dpr, 0, 0);

          drawBackground(g, width, height, s.conditions);

          // Faintest first: the band sits behind everything, and the afterglow
          // is atmosphere in front of it but still behind every object.
          drawMilkyWay(
            g,
            MILKY_WAY,
            MILKY_WAY_DUST,
            view,
            cx,
            cy,
            scale,
            width,
            height,
            dpr,
            s.conditions,
            1,
          );
          drawAfterglow(g, projectHor, s.conditions, width, height);

          if (s.showGrid) drawAltAzGrid(g, projectHor);
          if (s.showConstellations && s.catalog) {
            drawConstellations(g, s.constellations, view, cx, cy, scale, s.conditions, s.chrome);
          }
          if (s.catalog) {
            drawStarField(
              g,
              s.catalog,
              view,
              cx,
              cy,
              scale,
              radius,
              camera.fov,
              s.conditions,
              s.chrome,
              dpr,
              reach,
            );
          }
          drawGround(g, horBasis, cx, cy, scale, width, height);
          drawScenery(
            g,
            horBasis,
            cx,
            cy,
            scale,
            width,
            height,
            s.conditions,
            s.landmarkAzimuth ?? null,
            s.landmarkFade ?? 1,
          );
          drawHorizon(g, projectHor, width, height);
          if (s.chrome) drawCardinals(g, projectHor);
        }
      }

      // One blit, in place of everything above it.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.drawImage(scene, 0, 0);
      ctx.restore();

      // --- and now only what actually changes between frames ---------------

      if (s.catalog) {
        drawStarHighlights(
          ctx,
          s.catalog,
          view,
          cx,
          cy,
          scale,
          radius,
          camera.fov,
          s.conditions,
          targets,
          s.chrome,
          clock,
          seeing,
        );
      }
      drawBodies(
        ctx,
        s.bodies,
        horBasis,
        cx,
        cy,
        scale,
        width,
        height,
        s.selectedId,
        targets,
        s.chrome !== false,
        clock,
        s.nightVision,
      );

      // Last, so they take whatever room the objects did not want.
      if (s.chrome && s.showConstellations && s.catalog) {
        drawFigureLabels(ctx, s.constellations, view, cx, cy, scale, s.conditions);
      }

      // Heading is read off the horizon dial below the canvas; what stays here
      // is the elevation scale, laid out linearly and calibrated against the
      // projection's exact rate at the index mark, the way a real tape is ruled.
      if (s.chrome) drawAltitudeArc(ctx, width, height, camera, scale * (Math.PI / 360));

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
 * cannot be reused directly, but a pre-rendered sprite can be, and drawImage on
 * a cached bitmap is roughly an order of magnitude cheaper than filling a fresh
 * gradient. That difference is the whole reason the band can exist at all on the
 * hardware this is aimed at.
 */
const blobSprites = new Map<string, HTMLCanvasElement>();

function softBlob(tint: [number, number, number]): HTMLCanvasElement {
  const key = tint.map(Math.round).join(',');
  const cached = blobSprites.get(key);
  if (cached) return cached;

  const size = 64;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const g = sprite.getContext('2d');
  if (g) {
    const half = size / 2;
    const grad = g.createRadialGradient(half, half, 0, half, half, half);
    /*
     * A tight core with a long tail, rather than a plain falloff.
     *
     * The band needs to be two things at once: an unresolved glow spread over
     * a wide area, and clumpy inside it. That used to be two passes over every
     * patch, the second one drawn at more than twice the radius — which is
     * five times the area, on nine hundred patches, every frame, and it cost
     * about half the frame budget on its own. The same shape lives in the
     * sprite for nothing.
     */
    grad.addColorStop(0, `rgba(${key}, 0.62)`);
    grad.addColorStop(0.18, `rgba(${key}, 0.34)`);
    grad.addColorStop(0.42, `rgba(${key}, 0.12)`);
    grad.addColorStop(0.68, `rgba(${key}, 0.04)`);
    grad.addColorStop(1, `rgba(${key}, 0)`);
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  /*
   * The cache is keyed on the rounded tint, and the band quantises its colour
   * ramp into a handful of steps precisely so this stays a handful of entries.
   * Anything that starts asking for arbitrary tints per frame would turn a
   * cache into a leak, so the ramp resolution is the thing that bounds it.
   */
  blobSprites.set(key, sprite);
  return sprite;
}

/**
 * How many steps the band's warm-to-cool ramp is quantised into.
 *
 * One sprite per step, so this is the whole cost of having the band be more
 * than one colour. Eight is past the point where the banding is visible on a
 * structure this diffuse.
 */
const BAND_STEPS = 8;

function bandSprite(step: number): HTMLCanvasElement {
  /*
   * Biased towards the warm end rather than mixed linearly. Compositing with
   * `lighter` already drags every overlap towards white, so a straight lerp
   * arrives on screen as grey everywhere except the extremes; pre-warming the
   * ramp is what buys back the colour the compositor takes out.
   */
  const t = Math.pow(step / (BAND_STEPS - 1), 0.6);
  const warm = palette.milkyWayWarm;
  const cool = palette.milkyWayCool;
  return softBlob([
    cool[0] + (warm[0] - cool[0]) * t,
    cool[1] + (warm[1] - cool[1]) * t,
    cool[2] + (warm[2] - cool[2]) * t,
  ]);
}

/**
 * The offscreen the band is assembled on before it reaches the sky.
 *
 * The dark nebulae have to remove band light and nothing else. Drawn straight
 * onto the frame they would have to be painted *over* the sky, which means
 * guessing the sky's colour underneath them and getting a dark smudge wherever
 * the guess was off. Composited here, they can simply subtract, and a cloud
 * with no band behind it correctly does nothing at all.
 */
let bandBuffer: HTMLCanvasElement | null = null;
let bandKey = '';

/**
 * The Milky Way.
 *
 * Positions come from the real galactic frame, so the band lies where the galaxy
 * actually is and the bright bulge sits towards Sagittarius. It fades out as the
 * sky brightens for the same reason it does outdoors: this is the faintest
 * thing the app draws, and the first to be lost to twilight or a bright Moon.
 */
function drawMilkyWay(
  ctx: CanvasRenderingContext2D,
  patches: MilkyWayPatch[],
  dust: DustPatch[],
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
  width: number,
  height: number,
  dpr: number,
  conditions: SkyConditions | null,
  seeing: number,
) {
  const darkness = darknessFactor(conditions);
  if (darkness < 0.12) return;

  // Moonlight washes the band out well before it touches the brighter stars.
  const moonWash =
    conditions && conditions.moonAltitude > 0
      ? 1 - 0.55 * conditions.moonIlluminatedFraction
      : 1;
  const ceiling = darkness * moonWash * seeing;
  if (ceiling < 0.05) return;

  /*
   * Assembled at half the frame's resolution and scaled up on the way out.
   *
   * The band has no detail at any scale a pixel could carry: it is hundreds of
   * overlapping soft blobs whose smallest feature is several pixels across, so
   * half resolution is visually identical and costs a quarter of the fill. On
   * a retina frame that is the difference between the band being affordable
   * and the band being the whole frame budget.
   */
  const bw = Math.round(width * dpr * 0.5);
  const bh = Math.round(height * dpr * 0.5);
  const bufferScale = dpr * 0.5;
  const buffer = (bandBuffer ??= document.createElement('canvas'));
  if (buffer.width !== bw || buffer.height !== bh) {
    buffer.width = bw;
    buffer.height = bh;
  }
  const band = buffer.getContext('2d');
  if (!band) return;

  /*
   * Rebuilt only when the view has actually moved.
   *
   * Same argument as the faint star field, and the band is the bigger
   * offender: nine hundred soft sprites and three hundred and sixty erasers,
   * none of which changes from one frame to the next unless the sky has turned
   * under them. What does change every frame is how brightly the finished band
   * is stamped, and that is applied at composite time, so twilight, moonlight
   * and the atmospheric breathing all still reach it for nothing.
   */
  let key = `${bw}x${bh}|${palette.milkyWayWarm.join(',')}`;
  for (let i = 0; i < 12; i++) key += `|${view[i].toFixed(3)}`;

  const stamp = () => {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // The one thing that does change every frame: how brightly it is stamped.
    ctx.globalAlpha = ceiling;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(buffer, 0, 0, Math.round(width * dpr), Math.round(height * dpr));
    ctx.restore();
  };

  if (key === bandKey) {
    stamp();
    return;
  }
  bandKey = key;

  band.setTransform(bufferScale, 0, 0, bufferScale, 0, 0);
  band.clearRect(0, 0, width, height);
  band.globalCompositeOperation = 'lighter';

  const pixelsPerDegree = scale * (Math.PI / 360);

  for (const patch of patches) {
    const point = projectEqj(patch.v.x, patch.v.y, patch.v.z, view, cx, cy, scale);
    if (!point) continue;

    const r = patch.size * pixelsPerDegree;
    if (r < 1) continue;
    if (point.x + r < 0 || point.x - r > width || point.y + r < 0 || point.y - r > height) continue;

    const sprite = bandSprite(Math.round(patch.temperature * (BAND_STEPS - 1)));

    /*
     * Contrast, applied as a gamma on the surface brightness.
     *
     * Drawn in proportion to intensity the band is technically right and
     * visually wrong: the faint outskirts cover an enormous solid angle, so
     * even at low alpha they sum into a haze that swallows the bright inner
     * plane and leaves the whole thing looking like cloud. Steepening the
     * response keeps the core and lets the edges fall away, which is what the
     * dark-adapted eye does too.
     */
    const weight = Math.pow(patch.intensity, 1.9);

    /*
     * Deliberately at the edge of visible: this is a
     * faint glow you have to be dark-adapted to notice, and drawn any stronger
     * it turns the sky into weather.
     *
     * The alpha is also held low so the colour survives. All of this is
     * composited with `lighter`, which climbs towards white wherever patches
     * overlap, and the band overlaps itself constantly; push it up and the
     * warm inner plane bleaches to the same grey as the outer arms, which is
     * the whole thing the colour ramp exists to avoid.
     */
    band.globalAlpha = Math.min(0.13, weight * 0.15);
    const spread = r * 1.5;
    band.drawImage(sprite, point.x - spread, point.y - spread, spread * 2, spread * 2);

    /*
     * A tight core on the densest patches only: the great star clouds, the
     * Sagittarius one above all. These are what make the band look like it is
     * made of stars rather than lit from behind, and they are genuinely small
     * and bright against the surrounding glow, so they get a pass of their own
     * instead of being averaged into it.
     */
    if (weight > 0.45) {
      const knot = r * 0.42;
      band.globalAlpha = Math.min(0.12, (weight - 0.45) * 0.3);
      band.drawImage(sprite, point.x - knot, point.y - knot, knot * 2, knot * 2);
    }
  }

  /*
   * Now take the dust back out. destination-out removes what the cloud covers
   * rather than painting darkness over it, so a cloud sitting on the bright
   * inner plane carves a lane and the same cloud over empty sky is invisible,
   * which is exactly how a dark nebula behaves.
   */
  band.globalCompositeOperation = 'destination-out';
  const eraser = dustSprite();
  for (const patch of dust) {
    const point = projectEqj(patch.v.x, patch.v.y, patch.v.z, view, cx, cy, scale);
    if (!point) continue;

    const r = patch.size * pixelsPerDegree;
    if (r < 1) continue;
    if (point.x + r < 0 || point.x - r > width || point.y + r < 0 || point.y - r > height) continue;

    /*
     * Held well below full. Subtracting a cloud outright is physically what a
     * dense core does, but the result on screen is an inkblot: a hard-edged
     * absence surrounded by glow, which reads as a rendering fault rather than
     * as dust. Leaving a little light through keeps it a lane.
     */
    band.globalAlpha = Math.min(0.34, patch.opacity * 0.42);
    band.drawImage(eraser, point.x - r, point.y - r, r * 2, r * 2);
  }

  stamp();
}

/**
 * The eraser the dark clouds are stamped with.
 *
 * Only its alpha matters, since destination-out reads nothing else, but it is
 * shaped harder than the band's own blob: a molecular cloud has a genuinely
 * opaque core and a ragged edge, not a smooth falloff from the middle.
 */
let DUST_SPRITE: HTMLCanvasElement | null = null;

function dustSprite(): HTMLCanvasElement {
  if (DUST_SPRITE) return DUST_SPRITE;
  const size = 64;
  const sprite = document.createElement('canvas');
  sprite.width = size;
  sprite.height = size;
  const g = sprite.getContext('2d');
  if (g) {
    const half = size / 2;
    const grad = g.createRadialGradient(half, half, 0, half, half, half);
    grad.addColorStop(0, 'rgba(0, 0, 0, 1)');
    grad.addColorStop(0.45, 'rgba(0, 0, 0, 0.86)');
    grad.addColorStop(0.75, 'rgba(0, 0, 0, 0.32)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  }
  DUST_SPRITE = sprite;
  return sprite;
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
   * its radius runs away to infinity. Rather than special-case the line, which
   * would mean a second code path for every fill and clip below, the divisor is
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
 * These circles are frequently vast (a nearly level view puts the centre tens
 * of thousands of pixels away) and at that size an evenly spaced walk around
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

/**
 * Built once. Path2D takes SVG path data directly, so the traced roofline is
 * parsed a single time and then only transformed per frame.
 */
/**
 * The Royal Observatory foreground, as a photograph rather than a drawing.
 *
 * An earlier version traced the roofline into an SVG path and filled it. It
 * was accurate and it looked like a wireframe, because a building at dusk is
 * read from its texture and its mass, not its outline. This is the real
 * photograph with the sky cut out of it: every pixel above the roofline is
 * transparent, so the image contributes ground and never sky, and what remains
 * is crushed towards a silhouette so it sits in the page's own twilight.
 *
 * Loaded once, drawn when ready. Until then the hero simply has no landmark in
 * it, which is the correct failure: an empty foreground, never a fake one.
 */
const OBSERVATORY_IMAGE: HTMLImageElement | null =
  typeof Image === 'undefined' ? null : new Image();
if (OBSERVATORY_IMAGE) OBSERVATORY_IMAGE.src = 'scenery/observatory.png';


/**
 * The observatory on the far bank.
 *
 * Called from inside the ground clip, so the whole building lives below the
 * true horizon and the brass line passes above the roof rather than behind it.
 * Nothing here can occlude a star.
 *
 * Placed on a bearing rather than at a screen position, so it stays put on the
 * landscape as the camera turns and leaves the frame when you look away from
 * it, the way the hills already do. The transform is built from two altitudes
 * on that bearing, which keeps the building standing upright as the projection
 * rotates things near the edges of a wide field.
 */
function drawObservatory(
  ctx: CanvasRenderingContext2D,
  basis: ViewBasis,
  cx: number,
  cy: number,
  scale: number,
  width: number,
  height: number,
  azimuth: number,
  fade: number,
) {
  const img = OBSERVATORY_IMAGE;
  if (fade <= 0.01) return;
  if (!img || !img.complete || !img.naturalWidth) return;

  /*
   * Placed rather than projected.
   *
   * Standing this on a compass bearing was tried at length and it is the wrong
   * tool. The bearing decides a position and a rotation that both run away as
   * the camera tilts, so the building swings, shrinks and leaves the frame, and
   * every number that fixes one framing breaks the next. It is scenery on a
   * page about Greenwich, not a computed object, and pretending otherwise cost
   * more than it was ever going to return.
   *
   * So: upright, pinned to the bottom right, sized to the frame. The one thing
   * it still takes from the sky is its height on screen, which follows the
   * horizon, so that when the camera tilts up and the horizon drops away the
   * ground goes with it instead of hanging in the middle of the stars.
   */
  const horizon = projectVector(horVector(0, azimuth), basis, cx, cy, scale);
  if (!horizon) return;

  /*
   * Sized against both dimensions, not just the width.
   *
   * Half the frame width is a building about three fifths of the frame tall on
   * a landscape screen, and a model on a shelf on a portrait phone -- the same
   * fraction of a much shorter measurement. That would merely have looked
   * mean, except that the vertical placement below is anchored to the *height*
   * while this is anchored to the width, so on a tall narrow frame the roofline
   * fell below the horizon, `standing` went negative, and the building was not
   * drawn at all. It was missing from every phone.
   *
   * So the width is also allowed to grow until the building has a comparable
   * presence against the frame's height. On a landscape screen the first term
   * wins and nothing changes; on a phone the second does, and the observatory
   * is there.
   */
  const aspect = img.naturalWidth / img.naturalHeight;
  const w = Math.min(width * 0.92, Math.max(width * 0.52, height * 0.42 * aspect));
  const h = w / aspect;

  /*
   * Only the part that rises above the horizon is drawn.
   *
   * Everywhere else the foreground is clipped strictly below the brass line so
   * it can never sit in front of something computed. This one is clipped the
   * other way about, to the sky side, and the reasoning is the same in reverse:
   * a building at dusk is legible only where its roofline meets the sky, and
   * below the line the app already has its own ground, which the photograph
   * would otherwise cover with a flat dark slab of somebody else's ground.
   *
   * What is left is a real skyline standing in real twilight, taking the bottom
   * degree or two of sky away from the observer exactly as a real building on a
   * real horizon does. The licence is narrow: the landing page is the only
   * caller that passes a landmark bearing, so the sky view people actually
   * navigate by is untouched.
   */
  /*
   * Fixed in the frame, and left there.
   *
   * The building does not move at all. Tracking the horizon made it climb as
   * the camera tilted up, which read as the observatory taking off; mirroring
   * that made it sink, which read as it being lowered on a rope. It is a
   * building, so it stays where it is, and the rising horizon simply closes
   * over it as you scroll. The clip above does all the work.
   */
  /*
   * Where it stands, and why there are two terms.
   *
   * The first is the original: a base a little over three quarters of the way
   * down, with the building rising from it. That constant was chosen against a
   * landscape frame, where the horizon happens to fall just above it. On a tall
   * frame the same fraction is a long way *below* the horizon, so the roof
   * never reached the sky and the whole building was culled -- which is why it
   * was missing from every phone.
   *
   * The second term says the same thing in the sky's terms instead of the
   * frame's: sit the base just under the horizon, so a consistent amount of the
   * building shows above it whatever shape the frame is. The smaller of the two
   * wins, which on a landscape screen is always the first, so that framing is
   * untouched and stays as still as it ever was.
   *
   * On a portrait frame the second term wins and the building does then shift a
   * little as the camera tilts, which is the thing the fixed placement existed
   * to avoid. It is the lesser fault by a distance: the movement happens almost
   * entirely inside the window where the ground is already closing over it and
   * the fade is taking it away, and the alternative on those screens is not a
   * steadier building but no building.
   */
  const top = Math.min(height * 0.77, horizon.y + h * 0.15) - h * 0.74;

  // Flush with the right edge, so the building holds the corner rather than
  // floating in the middle of it.
  const left = width - w * 1.0;

  /*
   * Gone once the horizon has climbed past the roof.
   *
   * The clip cannot express this on its own. When the camera tilts far enough
   * up, the horizon leaves the top of the frame entirely, at which point every
   * pixel on screen is on the sky side and the clip stops clipping, which
   * reveals the whole photograph hanging in the middle of the star field. So
   * the same fact the clip is drawing is also asked directly: how much of the
   * building is still standing above the horizon, and once that reaches zero,
   * nothing is drawn at all. Faded over the last quarter so the ground closes
   * over it rather than switching it off.
   */
  const standing = (horizon.y - top) / (h * 0.25);
  if (standing <= 0) return;

  ctx.save();
  const skyline = altitudeCircle(basis, 0, cx, cy, scale);
  if (skyline) {
    pathAbove(ctx, skyline, width, height);
    ctx.clip();
  }
  ctx.globalAlpha = 0.96 * Math.min(1, standing) * fade;
  ctx.drawImage(img, left, top, w, h);
  ctx.restore();
}

/** Smooth periodic profile over azimuth: the same hills wherever you turn. */
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
 * accordingly. It is drawn strictly beneath the true horizon, the brass line,
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
  landmarkAzimuth: number | null,
  landmarkFade: number,
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

  /*
   * Outside the ground clip, and last of all.
   *
   * Two reasons. It is drawn last because the water and the fade that darkens
   * the near shore were both landing on top of it, which flattened the building
   * into the bank behind it however large it was made. It is drawn outside the
   * clip because this is the one piece of scenery allowed to break the horizon:
   * see the note on drawObservatory.
   */
  if (landmarkAzimuth != null) {
    drawObservatory(ctx, basis, cx, cy, scale, width, height, landmarkAzimuth, landmarkFade);
  }
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
/**
 * The sky side of an altitude circle, as a path ready to clip or fill.
 *
 * Exactly pathBelow with the winding reversed: whichever of the two cases puts
 * the disc on the ground side, the other one is the sky.
 */
function pathAbove(
  ctx: CanvasRenderingContext2D,
  circle: { x: number; y: number; radius: number; outside: boolean },
  width: number,
  height: number,
) {
  ctx.beginPath();
  if (circle.outside) {
    ctx.arc(circle.x, circle.y, circle.radius, 0, TAU);
  } else {
    ctx.rect(0, 0, width, height);
    ctx.arc(circle.x, circle.y, circle.radius, 0, TAU, true);
  }
}

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

/**
 * The figure lines.
 *
 * Faded with the twilight rather than drawn at a fixed strength, because the
 * page they appear on claims that things arrive as the sky darkens, and a net
 * stamped over a bright dusk sky at full opacity contradicts that in the one
 * frame most people look at.
 *
 * With the measuring furniture off the names are dropped and only the lines
 * remain: the joins are the structure, and the names are what turns a view of
 * the sky into a chart of it.
 */
function drawConstellations(
  ctx: CanvasRenderingContext2D,
  figures: ConstellationFigure[],
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
  conditions: SkyConditions | null,
  chrome: boolean,
) {
  // Below the horizon of usefulness: at civil dusk the net would be a diagram
  // over a sky where none of its stars are out yet.
  const twilight = conditions ? Math.max(0, Math.min(1, (-conditions.sunAltitude - 3) / 12)) : 1;
  if (twilight <= 0.01) return;

  // Held well back without the furniture. At chart strength the net becomes the
  // subject, and here the stars are: the lines are only meant to keep the empty
  // quarters of the frame from reading as nothing at all.
  const strength = chrome ? twilight : twilight * 0.45;

  ctx.save();
  ctx.globalAlpha = strength;
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

  ctx.restore();
}

/**
 * The figure names.
 *
 * Drawn in a pass of their own, after everything else, and that ordering is
 * the whole point. Labels queue for space in the order they are drawn, and a
 * constellation name is the most expendable text on the chart: the lines it
 * sits among already say where the figure is, whereas nothing else says which
 * point of light is Saturn. So the names go last and take what is left.
 *
 * Set small, widely tracked and well down in contrast, for the same reason.
 * These are annotations on a chart of the stars; the moment they are legible
 * from across the room they are competing with what they annotate.
 */
function drawFigureLabels(
  ctx: CanvasRenderingContext2D,
  figures: ConstellationFigure[],
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
  conditions: SkyConditions | null,
) {
  const twilight = conditions ? Math.max(0, Math.min(1, (-conditions.sunAltitude - 3) / 12)) : 1;
  if (twilight <= 0.01) return;

  ctx.save();
  ctx.globalAlpha = twilight;
  ctx.font = "400 9.5px 'Unbounded', system-ui, sans-serif";
  ctx.fillStyle = palette.figureLabel;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '0.2em';

  const width = cx * 2;
  const height = cy * 2;

  for (const figure of figures) {
    const v = figure.labelVector;
    const point = projectEqj(v.x, v.y, v.z, view, cx, cy, scale);
    if (!point || point.altitude < 12) continue;

    const text = figure.name.toUpperCase();
    const w = ctx.measureText(text).width;

    /*
     * Nudged back inside the frame rather than allowed to run off it. A name
     * centred on a figure whose centroid is near the edge loses half its
     * letters, and half a word is not a shorter label, it is a mistake. Moving
     * it a few pixels costs nothing: the figure is right there.
     *
     * Only a few, though. Past the nudge limit the label is dropped instead,
     * because a figure whose centre is well off the frame has no business
     * printing its name along the edge: it would be labelling stars that are
     * not on screen, and it crowds out the ones that are.
     */
    const NUDGE = 26;
    const x = Math.max(w / 2 + 8, Math.min(width - w / 2 - 8, point.x));
    const y = Math.max(14, Math.min(height - 14, point.y));
    if (Math.abs(x - point.x) > NUDGE || Math.abs(y - point.y) > NUDGE) continue;

    if (!claimLabel(x - w / 2, y - 6, w, 12)) continue;
    ctx.fillText(text, x, y);
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

/**
 * The faint majority of the catalogue, cached.
 *
 * Four and a half thousand stars is what makes the field look like a sky
 * rather than a diagram, and redrawing them every frame cost more than
 * everything else on the canvas put together. They also have no reason to be
 * redrawn: they do not twinkle, they are not labelled, they cannot be aimed
 * at, and they only move when the view does. So they are rendered once into a
 * buffer and stamped from it until the view actually changes.
 *
 * The buffer holds the layer at full strength and the brightness is applied
 * when it is stamped, so twilight and the atmospheric breathing still reach
 * it without costing a rebuild.
 *
 * The key is the view matrix rounded to three places — about a twentieth of a
 * degree, which is well under a pixel at any usable field of view. Sidereal
 * rotation therefore invalidates it roughly every ten seconds, and a drag
 * invalidates it every frame, which is exactly the same cost as not caching at
 * all rather than worse.
 */
let deepBuffer: HTMLCanvasElement | null = null;
let deepKey = '';

function drawDeepField(
  ctx: CanvasRenderingContext2D,
  catalog: StarCatalog,
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
  pixelScale: number,
  chartLimit: number,
  dpr: number,
  alpha: number,
) {
  if (alpha <= 0.01) return;

  const width = cx * 2;
  const height = cy * 2;
  const bw = Math.round(width * dpr);
  const bh = Math.round(height * dpr);

  let key = `${bw}x${bh}|${chartLimit.toFixed(2)}|${pixelScale.toFixed(2)}|${palette.starColors[0]}`;
  for (let i = 0; i < 12; i++) key += `|${view[i].toFixed(3)}`;

  if (key !== deepKey || !deepBuffer) {
    const buffer = (deepBuffer ??= document.createElement('canvas'));
    if (buffer.width !== bw || buffer.height !== bh) {
      buffer.width = bw;
      buffer.height = bh;
    }
    const g = buffer.getContext('2d');
    if (!g) return;

    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);

    const lists: number[][] = palette.starColors.map(() => []);
    const vectors = catalog.vectors;

    for (let i = 0; i < catalog.count; i++) {
      const mag = catalog.magnitude[i];
      if (mag > catalog.magLimit) break;
      if (mag <= chartLimit) continue;

      const o = i * 3;
      const x = vectors[o];
      const y = vectors[o + 1];
      const z = vectors[o + 2];

      if (view[9] * x + view[10] * y + view[11] * z <= 0) continue; // below the horizon
      const Z = view[6] * x + view[7] * y + view[8] * z;
      if (Z <= 0) continue; // behind the viewer

      const k = scale / (1 + Z);
      /*
       * Floored at half a pixel. Below that a square covers so little of the
       * pixel it lands on that antialiasing takes it to nothing, and the whole
       * layer silently disappears; the faintest stars need to be small *and*
       * dim rather than small enough to vanish.
       */
      lists[catalog.colorBucket[i]].push(
        cx + (view[0] * x + view[1] * y + view[2] * z) * k,
        cy - (view[3] * x + view[4] * y + view[5] * z) * k,
        Math.max(0.5, starRadius(mag, catalog.magLimit, pixelScale) * 0.8),
      );
    }

    /*
     * Squares, not discs. A circle has to be tessellated and antialiased all
     * the way round its rim, and at a radius under a pixel the rim is most of
     * the shape; a square is the same handful of lit pixels for a fraction of
     * the work, and at this size nothing can tell them apart.
     */
    for (let b = 0; b < lists.length; b++) {
      const list = lists[b];
      if (!list.length) continue;
      g.fillStyle = palette.starColors[b];
      g.beginPath();
      for (let i = 0; i < list.length; i += 3) {
        const r = list[i + 2];
        g.rect(list[i] - r, list[i + 1] - r, r * 2, r * 2);
      }
      g.fill();
    }

    deepKey = key;
  }

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(deepBuffer, 0, 0);
  ctx.restore();
}

/**
 * How faint the chart plots, and how big a star of a given magnitude is.
 *
 * Two limits, not one. The *chart* limit governs which stars are drawn at
 * chart weight and can be aimed at; the whole catalogue is drawn regardless,
 * because a sky with five hundred stars in it looks like a diagram and a sky
 * with five thousand looks like a sky.
 */
function chartLimitFor(catalog: StarCatalog, fov: number, chrome: boolean): number {
  return chrome
    ? Math.min(catalog.magLimit, 4.2 + Math.max(0, (70 - fov) / 70) * 2.3)
    : catalog.magLimit;
}

/** How much can be seen at all: geometry stays right, daylight does not. */
function starVisibility(conditions: SkyConditions | null): number {
  const sunAltitude = conditions?.sunAltitude ?? -30;
  return Math.max(0.16, Math.min(1, (-sunAltitude + 4) / 14));
}

/**
 * The magnitude the eye actually reaches tonight, from here.
 *
 * The chart limit above is about how dense the field should look. This is a
 * different question and the only one the fitted model answers: of the stars
 * drawn, which could a person standing outside actually catch. A full Moon
 * overhead pulls it down by most of a magnitude, a city pulls it down further,
 * and the sky visibly thins as the Moon rises.
 *
 * Null outside astronomical night, and the field then renders exactly as it did
 * before any of this existed. That is the same boundary the model itself keeps,
 * for the same reason: below -18 degrees is the only sky it was fitted on.
 */
const EYE_REACH_SUN_ALTITUDE = -18;

function eyeReach(site: ObserverSite, conditions: SkyConditions | null): number | null {
  if (!conditions || conditions.sunAltitude >= EYE_REACH_SUN_ALTITUDE) return null;
  return nakedEyeLimit(conditions.darkness, skyQualityInput(site, conditions));
}

/**
 * How much to hold a star back for being beyond the eye's reach.
 *
 * Softened over a magnitude rather than cut at one, because a threshold drawn
 * literally is a ring of missing stars with a visible edge, and no sky has one.
 * Quantised into a few steps so the field can still be drawn as a handful of
 * filled paths rather than five thousand separate ones.
 */
const REACH_TIERS = 4;
const REACH_SOFTNESS = 1.2;
const REACH_FLOOR = 0.22;

function reachTier(mag: number, reach: number | null): number {
  if (reach === null) return 0;
  const past = Math.max(0, Math.min(1, (mag - reach) / REACH_SOFTNESS));
  return Math.min(REACH_TIERS - 1, Math.round(past * (REACH_TIERS - 1)));
}

/** Tier 0 is untouched, so a sky the model says nothing about is unchanged. */
function tierAlpha(tier: number): number {
  return 1 - (1 - REACH_FLOOR) * (tier / (REACH_TIERS - 1));
}

/**
 * The star field: every dot, and nothing that moves.
 *
 * This half goes into the cached scene. Five thousand stars is what makes the
 * field look like a sky rather than a diagram, and none of them has any reason
 * to be redrawn until the view turns — they do not twinkle, carry no label and
 * cannot be aimed at. Everything that *does* change from frame to frame lives
 * in drawStarHighlights instead.
 */
function drawStarField(
  ctx: CanvasRenderingContext2D,
  catalog: StarCatalog,
  view: Float64Array,
  cx: number,
  cy: number,
  scale: number,
  radius: number,
  fov: number,
  conditions: SkyConditions | null,
  chrome: boolean,
  dpr: number,
  /** Magnitude the eye reaches tonight, or null outside astronomical night. */
  reach: number | null,
) {
  const chartLimit = chartLimitFor(catalog, fov, chrome);
  const pixelScale = Math.max(0.75, Math.min(1.6, radius / 320));
  const visibility = starVisibility(conditions);

  /*
   * One list per colour per reach tier. Tier is a function of magnitude alone,
   * so a star lands in the same list every rebuild and the whole field is still
   * a couple of dozen filled paths.
   */
  const buckets: number[][] = [];
  for (let i = 0; i < palette.starColors.length * REACH_TIERS; i++) buckets.push([]);
  const vectors = catalog.vectors;

  for (let i = 0; i < catalog.count; i++) {
    const mag = catalog.magnitude[i];
    // The catalogue is sorted brightest-first, so this exits early.
    if (mag > chartLimit) break;

    const o = i * 3;
    const x = vectors[o];
    const y = vectors[o + 1];
    const z = vectors[o + 2];

    if (view[9] * x + view[10] * y + view[11] * z <= 0) continue; // below the horizon
    const Z = view[6] * x + view[7] * y + view[8] * z;
    if (Z <= 0) continue; // behind the viewer

    const k = scale / (1 + Z);
    buckets[catalog.colorBucket[i] * REACH_TIERS + reachTier(mag, reach)].push(
      cx + (view[0] * x + view[1] * y + view[2] * z) * k,
      cy - (view[3] * x + view[4] * y + view[5] * z) * k,
      starRadius(mag, chartLimit, pixelScale),
    );
  }

  ctx.save();
  // Faintest first, so the depth layer sits behind the chart rather than
  // speckling over it.
  /*
   * The depth layer is every star past the chart limit, which is to say the
   * faintest thing drawn, so on a moonlit or a city night it is entirely beyond
   * the eye and thins as a whole. It composites as one cached bitmap under a
   * single alpha, so this costs nothing.
   */
  const deepTier = reach === null ? 0 : reachTier(chartLimit + REACH_SOFTNESS, reach);
  drawDeepField(
    ctx,
    catalog,
    view,
    cx,
    cy,
    scale,
    pixelScale,
    chartLimit,
    dpr,
    visibility * 0.72 * tierAlpha(deepTier),
  );

  for (let b = 0; b < buckets.length; b++) {
    const list = buckets[b];
    if (!list.length) continue;
    ctx.globalAlpha = visibility * tierAlpha(b % REACH_TIERS);
    ctx.fillStyle = palette.starColors[Math.floor(b / REACH_TIERS)];
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
  ctx.restore();
}

/**
 * The brightest stars: their haloes, their names, and where a tap lands.
 *
 * Drawn live every frame, because this is the half that is alive — the haloes
 * scintillate, and the names have to queue for space against the object labels
 * which move. It is a couple of dozen stars, so the cost is nothing next to
 * the field behind them.
 */
function drawStarHighlights(
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
  chrome: boolean,
  clock: number,
  seeing: number,
) {
  const chartLimit = chartLimitFor(catalog, fov, chrome);
  const pixelScale = Math.max(0.75, Math.min(1.6, radius / 320));
  const visibility = starVisibility(conditions);


  const bright: { x: number; y: number; r: number; index: number; airmass: number }[] = [];
  const vectors = catalog.vectors;

  for (let i = 0; i < catalog.count; i++) {
    const mag = catalog.magnitude[i];
    // These are the first-magnitude stars, so this exits almost immediately.
    if (mag >= 1.6) break;

    const o = i * 3;
    const x = vectors[o];
    const y = vectors[o + 1];
    const z = vectors[o + 2];

    const U = view[9] * x + view[10] * y + view[11] * z;
    if (U <= 0) continue; // below the horizon
    const Z = view[6] * x + view[7] * y + view[8] * z;
    if (Z <= 0) continue; // behind the viewer

    const k = scale / (1 + Z);
    bright.push({
      x: cx + (view[0] * x + view[1] * y + view[2] * z) * k,
      y: cy - (view[3] * x + view[4] * y + view[5] * z) * k,
      r: starRadius(mag, chartLimit, pixelScale),
      index: i,
      // U is the sine of the star's altitude, so 1/U is its airmass: how much
      // atmosphere the light crossed. Scintillation scales with it, which is
      // why stars low down visibly twinkle and stars overhead sit still.
      airmass: 1 / Math.max(0.09, U),
    });
  }

  ctx.save();
  ctx.globalAlpha = visibility;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = "500 11px 'Cabinet Grotesk', system-ui, sans-serif";

  const t = clock / 1000;
  const still = stillPreferred();

  for (const star of bright) {
    /*
     * Scintillation. The amplitude comes from the airmass, so it is a property
     * of where the star actually is rather than an effect applied evenly; the
     * phase is derived from the catalogue index so every star has its own and
     * they do not pulse in chorus. Two incommensurate rates, because real
     * twinkling is not periodic.
     */
    const phase = star.index * 2.399963;
    const shimmer = still
      ? 1
      : seeing +
        Math.min(0.4, (star.airmass - 1) * 0.16) *
          (Math.sin(t * 2.7 + phase) * 0.6 + Math.sin(t * 4.3 + phase * 1.7) * 0.4);

    const halo = star.r * 5 * shimmer;
    const glow = ctx.createRadialGradient(star.x, star.y, 0, star.x, star.y, halo);
    glow.addColorStop(0, palette.starGlow.replace('ALPHA', (0.5 * shimmer).toFixed(3)));
    glow.addColorStop(1, palette.starGlow.replace('ALPHA', '0'));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(star.x, star.y, halo, 0, TAU);
    ctx.fill();

    /*
     * A second, much wider and far fainter skirt. This is the bloom a bright
     * point picks up in the eye and in any lens, and it is what separates the
     * first magnitude stars from the rest at a glance, without resorting to
     * drawing them bigger than they are.
     */
    const bloom = star.r * 13;
    const spread = ctx.createRadialGradient(star.x, star.y, star.r, star.x, star.y, bloom);
    spread.addColorStop(0, palette.starGlow.replace('ALPHA', '0.09'));
    spread.addColorStop(1, palette.starGlow.replace('ALPHA', '0'));
    ctx.fillStyle = spread;
    ctx.beginPath();
    ctx.arc(star.x, star.y, bloom, 0, TAU);
    ctx.fill();

    const name = catalog.proper[star.index];
    if (!name || !chrome) continue;

    // cx and cy are the frame centre, so 2cx and 2cy are its width and height.
    const onScreen = star.x > -24 && star.x < cx * 2 + 24 && star.y > -24 && star.y < cy * 2 + 24;
    if (onScreen) {
      targets.push({ id: `star-${star.index}`, x: star.x, y: star.y, radius: star.r });
    }

    // The star itself is already drawn; only its name has to queue for room.
    const lx = star.x + star.r + 7;
    const w = ctx.measureText(name).width;
    if (claimLabel(lx, star.y - 6, w, 12)) {
      ctx.fillStyle = palette.starLabel;
      ctx.fillText(name, lx, star.y);
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
/**
 * Photographs of the bodies, for the markers on the chart.
 *
 * The same spacecraft images the object column uses, so a planet looks like
 * itself in both places instead of being a labelled bead in one and a portrait
 * in the other.
 *
 * One thing this deliberately gets wrong, and it is worth being plain about.
 * Venus is about a sixtieth of a degree across at its best; at any field of
 * view this app offers, an honest disc would be a fraction of a pixel, which
 * is why it was a point of light before. So the photograph is a symbol drawn
 * at symbol size, in the way a chart draws a city as a dot far larger than the
 * city. Everything that is a measurement here -- where it is, how bright it
 * is, which way the Moon is lit -- stays exactly as computed; only how big the
 * mark is drawn is a choice, and it was already a choice when it was a dot.
 *
 * The Sun is photographed here and drawn on the overture, which is not an
 * inconsistency but the same rule applied twice. On the chart it is an object
 * being pointed at, alongside the planets, and it should look like the thing
 * the arrow is aimed at. On the overture there is no furniture and nothing is
 * being aimed at anything: the Sun there is the light the scene is lit by, and
 * a photograph of a disc pasted into a gradient reads as a sticker rather than
 * as a source. That branch is `chrome`, a few lines down, and it is why the
 * soft-edged disc below has not gone anywhere.
 *
 * Satellites keep their points, for the reason they always did: from a garden
 * that is what one is.
 */
const PHOTOGRAPHED_BODIES = new Set([
  'sun',
  'mercury',
  'venus',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'moon',
]);

interface BodyPhoto {
  day: HTMLImageElement;
  /** The same image on the red ramp, for night vision. Built once, on load. */
  night: HTMLCanvasElement | null;
}

const bodyPhotos = new Map<string, BodyPhoto>();

/**
 * The photograph rendered onto the night-vision ramp.
 *
 * The same matrix the stylesheet applies to the portraits in the column: Rec.
 * 709 luminance, then split back out into a warm red. Done once per image when
 * it loads rather than per frame, because it is a per-pixel pass and there is
 * no reason for it to happen sixty times a second on an image that will never
 * change.
 *
 * Half the source resolution is still several times the size these are ever
 * drawn at, and it makes the one-off pass four times cheaper.
 */
function nightCopy(img: HTMLImageElement): HTMLCanvasElement | null {
  const side = Math.max(1, Math.min(256, img.naturalWidth >> 1));
  const off = document.createElement('canvas');
  off.width = side;
  off.height = side;
  const g = off.getContext('2d', { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(img, 0, 0, side, side);

  const data = g.getImageData(0, 0, side, side);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    const luma = px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
    px[i] = luma;
    px[i + 1] = luma * 0.38;
    px[i + 2] = luma * 0.28;
  }
  g.putImageData(data, 0, 0);
  return off;
}

/**
 * The photograph for a body, once it has arrived.
 *
 * Returns null until the file has loaded, and the caller falls back to the
 * drawn marker for those frames. Nothing waits and nothing re-renders: the
 * next frame simply finds it there.
 */
function bodyPhoto(name: string): BodyPhoto | null {
  const key = name.toLowerCase();
  if (!PHOTOGRAPHED_BODIES.has(key)) return null;

  const held = bodyPhotos.get(key);
  if (held) return held.day.complete && held.day.naturalWidth > 0 ? held : null;

  const img = new Image();
  const record: BodyPhoto = { day: img, night: null };
  bodyPhotos.set(key, record);
  img.onload = () => {
    record.night = nightCopy(img);
  };
  img.src = `bodies/${key}.png`;
  return null;
}

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
  /** False on the overture, where these are scenery rather than readings. */
  chrome: boolean,
  clock: number,
  nightVision: boolean,
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
    // Without the instrument furniture the Sun is not a marker to be tapped but
    // the light source of the scene, so it is drawn nearer its part in the
    // picture: a disc with a bloom, rather than a labelled target.
    const size =
      body.kind === 'sun'
        ? chrome
          ? 16
          : 22
        : body.kind === 'moon'
          ? chrome
            ? 14
            : 10
          : body.kind === 'satellite'
            ? 5
            : chrome
              ? Math.max(3.2, 7 - body.magnitude * 0.8)
              : // Without labels a planet is not a target to hit, it is a point
                // of light, and at tap-target size it reads as a bead sitting
                // on the sky rather than something in it.
                Math.max(1.6, 3.4 - body.magnitude * 0.35);

    /*
     * The photograph, where the chart is the subject and there is one to use.
     *
     * Held between a floor and a ceiling rather than tracking brightness the
     * way the drawn marker does. A photograph needs a certain number of pixels
     * before it is a planet rather than a smudge, and past a certain size it
     * stops reading as something far away; the drawn dot had neither problem
     * and so needed neither limit.
     */
    const photo = chrome ? bodyPhoto(body.name) : null;
    const markSize = photo ? Math.max(9, Math.min(22, size * 1.2)) : size;

    // A low sun lights a quarter of the sky, not a circle three times its own
    // width. The wide falloff is what stops it reading as a sticker on a
    // gradient, and it only applies where the scene is the subject.
    const bloom = !chrome && body.kind === 'sun' ? 11 : 3.4;
    const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, markSize * bloom);
    glow.addColorStop(0, style.glow);
    if (!chrome && body.kind === 'sun') glow.addColorStop(0.28, 'rgba(255, 186, 92, 0.28)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(point.x, point.y, markSize * bloom, 0, TAU);
    ctx.fill();

    /*
     * A hard-edged filled circle is right for a marker and wrong for a light.
     * Nothing luminous has a crisp rim against the sky; the eye and the lens
     * both spread it, so with the furniture off the disc is drawn with its
     * edge falling away instead of stopping, which is the difference between a
     * sun and a sticker of one.
     */
    /*
     * Not clipped to a circle, because Saturn's rings reach well outside its
     * globe and a circular clip would trim them. The images carry their own
     * cut-out alpha, which is the whole reason they were fetched that way.
     */
    if (photo) {
      const source = (nightVision && photo.night) || photo.day;
      ctx.drawImage(source, point.x - markSize, point.y - markSize, markSize * 2, markSize * 2);
    } else {
      if (chrome) {
        ctx.fillStyle = style.fill;
      } else {
        const core = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, size);
        core.addColorStop(0, '#FFFDF4');
        core.addColorStop(0.55, style.fill);
        core.addColorStop(0.88, style.fill);
        core.addColorStop(1, 'rgba(255, 233, 168, 0)');
        ctx.fillStyle = core;
      }
      ctx.beginPath();
      ctx.arc(point.x, point.y, size, 0, TAU);
      ctx.fill();
    }

    /*
     * The Moon's phase, over whichever of the two was drawn.
     *
     * This one is not a stylistic choice and cannot be dropped with the disc.
     * The photograph is of a full Moon, because that is the one that shows the
     * whole nearside; which part of it is lit tonight is a computed fact, and
     * a full Moon drawn on a night with a crescent up would be the app stating
     * something untrue.
     */
    if (body.kind === 'moon' && body.illuminatedFraction !== undefined) {
      drawMoonPhase(ctx, point.x, point.y, markSize, body.illuminatedFraction);
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

    if (body.id === selectedId) drawTracking(ctx, point.x, point.y, markSize, clock);

    // Only register something as tappable if it is actually on screen. A marker
    // projected off the edge is still drawn (harmlessly clipped) but must not
    // sit in the hit list, where it could win a tap near the border.
    const margin = markSize + 24;
    const onScreen =
      point.x > -margin &&
      point.x < width + margin &&
      point.y > -margin &&
      point.y < height + margin;

    if (onScreen) targets.push({ id: body.id, x: point.x, y: point.y, radius: markSize });

    // The label needs more room than the marker does: a leader and two lines of
    // text hanging off a marker that is itself past the edge leaves orphaned
    // words floating against the frame with nothing to point at.
    // Labels are furniture too: a leader line and a magnitude readout hanging
    // off the setting sun belongs on an instrument, not in a picture of an
    // evening.
    if (
      chrome &&
      point.x > 4 &&
      point.x < width - 4 &&
      point.y > 12 &&
      point.y < height - 8
    ) {
      drawLeaderLabel(ctx, point.x, point.y, markSize, body, width);
    }
  }
  ctx.restore();
}

/**
 * The tracking reticle around whatever is selected.
 *
 * Two rings turning against each other, which is the whole idea: a static
 * circle says "this one is highlighted", and two counter-rotating divided
 * rings say "something is holding this". The inner one carries the divisions,
 * the outer one four corner marks, and both turn slowly enough that you have
 * to watch to see it — an instrument tracking a target is not in a hurry.
 *
 * Under them a soft warm pool of light, so the object appears lit rather than
 * ringed. That distinction is most of the difference between a selection state
 * and an illuminated one.
 */
function drawTracking(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  clock: number,
) {
  const t = stillPreferred() ? 0 : clock / 1000;
  const inner = size + 11;
  const outer = size + 19;

  ctx.save();

  // The light it is under. Layered and low rather than one bright ring.
  const pool = ctx.createRadialGradient(x, y, size * 0.5, x, y, outer * 1.9);
  pool.addColorStop(0, 'rgba(232, 204, 122, 0.16)');
  pool.addColorStop(0.5, 'rgba(232, 204, 122, 0.05)');
  pool.addColorStop(1, 'rgba(232, 204, 122, 0)');
  ctx.fillStyle = pool;
  ctx.beginPath();
  ctx.arc(x, y, outer * 1.9, 0, TAU);
  ctx.fill();

  ctx.strokeStyle = palette.selection;

  // Inner ring: a divided scale, turning one way.
  ctx.globalAlpha = 0.75;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, inner, 0, TAU);
  ctx.stroke();

  const spin = t * 0.22;
  ctx.lineWidth = 1;
  for (let i = 0; i < 24; i++) {
    const a = spin + (i / 24) * TAU;
    const long = i % 6 === 0;
    ctx.globalAlpha = long ? 0.8 : 0.34;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * inner, y + Math.sin(a) * inner);
    ctx.lineTo(x + Math.cos(a) * (inner - (long ? 5 : 2.5)), y + Math.sin(a) * (inner - (long ? 5 : 2.5)));
    ctx.stroke();
  }

  // Outer ring: four corner marks, turning the other way.
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = 1.3;
  const counter = -t * 0.14 + TAU / 8;
  for (let i = 0; i < 4; i++) {
    const a = counter + (i / 4) * TAU;
    ctx.beginPath();
    ctx.arc(x, y, outer, a - 0.16, a + 0.16);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * outer, y + Math.sin(a) * outer);
    ctx.lineTo(x + Math.cos(a) * (outer + 5), y + Math.sin(a) * (outer + 5));
    ctx.stroke();
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
  const ringRadius = size + 5;

  ctx.save();

  // The sighting ring goes on regardless: it is part of the marker, it says
  // "this is a tracked object", and it never collides with anything because it
  // is centred on the object itself.
  ctx.strokeStyle = palette.labelRing;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x, y, ringRadius, 0, TAU);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  const reading = readingFor(body);

  /*
   * Four places to try, in order of preference: up-and-out on the side with
   * more room, then the other side, then down on each. A satellite pass puts
   * several objects within a few degrees of each other, and letting each one
   * fall back to a free corner is the difference between four readable labels
   * and one illegible knot of them.
   */
  const away = x > width * 0.62 ? -1 : 1;
  const options: [number, number][] = [
    [away, -1],
    [-away, -1],
    [away, 1],
    [-away, 1],
  ];

  for (const [dir, up] of options) {
    const rise = 13 * up;
    const run = 26;

    const startX = x + dir * ringRadius * 0.72;
    const startY = y + up * ringRadius * 0.72;
    const kneeX = startX + dir * run;
    const kneeY = startY + rise;
    const endX = kneeX + dir * 14;
    const textX = endX + dir * 5;

    ctx.font = "500 15px 'Newsreader', Georgia, serif";
    const nameWidth = ctx.measureText(body.name).width;
    ctx.font = "400 9.5px 'Share Tech Mono', ui-monospace, monospace";
    const readingWidth = ctx.measureText(reading).width;
    const w = Math.max(nameWidth, readingWidth);

    const boxX = dir > 0 ? textX : textX - w;
    if (!claimLabel(boxX, kneeY - 9, w, 30)) continue;

    ctx.strokeStyle = palette.labelLeader;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(endX, kneeY);
    ctx.stroke();

    ctx.textAlign = dir > 0 ? 'left' : 'right';

    ctx.font = "500 15px 'Newsreader', Georgia, serif";
    ctx.fillStyle = body.kind === 'satellite' ? palette.satelliteLabel : palette.labelName;
    ctx.fillText(body.name, textX, kneeY + 5);

    ctx.font = "400 9.5px 'Share Tech Mono', ui-monospace, monospace";
    ctx.fillStyle = palette.labelData;
    ctx.letterSpacing = '0.08em';
    ctx.fillText(reading, textX, kneeY + 19);
    ctx.letterSpacing = '0px';
    break;
  }

  ctx.restore();
}

function drawMoonPhase(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  illuminated: number,
) {
  const lit = Math.max(0, Math.min(1, illuminated));

  /*
   * The terminator is a circle seen at an angle, so it projects to an ellipse
   * sharing the disc's vertical axis, with a half-width running from the full
   * radius at new, through nothing at half, to the radius again at full. The
   * unlit region is then the far limb plus that ellipse.
   *
   * This used to be drawn as a second disc of the same size slid sideways,
   * which is a common shortcut and was wired up backwards besides: the offset
   * it computed went to zero at half phase, where a same-size disc covers the
   * original exactly, so a half-lit Moon rendered as a black circle and a new
   * Moon rendered as a crescent. Both of those are the opposite of the fact
   * being reported an inch away in the label.
   *
   * Which limb is lit is a convention here rather than a measurement -- it
   * follows the portrait in the object column, lit from the right -- but the
   * fraction is the computed one, and that is the part that says what you will
   * see tonight.
   */
  const half = Math.abs(1 - 2 * lit) * size;
  // Past half, the unlit sliver is on the near side of centre and the ellipse
  // bulges the other way.
  const bulgeRight = lit < 0.5;

  ctx.save();
  ctx.fillStyle = palette.moonShadow;
  ctx.beginPath();
  // The far limb: top, round the left, to the bottom.
  ctx.arc(x, y, size, -Math.PI / 2, Math.PI / 2, true);
  // The terminator, back up to where it started.
  ctx.ellipse(x, y, half, size, 0, Math.PI / 2, -Math.PI / 2, bulgeRight);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The elevation scale down the right edge: how far above the horizon you are
 * aimed.
 *
 * Curved, and for the same reason the horizon is. A straight ruled tape down
 * the side of a frame is a scrollbar; a divided arc is the limb of an
 * instrument. The curvature is slight — the arc bows out by about a twelfth of
 * its length — but it is enough that the scale reads as belonging to a
 * circular fitting rather than to the edge of a window.
 *
 * The graduations themselves are unchanged: laid out linearly and calibrated
 * against the projection's exact rate at the index mark, the way a real tape is
 * ruled.
 */
function drawAltitudeArc(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  camera: Camera,
  pixelsPerDegree: number,
) {
  // Centre of curvature well off to the left, so the limb is nearly vertical.
  /*
   * Also held against the width. The arc's bow is set by how much of it the
   * frame's height cuts across, so a radius chosen from the height alone bows
   * by the same *number of pixels* on a phone as on a desktop — which is a
   * fifth of a narrow screen and a twentieth of a wide one.
   */
  const R = Math.max(height * 1.4, width * 2.2, 600);
  const outer = width - 18;
  const cx = outer - R;
  const cy = height / 2;

  /** Where on the limb a given altitude falls, and which way is "out". */
  const at = (deg: number) => {
    const y = cy - (deg - camera.altitude) * pixelsPerDegree;
    const dy = y - cy;
    if (Math.abs(dy) > R) return null;
    const dx = Math.sqrt(R * R - dy * dy);
    return { x: cx + dx, y, nx: dx / R, ny: dy / R };
  };

  ctx.save();
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  // The limb itself, drawn only over the range the scale actually covers, so
  // it stops where the readings stop instead of running off both ends.
  ctx.beginPath();
  let started = false;
  for (let deg = -20; deg <= 90; deg += 2) {
    const p = at(deg);
    if (!p) continue;
    if (p.y < -20 || p.y > height + 20) continue;
    if (started) ctx.lineTo(p.x, p.y);
    else {
      ctx.moveTo(p.x, p.y);
      started = true;
    }
  }
  ctx.strokeStyle = palette.tapeRule;
  ctx.lineWidth = 1;
  ctx.stroke();

  for (let deg = -20; deg <= 90; deg += 2) {
    const p = at(deg);
    if (!p) continue;
    if (p.y < 12 || p.y > height - 8) continue;

    const major = deg % 30 === 0;
    const medium = deg % 10 === 0;

    ctx.strokeStyle = major ? palette.tickMajor : palette.tickMinor;
    ctx.globalAlpha = major ? 0.9 : medium ? 0.55 : 0.28;
    ctx.lineWidth = major ? 1.3 : 1;
    const len = major ? 12 : medium ? 8 : 4;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + p.nx * len, p.y + p.ny * len);
    ctx.stroke();

    if (major) {
      ctx.globalAlpha = 0.85;
      ctx.font = "400 10px 'Share Tech Mono', ui-monospace, monospace";
      ctx.fillStyle = palette.tapeLabel;
      ctx.fillText(`${deg}°`, p.x - 7, p.y);
    }
  }

  /*
   * The index: where the view is actually aimed. Without it the scale says how
   * high things are but not how high *you* are looking, which is the one thing
   * an elevation readout is for.
   */
  const here = at(camera.altitude);
  if (here) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = palette.index;
    ctx.beginPath();
    ctx.moveTo(here.x + here.nx * 3, here.y + here.ny * 3);
    ctx.lineTo(here.x + here.nx * 11 - here.ny * 5, here.y + here.ny * 11 + here.nx * 5);
    ctx.lineTo(here.x + here.nx * 11 + here.ny * 5, here.y + here.ny * 11 - here.nx * 5);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}
