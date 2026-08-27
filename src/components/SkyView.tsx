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
import { IconCompassRose } from './icons';
import { orientationState, type Orientation } from './OrientationSheet';
import {
  eqjToHorMatrix,
  horVectorToAltAz,
  rotateEqjToHor,
  type Camera,
} from '../lib/astro/frames';
import { starToBody, type ConstellationFigure, type StarCatalog } from '../lib/astro/starfield';
import { toObserver } from '../lib/astro/solar';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';
import type { Place } from '../lib/place';
import type { TonightTimeline } from '../lib/astro/events';
import type { Tone } from '../lib/ai';

/**
 * What the sky says about its own aim, when it is not following the phone.
 *
 * One line each, written as the thing you would do rather than as the state
 * you are in. `live` is absent on purpose: there is nothing to offer somebody
 * whose view is already turning with them.
 *
 * `blocked` is the desktop case and the plain-http case, where the sensor is
 * not coming. It still gets a line, because "you cannot have this here" is
 * useful the first time somebody wonders why the sky will not turn, and the
 * sheet behind it explains which of the two reasons applies.
 */
const COMPASS_PROMPT: Record<string, string> = {
  ask: 'Compass orientation off. Tap to use it',
  paused: 'Compass orientation paused. Tap to resume',
  blocked: 'Compass orientation unavailable here',
};

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
  skyModel: boolean;
  orientation: Orientation;
  followCompass: boolean;
  onFollowCompass: (on: boolean) => void;
  onOpenCompass: () => void;
  /** Looked up for the observer's coordinates, or null while it is still in the air. */
  place: Place | null;
  onToneChange: (tone: Tone) => void;
  onRecord: (body: SkyBody) => void;
  onOpenGuide: () => void;
  isLogged: (name: string) => boolean;
  /**
   * The bottom navigation, so labels can keep clear of it.
   *
   * It belongs to the app rather than to this view, and the canvas is full
   * bleed underneath it, so without this the label placer cannot see the one
   * piece of furniture that covers the bottom of the sky.
   */
  railRef: React.RefObject<HTMLElement | null>;
}

