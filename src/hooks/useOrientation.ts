/**
 * Device orientation, turned into a direction the sky view can point.
 *
 * This is the least reliable input in the app and it is treated that way. The
 * browser compass drifts, needs figure-of-eight calibration, and on iOS cannot
 * even be read without an explicit tap. So this hook reports exactly what it
 * knows (whether the reading is north-referenced, and how confident the
 * platform says it is) and the interface never pretends a fallback is live
 * tracking.
 *
 * Maths follows the W3C device-orientation convention: the rotation from the
 * device frame to the world frame is Rz(alpha)Rx(beta)Ry(gamma), with the world
 * frame X east, Y north, Z up. The sky view looks out of the back of the phone,
 * which is the device's -Z axis.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

export type OrientationStatus =
  | 'unsupported'
  | 'insecure-context'
  | 'needs-permission'
  | 'denied'
  | 'waiting'
  | 'active';

export interface OrientationReading {
  status: OrientationStatus;
  /** Where the back of the phone points, degrees clockwise from north. */
  azimuth: number;
  /** How far above the horizon the phone is aimed, degrees. */
  altitude: number;
  /** Screen rotation about the view axis, degrees. */
  roll: number;
  /** False when the platform gave us a relative heading with no north reference. */
  absolute: boolean;
  /** iOS reports its own compass uncertainty in degrees. Null elsewhere. */
  accuracyDegrees: number | null;
  /** User-applied correction for a compass reading that is visibly off. */
  calibration: number;
}

