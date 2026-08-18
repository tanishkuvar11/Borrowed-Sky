/**
 * The way in.
 *
 * One sky, scrolled through. The canvas behind this page is the same renderer
 * the app uses, fed the same way: a real observer site, a real instant, real
 * ephemerides. Scroll moves two things at once: the camera tilts from the
 * horizon toward the zenith, and the clock runs from civil dusk to full
 * astronomical night, so the stars that appear as you scroll appear because
 * the sky is genuinely getting darker, not because something faded them in.
 *
 * WHOSE SKY THIS IS
 *
 * Nothing can be computed for the visitor until they say where they are, and
 * inventing a location to fill the gap is exactly the kind of thing this app
 * exists not to do. So the overture shows Greenwich (the line every longitude
 * in the app is measured from) and says so on screen the entire time, with the
 * coordinates and the exact instant being rendered visible in the corner. The
 * page never implies this is your sky. Its closing argument is that it isn't.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { SkyCanvas } from './SkyCanvas';
import { LocationAsk } from './LocationAsk';
import { IconEmblem } from './icons';
import { IconClock, IconPin, IconSpark, IconSunHorizon } from './overture-marks';
import { ease, span, useScrollProgress, prefersReducedMotion } from '../hooks/useScrollProgress';
import { computeConditions, computeSolarSystem } from '../lib/astro/solar';
import {
  loadConstellations,
  loadStarCatalog,
  type ConstellationFigure,
  type StarCatalog,
} from '../lib/astro/starfield';
import type { ObserverSite } from '../lib/astro/types';
import type { LocationStatus } from '../hooks/useObserverSite';

/**
 * The Royal Observatory. Chosen because it is the origin of the coordinate
 * system the whole app speaks in, so the page opens on the reference and closes
 * by asking for the visitor's offset from it.
 */
const GREENWICH: ObserverSite = {
  latitude: 51.4779,
  longitude: -0.0015,
  elevation: 47,
  source: 'manual',
  label: 'Royal Observatory, Greenwich',
};

/**
 * Sun altitudes that bound the scrub: civil dusk through astronomical night.
 *
 * The start is a few degrees down rather than above the horizon. Starting
 * earlier was tried, so the sun would visibly set, and it does not work: a
 * computed sunset is a smooth gradient with a small bright disc on it, because
 * that is honestly all a sunset is without mountains and cloud to catch the
 * light. The night is the opposite: thousands of real stars and the galactic
 * band give it structure for free. So this begins where the computation starts
 * being the best thing on screen.
 *
 * Eight degrees down rather than four, which is the difference between an
 * opening frame that is mostly bare gradient and one with something in it. The
 * renderer fades stars by `(-sunAltitude + 4) / 14`, so four degrees of Sun
 * depth is worth half again as much star brightness, and the Milky Way only
 * starts drawing at all below about six. The glow is still full strength here.
 */
const START_SUN_ALTITUDE = -8;
const END_SUN_ALTITUDE = -19;

export interface OvertureProps {
  status: LocationStatus;
  error: string | null;
  permission: PermissionState | 'unknown';
  onRequestGps: () => void;
  onManual: (latitude: number, longitude: number, label?: string) => void;
}

/**
 * Finds tonight's dusk at Greenwich by searching for the moment the Sun passes
 * a given depth below the horizon.
 *
 * A search rather than a formula because that is how the rest of the app finds
 * events too, and because it stays correct at latitudes and dates where the Sun
 * never reaches the depth asked for; it returns the darkest moment available
 * instead of a time that does not exist.
 */
function sunReaches(depth: number, from: Date, site: ObserverSite): Date {
  let best = from;
  let bestGap = Infinity;
  let darkest = from;
  let darkestAltitude = Infinity;

  // Ten-minute steps across the twelve hours after the starting point: fine
  // enough that the visual difference between adjacent steps is invisible.
  for (let minutes = 0; minutes <= 12 * 60; minutes += 10) {
    const when = new Date(from.getTime() + minutes * 60_000);
    const altitude = computeConditions(when, site).sunAltitude;
    if (altitude < darkestAltitude) {
      darkestAltitude = altitude;
      darkest = when;
    }
    const gap = Math.abs(altitude - depth);
    if (gap < bestGap) {
      bestGap = gap;
      best = when;
    }
  }

  // If the Sun never gets within a degree of the depth we wanted, this is a
  // white night: show the darkest the sky actually gets rather than a fiction.
  return bestGap > 1 ? darkest : best;
}

