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

export function useOrientation(): OrientationReading & {
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

  // Smoothed look and up vectors. Filtering direction vectors rather than
  // angles avoids the discontinuity where a heading wraps past north.
  const smoothRef = useRef<{ look: number[]; up: number[] } | null>(null);

  /**
   * Turns a device-to-world rotation into an aim.
   *
   * Shared by both sources, because the two of them disagree about how to
   * describe an orientation (Euler angles from the events, a quaternion from
   * the sensor) but agree completely about the frame it is expressed in. Doing
   * the conversion once means the filtering, the roll solution and the
   * screen-rotation handling cannot drift apart between them.
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

      // Low-pass filter. Phone gyros are noisy enough that unfiltered stars visibly
      // shimmer; this is gentle enough to stay responsive when you actually turn.
      const alphaFilter = 0.25;
      const prev = smoothRef.current;
      const blend = (a: number[], b: number[]) =>
        a.map((v, i) => v * (1 - alphaFilter) + b[i] * alphaFilter);
      const look = prev ? blend(prev.look, lookWorld) : lookWorld;
      const up = prev ? blend(prev.up, upWorld) : upWorld;
      smoothRef.current = { look, up };

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

      setReading({ azimuth, altitude, roll, absolute, accuracyDegrees });
      setStatus('active');
    },
    [],
  );

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

  return {
    status,
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
