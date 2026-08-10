/**
 * The sky screen: the canvas, the controls that aim it, and the panel that
 * explains whatever you tapped.
 *
 * There are two ways to aim: the compass, and dragging. The compass is better
 * when it works, so the app offers it first — but it is never assumed, and the
 * drag fallback is a labelled first-class mode rather than a silent degradation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MakeTime } from 'astronomy-engine';

import { SkyCanvas } from './SkyCanvas';
import { ObjectSheet } from './ObjectSheet';
import { useOrientation } from '../hooks/useOrientation';
import {
  eqjToHorMatrix,
  horVectorToAltAz,
  rotateEqjToHor,
  type Camera,
} from '../lib/astro/frames';
import { starToBody, type ConstellationFigure, type StarCatalog } from '../lib/astro/starfield';
import { toObserver } from '../lib/astro/solar';
import { compassPoint } from '../lib/astro/satellites';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';
import type { TonightTimeline } from '../lib/astro/events';
import type { Tone } from '../lib/ai';

const MIN_FOV = 20;
const MAX_FOV = 110;

export interface SkyViewProps {
  catalog: StarCatalog | null;
  constellations: ConstellationFigure[];
  bodies: SkyBody[];
  site: ObserverSite;
  now: Date;
  conditions: SkyConditions | null;
  timeline: TonightTimeline | null;
  tone: Tone;
  loadingCatalog: boolean;
  catalogError: string | null;
  nightVision: boolean;
  onToneChange: (tone: Tone) => void;
  onRecord: (body: SkyBody) => void;
  isLogged: (name: string) => boolean;
}

export function SkyView({
  catalog,
  constellations,
  bodies,
  site,
  now,
  conditions,
  timeline,
  tone,
  loadingCatalog,
  catalogError,
  nightVision,
  onToneChange,
  onRecord,
  isLogged,
}: SkyViewProps) {
  const orientation = useOrientation();
  const [followCompass, setFollowCompass] = useState(true);
  const [fov, setFov] = useState(75);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showConstellations, setShowConstellations] = useState(true);
  const [showGrid, setShowGrid] = useState(true);

  // Where the view points when the compass is not driving it. Starts aimed at
  // the celestial equator's high point for this latitude, which is where most
  // of the planets will be.
  const [manualAim, setManualAim] = useState(() => ({
    azimuth: site.latitude >= 0 ? 180 : 0,
    altitude: 45,
    roll: 0,
  }));

  const compassLive = orientation.status === 'active' && followCompass;

  const camera: Camera = useMemo(
    () =>
      compassLive
        ? {
            azimuth: orientation.azimuth,
            altitude: orientation.altitude,
            roll: orientation.roll,
            fov,
          }
        : { ...manualAim, fov },
    [compassLive, orientation.azimuth, orientation.altitude, orientation.roll, manualAim, fov],
  );

  // Dragging takes over from the compass, but remembers where it was aimed so
  // the view does not jump when control changes hands.
  const cameraRef = useRef(camera);
  cameraRef.current = camera;

  const handlePan = useCallback(
    (deltaAzimuth: number, deltaAltitude: number) => {
      if (followCompass && orientation.status === 'active') {
        setFollowCompass(false);
        setManualAim({
          azimuth: cameraRef.current.azimuth,
          altitude: cameraRef.current.altitude,
          roll: 0,
        });
      }
      setManualAim((prev) => ({
        azimuth: ((prev.azimuth + deltaAzimuth) % 360 + 360) % 360,
        altitude: Math.max(-20, Math.min(89, prev.altitude + deltaAltitude)),
        roll: 0,
      }));
    },
    [followCompass, orientation.status],
  );

  const handleZoom = useCallback((factor: number) => {
    setFov((prev) => Math.max(MIN_FOV, Math.min(MAX_FOV, prev * factor)));
  }, []);

  // --- turn a tapped id back into a full object ---------------------------

  const constellationNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const figure of constellations) map.set(figure.id, figure.name);
    return map;
  }, [constellations]);

  const selectedBody = useMemo<SkyBody | null>(() => {
    if (!selectedId) return null;

    const known = bodies.find((b) => b.id === selectedId);
    if (known) return known;

    if (selectedId.startsWith('star-') && catalog) {
      const index = Number.parseInt(selectedId.slice(5), 10);
      if (!Number.isFinite(index) || index < 0 || index >= catalog.count) return null;

      const matrix = eqjToHorMatrix(MakeTime(now), toObserver(site));
      const offset = index * 3;
      const { altitude, azimuth } = horVectorToAltAz(
        rotateEqjToHor(matrix, {
          x: catalog.vectors[offset],
          y: catalog.vectors[offset + 1],
          z: catalog.vectors[offset + 2],
        }),
      );
      return starToBody(
        catalog,
        index,
        altitude,
        azimuth,
        constellationNames.get(catalog.constellation[index]),
      );
    }

    return null;
  }, [selectedId, bodies, catalog, now, site, constellationNames]);

  // Keep the sheet from lingering over an object that has since set.
  useEffect(() => {
    if (selectedBody && selectedBody.altitude < -5) setSelectedId(null);
  }, [selectedBody]);

  const aimStatus = compassLive
    ? `Tracking · facing ${compassPoint(camera.azimuth)}`
    : `Drag to look around · facing ${compassPoint(camera.azimuth)}`;

  return (
    <div className="sky-view">
      {catalog ? (
        <SkyCanvas
          catalog={catalog}
          constellations={constellations}
          bodies={bodies}
          site={site}
          now={now}
          camera={camera}
          conditions={conditions}
          selectedId={selectedId}
          showConstellations={showConstellations}
          showGrid={showGrid}
          nightVision={nightVision}
          onSelect={setSelectedId}
          onPan={handlePan}
          onZoom={handleZoom}
        />
      ) : (
        <div className="sky-view__loading">
          {catalogError ? (
            <>
              <p className="engrave">Sky data unavailable</p>
              <p className="sky-view__loading-text">{catalogError}</p>
              <p className="provenance">
                Nothing is drawn rather than drawing something invented. Reload to try again.
              </p>
            </>
          ) : (
            <>
              <p className="engrave">Loading</p>
              <p className="sky-view__loading-text">
                {loadingCatalog ? 'Reading the star catalogue…' : 'Preparing the sky…'}
              </p>
            </>
          )}
        </div>
      )}

      <div className="sky-view__status">
        <span className="readout">{aimStatus}</span>
        <span className="readout sky-view__fov">{Math.round(fov)}° field</span>
      </div>

      <CompassControls orientation={orientation} following={compassLive} onFollow={setFollowCompass} />

      <div className="sky-view__layers">
        <button
          className={showConstellations ? 'pill is-on' : 'pill'}
          onClick={() => setShowConstellations((v) => !v)}
          aria-pressed={showConstellations}
        >
          Figures
        </button>
        <button
          className={showGrid ? 'pill is-on' : 'pill'}
          onClick={() => setShowGrid((v) => !v)}
          aria-pressed={showGrid}
        >
          Grid
        </button>
      </div>

      {selectedBody && conditions && (
        <ObjectSheet
          body={selectedBody}
          site={site}
          now={now}
          bodies={bodies}
          conditions={conditions}
          timeline={timeline}
          tone={tone}
          alreadyLogged={isLogged(selectedBody.name)}
          onToneChange={onToneChange}
          onClose={() => setSelectedId(null)}
          onRecord={onRecord}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CompassControls({
  orientation,
  following,
  onFollow,
}: {
  orientation: ReturnType<typeof useOrientation>;
  following: boolean;
  onFollow: (on: boolean) => void;
}) {
  const [showCalibration, setShowCalibration] = useState(false);

  if (orientation.status === 'unsupported') {
    return (
      <div className="compass-bar">
        <p className="compass-bar__note">
          This device has no compass. Drag the sky to look around — everything shown is still
          computed for your exact place and time.
        </p>
      </div>
    );
  }

  if (orientation.status === 'needs-permission') {
    return (
      <div className="compass-bar">
        <button
          className="button button--primary"
          onClick={() => {
            void orientation.enable();
          }}
        >
          Turn on compass tracking
        </button>
        <p className="compass-bar__note">
          Your phone needs your permission to read its compass. Until then, drag to look around.
        </p>
      </div>
    );
  }

  if (orientation.status === 'denied') {
    return (
      <div className="compass-bar">
        <p className="compass-bar__note">
          Compass access was declined, so the view will not follow your phone. Drag to look around,
          or allow motion access in your browser settings and reload.
        </p>
      </div>
    );
  }

  if (orientation.status === 'waiting') {
    return (
      <div className="compass-bar">
        <p className="compass-bar__note">Waiting for the compass… move your phone a little.</p>
      </div>
    );
  }

  return (
    <div className="compass-bar compass-bar--active">
      <div className="compass-bar__row">
        <button
          className={following ? 'pill is-on' : 'pill'}
          onClick={() => onFollow(!following)}
          aria-pressed={following}
        >
          {following ? 'Following your phone' : 'Follow my phone'}
        </button>
        <button className="pill" onClick={() => setShowCalibration((v) => !v)}>
          Calibrate
        </button>
      </div>

      {!orientation.absolute && (
        <p className="compass-bar__warn">
          This browser is reporting a heading with no true-north reference, so the direction may be
          rotated. Point your phone at a landmark you can identify and nudge the correction below.
        </p>
      )}
      {orientation.absolute && orientation.accuracyDegrees !== null && orientation.accuracyDegrees > 20 && (
        <p className="compass-bar__warn">
          Your phone reports the compass is only accurate to about {Math.round(orientation.accuracyDegrees)}°.
          Wave it in a figure of eight to recalibrate.
        </p>
      )}

      {showCalibration && (
        <div className="calibration">
          <span className="engrave">Correction</span>
          <button className="pill" onClick={() => orientation.nudgeCalibration(-5)} aria-label="Rotate left 5 degrees">
            −5°
          </button>
          <span className="readout calibration__value">
            {orientation.calibration > 180
              ? `${(orientation.calibration - 360).toFixed(0)}°`
              : `${orientation.calibration.toFixed(0)}°`}
          </span>
          <button className="pill" onClick={() => orientation.nudgeCalibration(5)} aria-label="Rotate right 5 degrees">
            +5°
          </button>
          <button className="pill" onClick={orientation.resetCalibration}>
            Reset
          </button>
        </div>
      )}
    </div>
  );
}
