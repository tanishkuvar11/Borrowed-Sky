/**
 * What you get when you tap something in the sky.
 *
 * The panel leads with the measured facts (direction, height, brightness,
 * distance) and only then offers the narration. That order is deliberate: the
 * numbers are the product, and the prose is the translation of them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { PlanetMark } from './planet-marks';
import { askGuide, buildSkyContext, factFor, type GuideAnswer, type Tone } from '../lib/ai';
import { compassPoint, heightInWords } from '../lib/astro/satellites';
import { funFactFor, type Fact } from '../lib/facts';
import type { ObserverSite, SkyBody, SkyConditions } from '../lib/astro/types';
import type { TonightTimeline } from '../lib/astro/events';

export interface ObjectSheetProps {
  body: SkyBody;
  site: ObserverSite;
  now: Date;
  bodies: SkyBody[];
  conditions: SkyConditions;
  timeline: TonightTimeline | null;
  tone: Tone;
  alreadyLogged: boolean;
  onToneChange: (tone: Tone) => void;
  onClose: () => void;
  onRecord: (body: SkyBody) => void;
}

const KIND_LABEL: Record<string, string> = {
  star: 'Star',
  planet: 'Planet',
  moon: 'Moon',
  sun: 'Star: our own',
  satellite: 'Satellite',
};

function formatDistance(body: SkyBody): string | null {
  if (!body.distance) return null;
  const { value, unit } = body.distance;
  if (unit === 'ly') return `${value.toFixed(1)} light years`;
  if (unit === 'au') return `${value.toFixed(3)} AU`;
  return value > 1_000_000
    ? `${(value / 1_000_000).toFixed(2)} million km`
    : `${Math.round(value).toLocaleString()} km`;
}

export function ObjectSheet({
  body,
  site,
  now,
  bodies,
  conditions,
  timeline,
  tone,
  alreadyLogged,
  onToneChange,
  onClose,
  onRecord,
}: ObjectSheetProps) {
  const [answer, setAnswer] = useState<GuideAnswer | null>(null);
  const [fact, setFact] = useState<Fact | null>(null);
  const [asking, setAsking] = useState(false);

  /*
   * A new fact each time the sheet opens on something.
   *
   * Keyed on the object rather than fetched once, because the interesting case
   * is somebody tapping Venus, closing it, and tapping Venus again: the second
   * fact is what makes the app feel like it knows more than one thing. The
   * rotation lives in the facts module, which hands out the next one it has not
   * used for that object yet.
   */
  useEffect(() => {
    let cancelled = false;
    setFact(null);
    funFactFor(body.name, body.kind).then((found) => {
      if (!cancelled) setFact(found);
    });
    return () => {
      cancelled = true;
    };
  }, [body.id, body.name, body.kind]);
  const abortRef = useRef<AbortController | null>(null);

  // A new selection invalidates the previous explanation.
  useEffect(() => {
    setAnswer(null);
    abortRef.current?.abort();
  }, [body.id]);

  const explain = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setAsking(true);
    try {
      const context = buildSkyContext({
        now,
        site,
        bodies,
        conditions,
        timeline,
        focus: body,
        focusFact: factFor(body),
      });
      const result = await askGuide({ skyContext: context, tone, signal: controller.signal });
      setAnswer(result);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setAnswer(null);
    } finally {
      if (!controller.signal.aborted) setAsking(false);
    }
    // `bodies` and `now` tick every second; capturing them at click time is
    // intentional, so the explanation matches the moment the user asked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, site, conditions, timeline, tone]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const distance = formatDistance(body);
  const belowHorizon = body.altitude < 0;

  return (
    <aside className="sheet" role="dialog" aria-label={`About ${body.name}`}>
      <header className="sheet__head">
        <span className="sheet__portrait" aria-hidden>
          <PlanetMark
            name={body.name}
            kind={body.kind}
            illuminatedFraction={body.illuminatedFraction}
            size={52}
          />
        </span>
        <div>
          <p className="engrave">{KIND_LABEL[body.kind] ?? 'Object'}</p>
          <h2 className="sheet__name">{body.name}</h2>
          {body.designation && <p className="sheet__designation readout">{body.designation}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <p className="sheet__where">
        {belowHorizon ? (
          <>
            Currently <strong>below the horizon</strong>. The Earth is in the way.
          </>
        ) : (
          <>
            Look {heightInWords(body.altitude)} toward the <strong>{compassPoint(body.azimuth)}</strong>.
          </>
        )}
      </p>

      <dl className="readings">
        <div className="reading">
          <dt className="engrave">Altitude</dt>
          <dd className="readout">{body.altitude.toFixed(1)}°</dd>
        </div>
        <div className="reading">
          <dt className="engrave">Azimuth</dt>
          <dd className="readout">{body.azimuth.toFixed(1)}°</dd>
        </div>
        {/*
          Not for satellites. Their magnitude field is a sort key — brightness
          depends on range, phase and attitude in ways SGP4 does not model —
          and printing "8.00" next to the word Magnitude states a measurement
          nobody made. What they can be seen by is whether they are in
          sunlight, which the chip below says outright.
        */}
        {body.kind !== 'satellite' && (
          <div className="reading">
            <dt className="engrave">Magnitude</dt>
            <dd className="readout">{body.magnitude.toFixed(2)}</dd>
          </div>
        )}
        {distance && (
          <div className="reading">
            <dt className="engrave">Distance</dt>
            <dd className="readout">{distance}</dd>
          </div>
        )}
        {body.phaseName && (
          <div className="reading">
            <dt className="engrave">Phase</dt>
            <dd className="readout">
              {body.phaseName}
              {body.illuminatedFraction !== undefined &&
                ` · ${Math.round(body.illuminatedFraction * 100)}%`}
            </dd>
          </div>
        )}
        {body.spectralType && (
          <div className="reading">
            <dt className="engrave">Spectrum</dt>
            <dd className="readout">{body.spectralType}</dd>
          </div>
        )}
        {body.constellation && (
          <div className="reading">
            <dt className="engrave">Constellation</dt>
            <dd className="readout">{body.constellation}</dd>
          </div>
        )}
        {body.heightKm !== undefined && (
          <div className="reading">
            <dt className="engrave">Orbit height</dt>
            <dd className="readout">{Math.round(body.heightKm)} km</dd>
          </div>
        )}
        {body.speedKmS !== undefined && (
          <div className="reading">
            <dt className="engrave">Speed</dt>
            <dd className="readout">{body.speedKmS.toFixed(2)} km/s</dd>
          </div>
        )}
      </dl>

      {body.kind === 'satellite' && (
        <p className={`chip ${body.sunlit ? 'chip--visible' : 'chip--hidden'}`}>
          {body.sunlit
            ? 'In sunlight: visible as a moving point of light'
            : "In Earth's shadow: overhead, but nothing to see"}
        </p>
      )}

      {/*
        One true thing, before anything is asked for.
        
        The readings above say where it is, which is what the app is for and is
        not, on its own, interesting. The fact is why somebody looks up in the
        first place, and it is here rather than inside the narration because it
        costs no model, no key and no waiting: the corpus is already on the
        machine, so it is on screen the instant the sheet opens.
      */}
      {fact && (
        <div className="sheet__fact">
          <p className="engrave">Did you know</p>
          <p className="sheet__fact-text">{fact.text}</p>
          <p className="provenance">
            NASA,{' '}
            <a href={fact.source} target="_blank" rel="noreferrer noopener">
              {fact.title}
            </a>
            . Tap {body.name} again for another.
          </p>
        </div>
      )}

      <div className="sheet__guide">
        <div className="sheet__guide-head">
          <p className="engrave">Sky guide</p>
          <div className="toggle" role="group" aria-label="Explanation detail">
            <button
              className={tone === 'simple' ? 'toggle__option is-on' : 'toggle__option'}
              onClick={() => onToneChange('simple')}
            >
              Explain simply
            </button>
            <button
              className={tone === 'standard' ? 'toggle__option is-on' : 'toggle__option'}
              onClick={() => onToneChange('standard')}
            >
              More detail
            </button>
          </div>
        </div>

        {answer ? (
          <>
            <p className="sheet__narration">{answer.text}</p>
            <p className="provenance">
              {answer.source === 'granite'
                ? `Written by IBM Granite (${answer.model ?? 'watsonx'}) from the measurements above.`
                : answer.note ?? 'Written by the built-in narrator from the measurements above.'}
            </p>
          </>
        ) : (
          <button className="button" onClick={explain} disabled={asking}>
            {asking ? 'Asking…' : `Tell me about ${body.name}`}
          </button>
        )}
      </div>

      <footer className="sheet__foot">
        <button
          className="button button--quiet"
          onClick={() => onRecord(body)}
          disabled={alreadyLogged}
        >
          {alreadyLogged ? 'In your journal' : 'Add to journal'}
        </button>
        <p className="provenance">
          {body.kind === 'satellite'
            ? 'SGP4 from Celestrak elements'
            : body.kind === 'star'
              ? 'HYG catalogue · J2000'
              : 'astronomy-engine ephemeris'}
        </p>
      </footer>
    </aside>
  );
}
