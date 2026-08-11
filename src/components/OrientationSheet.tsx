/**
 * Everything about the compass, in one place.
 *
 * The header carries a single brass rose that shows orientation state at a
 * glance; this is what opens behind it. Consolidating it here keeps the sky
 * itself uncluttered while giving each of the ways orientation can fail — no
 * secure connection, no permission, no sensor — the room to say what it actually
 * is and what to do about it. None of them is allowed to degrade into a vague
 * "not working".
 */

import type { useOrientation } from '../hooks/useOrientation';

export type Orientation = ReturnType<typeof useOrientation>;

export function orientationState(
  orientation: Orientation,
  following: boolean,
): 'live' | 'paused' | 'ask' | 'blocked' {
  if (orientation.status === 'active') return following ? 'live' : 'paused';
  if (orientation.status === 'needs-permission') return 'ask';
  if (orientation.status === 'waiting') return 'ask';
  return 'blocked';
}

export function OrientationSheet({
  orientation,
  following,
  onFollow,
  onClose,
}: {
  orientation: Orientation;
  following: boolean;
  onFollow: (on: boolean) => void;
  onClose: () => void;
}) {
  const { status } = orientation;

  return (
    <div className="dialog" role="dialog" aria-label="Compass">
      <div className="dialog__scrim" onClick={onClose} />
      <div className="dialog__panel panel">
        <div className="dialog__head">
          <h2 className="dialog__title">Compass</h2>
          <button className="dialog__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        {status === 'active' && (
          <>
            <p className="dialog__lead">
              The view is reading your phone's compass. Turn around and the sky turns with you.
            </p>
            <div className="dialog__row">
              <button
                className={following ? 'pill is-on' : 'pill'}
                onClick={() => onFollow(!following)}
                aria-pressed={following}
              >
                {following ? 'Following your phone' : 'Follow my phone'}
              </button>
              <span className="readout dialog__value">{Math.round(orientation.azimuth)}°</span>
            </div>

            {!orientation.absolute && (
              <p className="dialog__warn">
                This browser reports a heading with no true-north reference, so the direction may be
                rotated. Point at a landmark you can identify and nudge the correction below.
              </p>
            )}
            {orientation.absolute && orientation.accuracyDegrees !== null &&
              orientation.accuracyDegrees > 20 && (
                <p className="dialog__warn">
                  Your phone reports the compass is only accurate to about{' '}
                  {Math.round(orientation.accuracyDegrees)}°. Wave it in a figure of eight to
                  recalibrate.
                </p>
              )}

            <div className="hairline" />
            <div className="dialog__row">
              <span className="engrave">Correction</span>
              <button className="pill" onClick={() => orientation.nudgeCalibration(-5)}>
                −5°
              </button>
              <span className="readout dialog__value">
                {orientation.calibration > 180
                  ? `${(orientation.calibration - 360).toFixed(0)}°`
                  : `${orientation.calibration.toFixed(0)}°`}
              </span>
              <button className="pill" onClick={() => orientation.nudgeCalibration(5)}>
                +5°
              </button>
              <button className="pill" onClick={orientation.resetCalibration}>
                Reset
              </button>
            </div>
          </>
        )}

        {status === 'needs-permission' && (
          <>
            <p className="dialog__lead">
              Your phone needs your permission before a web page can read its compass.
            </p>
            <button
              className="button button--primary"
              onClick={() => {
                void orientation.enable();
              }}
            >
              Turn on compass tracking
            </button>
          </>
        )}

        {status === 'waiting' && (
          <p className="dialog__lead">Waiting for the first reading… move your phone a little.</p>
        )}

        {status === 'insecure-context' && (
          <>
            <p className="dialog__lead">
              This page is on <code>http://{window.location.host}</code>, and browsers only release
              the compass over <code>https://</code>.
            </p>
            <p className="dialog__note">
              That block is the connection, not your device — over an insecure address we cannot
              even tell whether there is a compass to read. Everything else on this screen is
              unaffected.
            </p>
          </>
        )}

        {status === 'denied' && (
          <>
            <p className="dialog__lead">Compass access was declined, so the view will not follow your phone.</p>
            <p className="dialog__note">
              If you never saw a prompt, iPhone blocks it at the system level: Settings → Apps →
              Safari → Motion &amp; Orientation Access. Turn that on and reload.
            </p>
          </>
        )}

        {status === 'unsupported' && (
          <p className="dialog__lead">
            This device did not report a compass, so the sky is yours to drag.
          </p>
        )}

        <div className="hairline" />
        <p className="provenance">
          Manual mode is a full mode, not a failure: every position on screen is computed for your
          exact place and time either way. The compass only decides which part of that sky you are
          shown.
        </p>
      </div>
    </div>
  );
}
