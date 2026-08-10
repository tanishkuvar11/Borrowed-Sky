/**
 * Device orientation, turned into a direction the sky view can point.
 *
 * This is the least reliable input in the app and it is treated that way. The
 * browser compass drifts, needs figure-of-eight calibration, and on iOS cannot
 * even be read without an explicit tap. So this hook reports exactly what it
 * knows — whether the reading is north-referenced, and how confident the
 * platform says it is — and the interface never pretends a fallback is live
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

function needsPermissionPrompt(): boolean {
  const ctor = window.DeviceOrientationEvent as unknown as PermissionCapableEvent | undefined;
  return typeof ctor?.requestPermission === 'function';
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
  const [status, setStatus] = useState<OrientationStatus>(() => {
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return 'unsupported';
    return needsPermissionPrompt() ? 'needs-permission' : 'waiting';
  });

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

  const handleEvent = useCallback((event: DeviceOrientationEvent) => {
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
    const r = [
      [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
      [sA * cG + cA * sB * sG, cA * cB, sA * sG - cA * sB * cG],
      [-cB * sG, sB, cB * cG],
    ];

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

    setReading({
      azimuth,
      altitude,
      roll,
      absolute,
      accuracyDegrees:
        typeof ios.webkitCompassAccuracy === 'number' && ios.webkitCompassAccuracy >= 0
          ? ios.webkitCompassAccuracy
          : null,
    });
    setStatus('active');
  }, []);

  const disable = useCallback(() => {
    smoothRef.current = null;
    setStatus(needsPermissionPrompt() ? 'needs-permission' : 'waiting');
  }, []);

  const enable = useCallback(async () => {
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

    // Moving to `waiting` is all that is needed — the effect below owns the
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
    const shouldListen = status === 'waiting' || status === 'active';
    if (!shouldListen || (status === 'waiting' && needsPermissionPrompt())) return;

    // `deviceorientationabsolute` is north-referenced where it exists (Chrome on
    // Android); plain `deviceorientation` may not be, which we surface as a warning.
    const hasAbsolute = 'ondeviceorientationabsolute' in window;
    if (hasAbsolute) {
      window.addEventListener('deviceorientationabsolute', handleEvent as EventListener);
    }
    window.addEventListener('deviceorientation', handleEvent);

    // Desktop browsers expose the API and then never fire. Give up rather than
    // leaving "waiting for the compass" on screen indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (status === 'waiting') {
      timer = setTimeout(() => {
        setStatus((current) => (current === 'waiting' ? 'unsupported' : current));
      }, 3000);
    }

    return () => {
      if (timer) clearTimeout(timer);
      if (hasAbsolute) {
        window.removeEventListener('deviceorientationabsolute', handleEvent as EventListener);
      }
      window.removeEventListener('deviceorientation', handleEvent);
    };
  }, [status, handleEvent]);

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