interface DeviceOrientationEventiOS extends DeviceOrientationEvent {
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

type PermissionCapableEvent = {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
};

/**
 * Minimal shape of the Generic Sensor API's AbsoluteOrientationSensor.
 *
 * Declared locally because TypeScript's DOM library does not ship it (the spec
 * is only implemented on Chromium) and pulling in a whole ambient package for
 * one optional constructor would be a poor trade.
 */
interface OrientationSensor extends EventTarget {
  quaternion: [number, number, number, number] | null;
  start: () => void;
  stop: () => void;
}
type SensorConstructor = new (options?: {
  frequency?: number;
  referenceFrame?: 'device' | 'screen';
}) => OrientationSensor;

function needsPermissionPrompt(): boolean {
  const ctor = window.DeviceOrientationEvent as unknown as PermissionCapableEvent | undefined;
  return typeof ctor?.requestPermission === 'function';
}

/**
 * Browsers only release the motion sensors on a secure origin.
 *
 * This matters because the failure looks exactly like missing hardware.
 * Safari keeps `DeviceOrientationEvent` on window over plain http, lets you
 * add listeners, then simply withholds `requestPermission` and never fires a
 * reading; Chrome deletes the interface outright. Either way the honest answer
 * is that the connection blocked it, not that the device has no compass,
 * which we cannot even determine from here.
 *
 * Tested before the interface itself for exactly that reason: on Chrome the
 * missing interface *is* the symptom, so reading it as "no sensor" would report
 * the consequence and hide the cause.
 *
 * localhost counts as secure, so desktop development is unaffected; opening the
 * dev server from a phone by LAN address is not.
 */
function isInsecureContext(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext === false;
}

function initialStatus(): OrientationStatus {
  if (typeof window === 'undefined') return 'unsupported';
  if (isInsecureContext()) return 'insecure-context';
  if (!('DeviceOrientationEvent' in window)) return 'unsupported';
  return needsPermissionPrompt() ? 'needs-permission' : 'waiting';
}

/**
 * Says out loud which of the several ways this can fail is actually happening.
 *
 * The three failures are indistinguishable from the outside (all of them end
 * with no readings arriving) so during development the one that fired is
 * printed along with the evidence behind it. Stripped from production builds.
 */
function reportStatus(status: OrientationStatus) {
  if (!import.meta.env.DEV) return;
  const detail = [
    `secureContext=${window.isSecureContext}`,
    `hasEvent=${'DeviceOrientationEvent' in window}`,
    `needsPrompt=${'DeviceOrientationEvent' in window && needsPermissionPrompt()}`,
    `hasAbsoluteEvent=${'ondeviceorientationabsolute' in window}`,
    `hasSensor=${'AbsoluteOrientationSensor' in window}`,
  ].join(' ');
  console.info(`[compass] ${status}: ${detail}`);
}

/** Screen-space "up" expressed in device axes, for the current screen rotation. */
function screenUpInDeviceFrame(): [number, number, number] {
  const angle = (screen.orientation?.angle ?? 0) * DEG;
  return [Math.sin(angle), Math.cos(angle), 0];
}

/**
 * How hard to smooth, given how fast the phone is turning.
 *
 * A single fixed amount of smoothing cannot win here, and the first attempt at
 * this proved it. Enough filtering to kill the jitter when the phone is held
 * still makes the sky lag behind when you sweep it; enough to keep up with a
 * sweep lets every wobble through when you stop. The compass signal is worse
 * than noisy, too: iOS reports its heading in whole degrees, and at a seventy
 * degree field of view one degree is about six pixels, so even a perfectly
 * steady hand produces a target that arrives in visible steps.
 *
 * So the cutoff moves with the speed of the motion — the one-euro filter
 * (Casiez, Roussel and Vogel, 2012), which exists for precisely this trade.
 * Held still, the cutoff drops to MIN_CUTOFF and the jitter is smoothed away.
 * Turning, it rises with BETA times the speed and the filter gets out of the
 * way. The lag you would notice and the jitter you would notice never happen
 * at the same time, so neither has to be paid for.
 */
const MIN_CUTOFF = 0.8; // Hz, when the phone is still
const BETA = 4.0; // how fast the cutoff opens up with motion
const D_CUTOFF = 1.0; // Hz, smoothing applied to the speed estimate itself

function lowpassAlpha(cutoff: number, dt: number): number {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}

/**
 * One filtering step for a direction.
 *
 * The cutoff comes from the speed of the whole vector rather than from each
 * component separately, so all three are smoothed by the same amount and the
 * direction cannot be bent by the filter — only delayed.
 */
function filterVector(
  raw: number[],
  state: { value: number[]; speed: number[]; previous: number[] } | null,
  dt: number,
): { value: number[]; speed: number[]; previous: number[] } {
  if (!state) return { value: raw.slice(), speed: [0, 0, 0], previous: raw.slice() };

  const aD = lowpassAlpha(D_CUTOFF, dt);
  const speed = state.speed.map((prev, i) => prev + aD * ((raw[i] - state.previous[i]) / dt - prev));
  const rate = Math.hypot(speed[0], speed[1], speed[2]);

  const a = lowpassAlpha(MIN_CUTOFF + BETA * rate, dt);
  const value = state.value.map((prev, i) => prev + a * (raw[i] - prev));

  return { value, speed, previous: raw.slice() };
}

/**
 * Turns a look and up direction into the aim the renderer wants.
 *
 * Module scope because two callers need it and they must not disagree: the
 * renderer samples this from filtered vectors once a frame, and the throttled
 * readout takes it from the raw ones when nothing is sampling. Two copies of
 * this arithmetic would be two chances for the heading on screen to stop
 * matching the sky.
 */
function aimFrom(look: number[], up: number[]): { azimuth: number; altitude: number; roll: number } {
  const nLook = Math.hypot(look[0], look[1], look[2]) || 1;
  const lx = look[0] / nLook;
  const ly = look[1] / nLook;
  const lz = look[2] / nLook;

  const altitude = Math.asin(Math.max(-1, Math.min(1, lz))) * RAD;
  let azimuth = Math.atan2(lx, ly) * RAD;
  if (azimuth < 0) azimuth += 360;

  // Roll: how far the screen's up axis is rotated from the sky's "up".
  // Work in the horizontal frame the renderer uses (x north, y west, z zenith).
  const fx = ly;
  const fy = -lx;
  const fz = lz;
  let brx = fy * 1 - 0; // cross(forward, zenith) with zenith = (0,0,1)
  let bry = -fx;
  let brz = 0;
  const brLen = Math.hypot(brx, bry, brz);
  if (brLen < 1e-6) {
    // Aimed at the zenith: roll is undefined against the horizon, so hold it.
    brx = 1;
    bry = 0;
    brz = 0;
  } else {
    brx /= brLen;
    bry /= brLen;
    brz /= brLen;
  }
  const bux = bry * fz - brz * fy;
  const buy = brz * fx - brx * fz;
  const buz = brx * fy - bry * fx;

  const upHor = [up[1], -up[0], up[2]];
  const sR = upHor[0] * brx + upHor[1] * bry + upHor[2] * brz;
  const sU = upHor[0] * bux + upHor[1] * buy + upHor[2] * buz;
  const roll = Math.atan2(sR, sU) * RAD;

  return { azimuth, altitude, roll };
}

export function useOrientation(): OrientationReading & {
  /**
   * Where to aim right now, advanced to the given timestamp.
   *
   * The renderer's frame clock drives this. Everything else on the reading is
   * a throttled copy for the DOM; this is the live one.
   */
  sample: (nowMs: number) => { azimuth: number; altitude: number; roll: number };
  enable: () => Promise<void>;
  disable: () => void;
  nudgeCalibration: (delta: number) => void;
  resetCalibration: () => void;
} {
  const [status, setStatus] = useState<OrientationStatus>(initialStatus);

  useEffect(() => reportStatus(status), [status]);

  const [reading, setReading] = useState({
    azimuth: 0,
    altitude: 45,
    roll: 0,
    absolute: false,
    accuracyDegrees: null as number | null,
  });

  const [calibration, setCalibration] = useState(() => {
    const stored = Number.parseFloat(localStorage.getItem('borrowed-sky:compass-offset') ?? '');
    return Number.isFinite(stored) ? stored : 0;
  });

  /*
   * The sensor's latest word, and the filtered aim the view is actually using.
   *
   * These are refs rather than state on purpose, and it is the difference
   * between smooth panning and the judder that made this feel broken. A sensor
   * event is not a frame: readings arrive between thirty and sixty times a
   * second at intervals the platform chooses and does not keep to, while the
   * canvas draws on the display's clock. Setting React state per reading meant
   * the view moved in the sensor's irregular steps and sat perfectly still in
   * between, which is exactly what a stutter is.
   *
   * So nothing here re-renders. The events write where the phone is pointing,
   * the render loop calls sample() once a frame to ask where to aim, and the
   * two run at their own rates without either waiting on the other.
   */
  const targetRef = useRef<{ look: number[]; up: number[] } | null>(null);
  // Filtering direction vectors rather than angles avoids the discontinuity
  // where a heading wraps past north.
  type Filtered = { value: number[]; speed: number[]; previous: number[] };
  const smoothRef = useRef<{ look: Filtered; up: Filtered } | null>(null);
  const aimRef = useRef({ azimuth: 0, altitude: 45, roll: 0 });
  const sampledAtRef = useRef(0);
  const sourceRef = useRef({ absolute: false, accuracyDegrees: null as number | null });
  const publishedAtRef = useRef(0);

  /**
   * Turns a device-to-world rotation into a direction, and records it.
   *
   * Shared by both sources, because the two of them disagree about how to
   * describe an orientation (Euler angles from the events, a quaternion from
   * the sensor) but agree completely about the frame it is expressed in. Doing
   * the conversion once means the roll solution and the screen-rotation
   * handling cannot drift apart between them.
   */
  const applyRotation = useCallback(
    (r: number[][], absolute: boolean, accuracyDegrees: number | null) => {
      // The camera looks out of the back of the phone: the device -Z axis.
      const lookWorld = [-r[0][2], -r[1][2], -r[2][2]];

      const [ux, uy, uz] = screenUpInDeviceFrame();
      const upWorld = [
        r[0][0] * ux + r[0][1] * uy + r[0][2] * uz,
        r[1][0] * ux + r[1][1] * uy + r[1][2] * uz,
        r[2][0] * ux + r[2][1] * uy + r[2][2] * uz,
      ];

      targetRef.current = { look: lookWorld, up: upWorld };
      sourceRef.current = { absolute, accuracyDegrees };
      setStatus('active');

      /*
       * Keep the written-down heading alive when nothing is drawing with it.
       *
       * sample() publishes that copy, and sample() only runs while the compass
       * is actually aiming the view. Drag the sky and then open the compass
       * sheet to calibrate it and the heading there would sit frozen at
       * whatever it read when you stopped following — which is precisely the
       * screen you need a live number on. So when no frame has asked for an
       * aim recently, the reading is published from here instead. Unfiltered,
       * because this path feeds text rather than motion.
       */
      const now = performance.now();
      if (now - sampledAtRef.current > 250 && now - publishedAtRef.current > 100) {
        publishedAtRef.current = now;
        setReading({ ...aimFrom(lookWorld, upWorld), absolute, accuracyDegrees });
      }
    },
    [],
  );

  /**
   * Where to aim this frame.
   *
   * Called by the renderer once per frame, which is what makes the motion
   * smooth: the filter advances by the time that actually elapsed rather than
   * by one fixed step per sensor event, so a reading arriving late, early or
   * not at all changes nothing about how fast the view catches up. The old
   * fixed-alpha filter silently changed its own time constant whenever the
   * sensor rate moved, which is why panning felt uneven rather than merely
   * laggy.
   *
   * TAU is the time to close about two thirds of the remaining gap. Long
   * enough to swallow the noise that makes unfiltered stars shimmer, short
   * enough that the sky still feels attached to the phone.
   */
  const sample = useCallback((nowMs: number) => {
    const target = targetRef.current;
    if (!target) return aimRef.current;

    const last = sampledAtRef.current;
    // Clamped: a backgrounded tab resumes with a huge gap, and an unclamped dt
    // would make the filter either snap or stall on the first frame back.
    const dt = last ? Math.min(0.25, Math.max(0.001, (nowMs - last) / 1000)) : 0;
    sampledAtRef.current = nowMs;

    const prev = smoothRef.current;
    const lookState = filterVector(target.look, dt ? prev?.look ?? null : null, dt || 1);
    const upState = filterVector(target.up, dt ? prev?.up ?? null : null, dt || 1);
    smoothRef.current = { look: lookState, up: upState };

    const look = lookState.value;
    const up = upState.value;

    const aim = aimFrom(look, up);

    aimRef.current = aim;

    /*
     * The written-down copy, for the parts of the interface made of DOM.
     *
     * The heading readout and the horizon card do not need sixty updates a
     * second — the card runs its own eased follow and would ignore them — and
     * re-rendering the object list at frame rate to move a compass letter is
     * exactly the sort of cost this app has spent a while removing. Ten a
     * second is past the point anyone can see the difference in text.
     */
    if (nowMs - publishedAtRef.current > 100) {
      publishedAtRef.current = nowMs;
      setReading({ ...aim, ...sourceRef.current });
    }

    return aimRef.current;
  }, []);

  const handleEvent = useCallback(
    (event: DeviceOrientationEvent) => {
      // A reading with no angles at all is the platform saying "no sensor".
      if (event.alpha === null && event.beta === null && event.gamma === null) return;

      const ios = event as DeviceOrientationEventiOS;
      const beta = (event.beta ?? 0) * DEG;
      const gamma = (event.gamma ?? 0) * DEG;

      let alphaDeg = event.alpha ?? 0;
      let absolute = event.absolute === true;

      // iOS never sets `absolute`, but does expose a true compass heading.
      if (typeof ios.webkitCompassHeading === 'number' && !Number.isNaN(ios.webkitCompassHeading)) {
        alphaDeg = 360 - ios.webkitCompassHeading;
        absolute = true;
      }
      const alpha = alphaDeg * DEG;

      const cA = Math.cos(alpha);
      const sA = Math.sin(alpha);
      const cB = Math.cos(beta);
      const sB = Math.sin(beta);
      const cG = Math.cos(gamma);
      const sG = Math.sin(gamma);

      // R = Rz(alpha) Rx(beta) Ry(gamma), device frame -> world frame (X east, Y north, Z up).
      applyRotation(
        [
          [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
          [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
          [-cB * sG, sB, cB * cG],
        ],
        absolute,
        typeof ios.webkitCompassAccuracy === 'number' && ios.webkitCompassAccuracy >= 0
          ? ios.webkitCompassAccuracy
          : null,
      );
    },
    [applyRotation],
  );

  const disable = useCallback(() => {
    smoothRef.current = null;
    targetRef.current = null;
    sampledAtRef.current = 0;
    setStatus(initialStatus);
  }, []);

  const enable = useCallback(async () => {
    if (isInsecureContext()) {
      setStatus('insecure-context');
      return;
    }
    if (!('DeviceOrientationEvent' in window)) {
      setStatus('unsupported');
      return;
    }

    // iOS 13+ refuses to deliver readings unless asked from a user gesture.
    if (needsPermissionPrompt()) {
      try {
        const ctor = window.DeviceOrientationEvent as unknown as PermissionCapableEvent;
        const result = await ctor.requestPermission!();
        if (result !== 'granted') {
          setStatus('denied');
          return;
        }
      } catch {
        setStatus('denied');
        return;
      }
    }

    // Moving to `waiting` is all that is needed; the effect below owns the
    // listeners and picks it up from there.
    setStatus('waiting');
  }, []);

  /**
   * Owns the whole listener lifecycle, keyed on status.
   *
   * Subscribing here rather than in an imperative attach() keeps it symmetric
   * with the cleanup, which matters under StrictMode's deliberate
   * mount-unmount-remount: an imperative version guarded by a ref would tear
   * the listeners down and then decline to rebuild them.
   */
  useEffect(() => {
    // 'waiting' is only ever reached once there is nothing left to ask for:
    // either the platform needs no prompt, or enable() has already been granted
    // one. Re-testing needsPermissionPrompt() here would be wrong; it keeps
    // reporting true on iOS long after the user has said yes.
    if (status !== 'waiting' && status !== 'active') return;

    // `deviceorientationabsolute` is north-referenced where it exists (Chrome on
    // Android); plain `deviceorientation` may not be, which we surface as a warning.
    const hasAbsolute = 'ondeviceorientationabsolute' in window;
    if (hasAbsolute) {
      window.addEventListener('deviceorientationabsolute', handleEvent as EventListener);
    }
    window.addEventListener('deviceorientation', handleEvent);

    /*
     * Android's better answer, where the browser has it.
     *
     * AbsoluteOrientationSensor fuses the magnetometer with the gyroscope and
     * hands back a quaternion in the same east-north-up frame, at a rate we ask
     * for and with no Euler-angle gimbal problem near the zenith, which is
     * exactly where someone holding a phone up at the sky spends their time.
     * It also settles the question the events leave open, since a reading from
     * this sensor is north-referenced by definition rather than by hope.
     *
     * Strictly an upgrade: the events stay subscribed underneath, so if the
     * sensor is missing, blocked by permissions policy, or errors out on a
     * device with no magnetometer, nothing needs to be undone.
     */
    let sensor: { stop: () => void } | null = null;
    let cancelled = false;

    void (async () => {
      const Ctor = (window as unknown as { AbsoluteOrientationSensor?: SensorConstructor })
        .AbsoluteOrientationSensor;
      if (!Ctor || !navigator.permissions) return;

      try {
        const grants = await Promise.all(
          (['accelerometer', 'gyroscope', 'magnetometer'] as const).map((name) =>
            navigator.permissions
              .query({ name: name as PermissionName })
              .then((r) => r.state)
              .catch(() => 'denied' as const),
          ),
        );
        if (cancelled || grants.some((state) => state === 'denied')) return;

        const instance = new Ctor({ frequency: 30, referenceFrame: 'device' });
        instance.addEventListener('reading', () => {
          const q = instance.quaternion;
          if (!q) return;
          const [x, y, z, w] = q;
          applyRotation(
            [
              [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
              [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
              [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
            ],
            true,
            null,
          );
        });
        instance.addEventListener('error', (event: Event) => {
          const reason = (event as ErrorEvent).error?.name ?? 'unknown';
          if (import.meta.env.DEV) {
            console.info(`[compass] AbsoluteOrientationSensor unavailable (${reason}); using events`);
          }
        });
        instance.start();
        if (cancelled) instance.stop();
        else sensor = instance;
      } catch (err) {
        if (import.meta.env.DEV) console.info('[compass] sensor setup failed; using events', err);
      }
    })();

    // Desktop browsers expose the API and then never fire. Give up rather than
    // leaving "waiting for the compass" on screen indefinitely. Phones deliver
    // a first reading within a frame or two of the listener attaching, at rest
    // and without waiting for movement, so this only ever expires on hardware
    // that genuinely has nothing to report.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (status === 'waiting') {
      timer = setTimeout(() => {
        setStatus((current) => (current === 'waiting' ? 'unsupported' : current));
      }, 5000);
    }

    return () => {
      cancelled = true;
      sensor?.stop();
      if (timer) clearTimeout(timer);
      if (hasAbsolute) {
        window.removeEventListener('deviceorientationabsolute', handleEvent as EventListener);
      }
      window.removeEventListener('deviceorientation', handleEvent);
    };
  }, [status, handleEvent, applyRotation]);

  const nudgeCalibration = useCallback((delta: number) => {
    setCalibration((prev) => {
      const next = ((prev + delta) % 360 + 360) % 360;
      localStorage.setItem('borrowed-sky:compass-offset', String(next));
      return next;
    });
  }, []);

  const resetCalibration = useCallback(() => {
    setCalibration(0);
    localStorage.setItem('borrowed-sky:compass-offset', '0');
  }, []);

  /*
   * The live aim, with the user's compass correction applied.
   *
   * Wrapped rather than folded into sample() itself so the filter keeps
   * working on raw sensor directions: nudging the calibration while the view
   * is live should turn the sky immediately, not send the filter chasing a
   * target that moved for reasons the phone never saw.
   */
  const sampleAimed = useCallback(
    (nowMs: number) => {
      const aim = sample(nowMs);
      return { ...aim, azimuth: (aim.azimuth + calibration) % 360 };
    },
    [sample, calibration],
  );

  return {
    status,
    sample: sampleAimed,
    azimuth: (reading.azimuth + calibration) % 360,
    altitude: reading.altitude,
    roll: reading.roll,
    absolute: reading.absolute,
    accuracyDegrees: reading.accuracyDegrees,
    calibration,
    enable,
    disable,
    nudgeCalibration,
    resetCalibration,
  };
}