export function Overture({
  status,
  error,
  permission,
  onRequestGps,
  onManual,
}: OvertureProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const progress = useScrollProgress(scroller);
  const reduced = useMemo(prefersReducedMotion, []);

  const [catalog, setCatalog] = useState<StarCatalog | null>(null);
  const [constellations, setConstellations] = useState<ConstellationFigure[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    (async () => {
      try {
        const [stars, figures] = await Promise.all([
          loadStarCatalog(controller.signal),
          loadConstellations(controller.signal),
        ]);
        if (cancelled) return;
        setCatalog(stars);
        setConstellations(figures);
      } catch {
        // The overture is an argument for looking up, not a data view. If the
        // catalogue will not load, the sky simply stays empty here and the app
        // reports the failure properly once there is a site to report it for.
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  /**
   * Tonight's dusk and full dark at Greenwich.
   *
   * Anchored to midday rather than to the current moment. Searching forward
   * from "now" is correct for a daytime visitor and wrong for a 3am one: the
   * first time the Sun passes −1° after 3am is dawn, and the page would then
   * scrub from dawn towards daylight: the sky getting brighter, the stars
   * going out, the exact opposite of what the captions say is happening.
   */
  const [dusk, night] = useMemo(() => {
    const noon = new Date();
    noon.setUTCHours(12, 0, 0, 0);
    const start = sunReaches(START_SUN_ALTITUDE, noon, GREENWICH);
    return [start, sunReaches(END_SUN_ALTITUDE, start, GREENWICH)] as const;
  }, []);

  /**
   * The scrubbed instant. Eased rather than linear so the darkening slows as it
   * settles, which is also closer to how twilight actually behaves: the last
   * few degrees of Sun depth change the sky far less than the first few.
   */
  const when = useMemo(() => {
    const t = ease(span(progress, 0, 0.82));
    return new Date(dusk.getTime() + (night.getTime() - dusk.getTime()) * t);
  }, [progress, dusk, night]);

  // Sun, Moon and planets only. Satellites are deliberately absent: their
  // elements describe where a spacecraft is *now*, and this page is showing a
  // scrubbed instant, so propagating them here would put a real object at a
  // time it was never claimed to be at.
  const bodies = useMemo(() => {
    const { sun, moon, planets } = computeSolarSystem(when, GREENWICH);
    return [sun, moon, ...planets];
  }, [when]);

  const conditions = useMemo(() => computeConditions(when, GREENWICH), [when]);

  /**
   * The camera path, keyed to what each caption is claiming.
   *
   * A single sweep from horizon to zenith reads well in the abstract and fails
   * on the page: the caption about the afterglow arrives while the camera is
   * pointed at the opposite side of the sky, and the caption about the galaxy
   * arrives before the band is in frame. So the aim is keyframed against the
   * same scroll positions the captions use: down into the glow while the glow
   * is the subject, then round and up to where the band actually is by the time
   * the clock reaches full dark.
   *
   * The sunset bearing is read from the computed conditions rather than typed
   * in, so this keeps pointing at the real glow as the seasons move it.
   */
  const camera = useMemo(() => {
    const sunset = conditions.sunAzimuth;
    return {
      azimuth: track(progress, [
        [0, sunset],
        [0.34, sunset],
        [0.62, sunset - 120],
        [1, sunset - 170],
      ]),
      altitude: track(progress, [
        [0, 30],
        [0.24, 15],
        [0.4, 22],
        [0.72, 62],
        [1, 74],
      ]),
      roll: 0,
      fov: track(progress, [
        [0, 96],
        [1, 78],
      ]),
    };
  }, [progress, conditions.sunAzimuth]);

  const clock = when.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

  /**
   * Captions rise, hold, and leave, so only one is ever competing with the sky.
   *
   * The hero is the exception and has to be handled separately: it is what the
   * page looks like before anyone has scrolled at all, so it starts at full
   * strength and only fades out. Giving it the same rise as the others would
   * mean the page's first frame (the one most visitors judge it on) is an
   * empty sky with no words on it.
   */
  const hero = (() => {
    if (reduced) return { opacity: 1, lift: 0 };
    const out = ease(span(progress, 0.05, 0.13));
    return { opacity: 1 - out, lift: out * -22 };
  })();

  const panels = [
    { at: [0.14, 0.34] },
    { at: [0.38, 0.58] },
    { at: [0.62, 0.82] },
  ].map(({ at }) => {
    const t = span(progress, at[0], at[1]);
    // Quick in, long hold, quick out, rather than a sine, which spends most of
    // its travel part-faded and never lets a caption simply sit there and be read.
    const visible = reduced ? 1 : Math.min(1, ease(t / 0.28), ease((1 - t) / 0.22));
    return { opacity: Math.max(0, visible), lift: (1 - visible) * 22 };
  });

  const closing = span(progress, 0.86, 1);
  const skyDim = reduced ? 0.5 : 1 - 0.55 * ease(closing);

  return (
    <div className="overture" ref={scroller}>
      <div className="overture__stage" style={{ opacity: skyDim }} aria-hidden="true">
        {catalog && (
          <SkyCanvas
            catalog={catalog}
            constellations={constellations}
            bodies={bodies}
            site={GREENWICH}
            now={when}
            camera={camera}
            conditions={conditions}
            selectedId={null}
            // The figure lines carry the empty middle of the frame. They are
            // real geometry rather than decoration, and with `chrome` off they
            // draw without their names, so the sky gains structure without
            // becoming the labelled chart the app proper offers later.
            showConstellations={true}
            // Stood off the sunset bearing so it is in frame while the glow is
            // the subject, and pans away with the landscape after that.
            landmarkAzimuth={conditions.sunAzimuth + 36}
            showGrid={false}
            chrome={false}
            nightVision={false}
            onSelect={() => {}}
            onPan={() => {}}
            onZoom={() => {}}
          />
        )}

        {/*
          The instrument's own label. This is what stops the page being a mood
          piece: the place and the instant are on screen the whole time the sky
          is, so what is being shown is always attributed.

          It lives inside the sticky stage rather than fixed to the viewport so
          that it belongs to this sky and no other; fixed, it would keep
          floating over whatever section happened to scroll past next, labelling
          content it knows nothing about.
        */}
        <div className="overture__slate">
          <span className="engrave overture__slate-title">Royal Observatory, Greenwich</span>
          <span className="readout overture__reading">
            <IconPin />
            51.4779°N 0.0015°W
          </span>
          <span className="readout overture__reading overture__clock">
            <IconClock />
            {clock} UTC
          </span>
          {/*
            Why this instant and no other. The clock on its own invites the
            question "what is 20:20?", and the answer is the only thing that
            makes the time meaningful: it is where the Sun is. It counts down
            with the scroll, so the number the sky is being drawn from is
            visible the whole way rather than being something to take on trust.
          */}
          <span className="readout overture__reading overture__depth">
            <IconSunHorizon />
            Sun {Math.abs(conditions.sunAltitude).toFixed(1)}° below horizon
          </span>
        </div>
      </div>

      <div className="overture__flow">
        <section className="overture__panel overture__panel--hero" style={panelStyle(hero)}>
          <p className="engrave overture__eyebrow">
            Borrowed Sky
            <span className="overture__eyebrow-rule" aria-hidden="true" />
            <IconSpark size={11} />
          </p>
          <h1 className="overture__headline">
            Everything up there
            <br />
            has a <em>name</em>.
          </h1>
          {/* A ruled line with a glint at its waist, the way a scale is marked. */}
          <p className="overture__flourish" aria-hidden="true">
            <span className="overture__flourish-rule" />
            <IconSpark size={9} />
            <span className="overture__flourish-rule overture__flourish-rule--fade" />
          </p>
          <p className="overture__lede">
            <span className="overture__sentence">A distance.</span>
            <span className="overture__sentence">A position.</span>
            <span className="overture__sentence">A time it will disappear.</span>
            <span className="overture__sentence">
              This is Greenwich, an hour after sunset, where the world begins counting longitude.
            </span>
          </p>
          {!reduced && (
            <div className="overture__cue">
              {/* A dial with a weight falling down it: the page's own scrollbar,
                  drawn as an instrument rather than described in words. */}
              <span className="overture__cue-dial" aria-hidden="true">
                <span className="overture__cue-bob" />
              </span>
              <span className="overture__cue-text">
                <span className="engrave">Scroll</span>
                <span className="overture__cue-line">The night is arriving.</span>
              </span>
            </div>
          )}
        </section>

        <section className="overture__panel" style={panelStyle(panels[0])}>
          <h2 className="overture__title">
            The <em>Sun</em> has gone, but its <em>light</em> hasn&rsquo;t.
          </h2>
          <p className="overture__body">
            <span className="overture__sentence">
              Beneath the horizon, it leaves one last band of colour, exactly where it disappeared.
            </span>
          </p>
          <p className="overture__figure">{Math.round(conditions.sunAzimuth)}° from north.</p>
        </section>

        <section className="overture__panel" style={panelStyle(panels[1])}>
          <h2 className="overture__title">
            Then the <em>stars</em> begin to appear.
          </h2>
          <p className="overture__body">
            <span className="overture__sentence">The brightest first.</span>
            <span className="overture__sentence">
              The faintest only when the sky is dark enough to reveal them.
            </span>
          </p>
        </section>

        <section className="overture__panel" style={panelStyle(panels[2])}>
          <h2 className="overture__title">
            Then comes the <em>galaxy</em> you live in.
          </h2>
          <p className="overture__body">
            <span className="overture__sentence">
              The Milky Way, our own disc, seen from somewhere inside it.
            </span>
            <span className="overture__sentence">
              Tonight, above Greenwich, it crosses the sky at this angle.
            </span>
          </p>
        </section>

        <section className="overture__panel overture__panel--close">
          <div className="overture__plate" style={{ opacity: reduced ? 1 : ease(closing) }}>
            <span className="overture__mark" aria-hidden="true">
              <IconEmblem size={30} />
            </span>
            <h2 className="overture__title">
              But this isn&rsquo;t <em>your</em> sky.
            </h2>
            <p className="overture__body">
              <span className="overture__sentence">Your stars are different.</span>
              <span className="overture__sentence">Your horizon is different.</span>
              <span className="overture__sentence">The galaxy bends differently above you.</span>
              <span className="overture__sentence">Tell us where you&rsquo;re standing.</span>
            </p>
            <p className="overture__figure">
              We&rsquo;ll show you the sky that is actually there.
            </p>
            <LocationAsk
              status={status}
              error={error}
              permission={permission}
              onRequestGps={onRequestGps}
              onManual={onManual}
            />
            <p className="provenance provenance--block">
              <span className="overture__sentence">Star positions from the HYG catalogue.</span>
              <span className="overture__sentence">
                Planets and the Moon from astronomy-engine.
              </span>
              <span className="overture__sentence">
                Satellites propagated with SGP4 from Celestrak orbital elements.
              </span>
              <span className="overture__sentence">
                Explained by IBM Granite on watsonx.ai, from those numbers and nothing else.
              </span>
              <span className="overture__sentence">
                Nothing in this app is simulated or placeholder data, including the sky you just
                scrolled through.
              </span>
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

/**
 * Reads a keyframed track at a scroll position.
 *
 * Eased between neighbouring keys rather than linearly, so the camera arrives
 * and leaves each framing smoothly instead of changing direction with a visible
 * corner. Keys must be given in ascending order.
 */
function track(at: number, keys: Array<[number, number]>): number {
  if (at <= keys[0][0]) return keys[0][1];
  const last = keys[keys.length - 1];
  if (at >= last[0]) return last[1];
  for (let i = 1; i < keys.length; i++) {
    const [toAt, toValue] = keys[i];
    if (at > toAt) continue;
    const [fromAt, fromValue] = keys[i - 1];
    const t = ease((at - fromAt) / (toAt - fromAt));
    return fromValue + (toValue - fromValue) * t;
  }
  return last[1];
}

function panelStyle({ opacity, lift }: { opacity: number; lift: number }) {
  return {
    opacity,
    transform: `translate3d(0, ${lift}px, 0)`,
  };
}