export function SkyView({
  railRef,
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
  skyModel,
  orientation,
  followCompass,
  onFollowCompass,
  onOpenCompass,
  place,
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

  /*
   * The column starts shut.
   *
   * Only the phone layout honours this; the stylesheet ignores it on anything
   * with room, so the desktop column is permanently open and this costs it
   * nothing. On a phone the first thing you should meet is the sky, not a list
   * of panels sitting on top of it, and the list is one tap away rather than
   * gone. Tapping the tab you are already on shuts it again, so the way out is
   * the way in.
   */
  const [columnOpen, setColumnOpen] = useState(false);

  // Picking a tab always opens onto it. Closing is the disclosure's job,
  // so that there is exactly one control that shuts the column and it is the
  // one pointing at it.
  const openColumn = useCallback((next: RailTab) => {
    setRailTab(next);
    setColumnOpen(true);
  }, []);

  const toggleColumn = useCallback(() => setColumnOpen((on) => !on), []);

  // The chart's labels cannot see the panels floating over it, so it is told.
  const asideRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  /*
   * The bottom deck is furniture too.
   *
   * It holds the heading dial and the compass prompt, both of which sit over
   * the sky, and neither was reserved. A constellation name placed underneath
   * them is drawn and then covered, which costs a label and gains nothing: on
   * a tablet in landscape, COMA BERENICES was printing straight through the
   * cardinal mark and the brass rule.
   */
  const dialRef = useRef<HTMLDivElement>(null);
  const obstacles = useMemo(() => [asideRef, deckRef, dialRef, railRef], [railRef]);

  // Where the view points when the compass is not driving it. Starts aimed at
  // the celestial equator's high point for this latitude, which is where most
  // of the planets will be.
  const [manualAim, setManualAim] = useState(() => ({
    azimuth: site.latitude >= 0 ? 180 : 0,
    altitude: 45,
    roll: 0,
  }));

  const compassLive = orientation.status === 'active' && followCompass;
  const compassMode = orientationState(orientation, followCompass);
  const compassPrompt = COMPASS_PROMPT[compassMode];

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

  /*
   * The compass aim, read at frame time rather than at render time.
   *
   * `camera` above still exists and is still correct, but it only changes when
   * something re-renders this component, and while the compass is driving that
   * happens on the sensor's schedule rather than the display's. Handing the
   * canvas a function instead lets it ask where to point at the moment it is
   * about to draw, which is the only moment the answer matters.
   */
  const sampleOrientation = orientation.sample;
  const sampleCamera = useCallback(
    (nowMs: number): Camera => ({ ...sampleOrientation(nowMs), fov }),
    [sampleOrientation, fov],
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

  /*
   * Picking something out of the column aims the chart at it.
   *
   * Without this the column and the chart are two separate things: you choose
   * Saturn, a dossier opens, and the sky carries on pointing somewhere else
   * with a tracking reticle drawn around a marker that is nowhere on screen.
   * Selecting a target and slewing to it is one action, not two.
   *
   * Tapping a marker that is already on the chart does not slew — it is
   * already where you are looking, and moving the sky out from under the
   * finger that just touched it would be worse than doing nothing.
   */
  const slewRef = useRef<number | null>(null);

  const slewTo = useCallback(
    (body: SkyBody) => {
      if (followCompass && orientation.status === 'active') onFollowCompass(false);

      const from = { ...cameraRef.current };
      // The short way round: aiming east from a view facing west should turn
      // through south, not spin the whole card through north.
      let delta = body.azimuth - from.azimuth;
      while (delta > 180) delta -= 360;
      while (delta < -180) delta += 360;

      const target = { azimuth: from.azimuth + delta, altitude: Math.max(-10, Math.min(85, body.altitude)) };
      const start = performance.now();
      const DURATION = 620;

      if (slewRef.current !== null) cancelAnimationFrame(slewRef.current);

      // Reduced motion means arrive, not travel.
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setManualAim({ azimuth: ((target.azimuth % 360) + 360) % 360, altitude: target.altitude, roll: 0 });
        return;
      }

      const step = () => {
        const p = Math.min(1, (performance.now() - start) / DURATION);
        // Ease out cubic: leaves quickly, settles slowly, which is how a
        // damped mount actually behaves.
        const e = 1 - Math.pow(1 - p, 3);
        setManualAim({
          azimuth: (((from.azimuth + delta * e) % 360) + 360) % 360,
          altitude: from.altitude + (target.altitude - from.altitude) * e,
          roll: 0,
        });
        if (p < 1) slewRef.current = requestAnimationFrame(step);
        else slewRef.current = null;
      };
      slewRef.current = requestAnimationFrame(step);
    },
    [followCompass, orientation.status, onFollowCompass],
  );

  useEffect(
    () => () => {
      if (slewRef.current !== null) cancelAnimationFrame(slewRef.current);
    },
    [],
  );

  const selectFromList = useCallback(
    (id: string) => {
      setSelectedId(id);
      const body = bodies.find((b) => b.id === id);
      if (body) slewTo(body);
    },
    [bodies, slewTo],
  );

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


  return (
    <div className={selectedBody ? 'sky-view sky-view--tracking' : 'sky-view'}>
      {catalog ? (
        <SkyCanvas
          catalog={catalog}
          constellations={constellations}
          bodies={bodies}
          site={site}
          now={now}
          camera={camera}
          sampleCamera={compassLive ? sampleCamera : undefined}
          conditions={conditions}
          selectedId={selectedId}
          showConstellations={showConstellations}
          showGrid={showGrid}
          obstacles={obstacles}
          nightVision={nightVision}
          skyModel={skyModel}
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
      <div className={columnOpen ? 'sky-view__aside is-open' : 'sky-view__aside'} ref={asideRef}>
        <ReadoutPanel site={site} now={now} place={place} />
        <ObjectRail
          bodies={bodies}
          tab={railTab}
          open={columnOpen}
          onOpen={openColumn}
          onToggle={toggleColumn}
          fov={fov}
          selectedId={selectedId}
          onSelect={selectFromList}
          showConstellations={showConstellations}
          onShowConstellations={setShowConstellations}
          showGrid={showGrid}
          onShowGrid={setShowGrid}
        />
      </div>

      {/*
        The briefing, opposite the objects rather than under them.

        It was full width across the bottom of the frame, which is fine on a
        phone and wrong on anything wider: the object column is pinned to the
        left, the briefing ran underneath it, and on a laptop the column simply
        sat on top of the first third of every sentence. Two floating columns
        facing each other across the sky is the arrangement the frame was
        already half using; this is the other half of it.
      */}
      {conditions && (
        <div className="sky-view__brief" ref={deckRef}>
          <GuidePlaque onOpenGuide={onOpenGuide} />
        </div>
      )}

      {/*
        The horizon is the lowest thing the sky has, so it sits lowest, on the
        rail. Nothing floats under it.
      */}
      <div className="sky-view__deck" ref={dialRef}>
        {/*
          What to do about it, when the view is not following the phone.

          The header says which mode the compass is in, in a word, which tells
          you the state and nothing about what you can do with it. "Manual"
          answers a question nobody asked; the question people actually have,
          standing outside holding a phone up at the sky, is whether this thing
          can turn with them. So when it can and is not, the sky itself says so,
          in a sentence, on the control that would turn it on.

          Nothing when it is already live. A prompt that is always there is
          furniture, and the whole point of this one is that it means something
          when it appears.
        */}
        {compassPrompt && (
          <button
            className={`compass-prompt compass-prompt--${compassMode}`}
            onClick={compassMode === 'paused' ? () => onFollowCompass(true) : onOpenCompass}
          >
            <IconCompassRose size={14} />
            <span>{compassPrompt}</span>
          </button>
        )}

        <HorizonDial heading={camera.azimuth} live={compassLive} />
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
