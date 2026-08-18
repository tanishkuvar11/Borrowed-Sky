/**
 * The sky screen: the canvas, the instruments read off it, and the panel that
 * explains whatever you tapped.
 *
 * There are two ways to aim: the compass, and dragging. The compass is better
 * when it works, so the app offers it first, but it is never assumed, and the
 * drag fallback is a labelled first-class mode rather than a silent degradation.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MakeTime } from 'astronomy-engine';

import { SkyCanvas } from './SkyCanvas';
import { ObjectSheet } from './ObjectSheet';
import { ObjectRail, type RailTab } from './ObjectRail';
import { ReadoutPanel } from './ReadoutPanel';
import { HorizonDial } from './HorizonDial';
import { GuidePlaque } from './GuidePlaque';
import { orientationState, type Orientation } from './OrientationSheet';
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

/** What the strip says when it is not being driven by the phone. */
const AIM_NOTE: Record<string, string> = {
  ask: 'Manual mode · tap the rose to use your compass',
  blocked: 'Manual mode · drag the sky to look around',
  paused: 'Manual mode · tap the emblem to follow your phone again',
};

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
  orientation: Orientation;
  followCompass: boolean;
  onFollowCompass: (on: boolean) => void;
  onOpenCompass: () => void;
  onChangeSite: () => void;
  onToneChange: (tone: Tone) => void;
  onRecord: (body: SkyBody) => void;
  onOpenGuide: () => void;
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
  orientation,
  followCompass,
  onFollowCompass,
  onOpenCompass,
  onChangeSite,
  onToneChange,
  onRecord,
  onOpenGuide,
  isLogged,
}: SkyViewProps) {
  const [fov, setFov] = useState(75);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showConstellations, setShowConstellations] = useState(true);
  const [showGrid, setShowGrid] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>('objects');

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
        onFollowCompass(false);
        setManualAim({
          azimuth: cameraRef.current.azimuth,
          altitude: cameraRef.current.altitude,
          roll: 0,
        });
      }
      setManualAim((prev) => ({
        azimuth: (((prev.azimuth + deltaAzimuth) % 360) + 360) % 360,
        altitude: Math.max(-20, Math.min(89, prev.altitude + deltaAltitude)),
        roll: 0,
      }));
    },
    [followCompass, orientation.status, onFollowCompass],
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

  const aimNote = AIM_NOTE[orientationState(orientation, followCompass)];

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

      {/*
        The left column. One stack, so the plate, the tabs and the list share an
        edge and a rhythm rather than each being placed against the frame on its
        own; three separately positioned panels down one side is what made this
        corner read as assembled.
      */}
      <div className="sky-view__aside">
        <ReadoutPanel site={site} now={now} onChangeSite={onChangeSite} />
        <ObjectRail
          bodies={bodies}
          tab={railTab}
          onTab={setRailTab}
          fov={fov}
          selectedId={selectedId}
          onSelect={setSelectedId}
          showConstellations={showConstellations}
          onShowConstellations={setShowConstellations}
          showGrid={showGrid}
          onShowGrid={setShowGrid}
        />
      </div>

      <div className="sky-view__deck">
        <HorizonDial heading={camera.azimuth} live={compassLive} />

        {aimNote && (
          <button className="aim-note" onClick={onOpenCompass}>
            {aimNote} · facing {compassPoint(camera.azimuth)}
          </button>
        )}

        {conditions && (
          <GuidePlaque
            site={site}
            now={now}
            bodies={bodies}
            conditions={conditions}
            timeline={timeline}
            tone={tone}
            onOpenGuide={onOpenGuide}
          />
        )}
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
