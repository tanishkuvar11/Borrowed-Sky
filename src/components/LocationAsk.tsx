/**
 * The one thing the app has to ask for, and everything that can go wrong with
 * asking.
 *
 * Lives on its own because two surfaces need it (the scrolling overture and
 * the plain gate behind it) and a permission flow that has drifted apart in
 * two places is a permission flow that will be wrong in one of them.
 */

import { useState } from 'react';
import type { LocationStatus } from '../hooks/useObserverSite';
import type { ObserverSite } from '../lib/astro/types';

export interface LocationAskProps {
  status: LocationStatus;
  error: string | null;
  /** What the browser says it intends to do, when it is willing to say. */
  permission: PermissionState | 'unknown';
  onRequestGps: () => void;
  onManual: (latitude: number, longitude: number, label?: string) => void;
  /**
   * Where the visitor said they were on an earlier visit, or null the first
   * time. Only changes what the first button does, never what it says.
   */
  knownSite?: ObserverSite | null;
  /** Goes in with the known site rather than asking the browser again. */
  onEnter?: () => void;
}

/**
 * A site as the slate writes one: four places, and the hemisphere as a letter
 * rather than a sign, because a minus in front of a latitude is a thing you
 * have to decode and an S is a thing you can read.
 */
function coordinates(site: ObserverSite): string {
  const lat = `${Math.abs(site.latitude).toFixed(4)}°${site.latitude < 0 ? 'S' : 'N'}`;
  const lon = `${Math.abs(site.longitude).toFixed(4)}°${site.longitude < 0 ? 'W' : 'E'}`;
  return `${lat} ${lon}`;
}

export function LocationAsk({
  status,
  error,
  permission,
  onRequestGps,
  onManual,
  knownSite,
  onEnter,
}: LocationAskProps) {
  // Once the browser has refused, the way forward is the form, so open it
  // rather than leaving someone staring at a button that has already failed.
  const [manualOpened, setManualOpened] = useState(false);
  const showManual = manualOpened || status === 'denied' || status === 'unavailable';
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  /*
   * True when there is a site on file and somewhere to go with it. Both are
   * required: the overture passes them together, and the plain gate behind it
   * passes neither, so a half-wired caller falls back to asking rather than to
   * a button that does nothing.
   */
  const goIn = Boolean(knownSite && onEnter);

  const submitManual = (event: React.FormEvent) => {
    event.preventDefault();
    const lat = Number.parseFloat(latitude);
    const lon = Number.parseFloat(longitude);

    if (!Number.isFinite(lat) || Math.abs(lat) > 90) {
      setFormError('Latitude must be a number between −90 and 90.');
      return;
    }
    if (!Number.isFinite(lon) || Math.abs(lon) > 180) {
      setFormError('Longitude must be a number between −180 and 180.');
      return;
    }
    setFormError(null);
    onManual(lat, lon);
  };

  return (
    <div className="ask">
      {/*
       * One button, one sentence, whether or not the app has been here before.
       *
       * It used to say "use my location" to a new visitor and "show me my sky"
       * to a returning one, which described the mechanism to the person who
       * had not seen it yet and the result to the person who had. That is the
       * wrong way round, and it also meant the way in was worded differently
       * on two devices belonging to the same person. What it does still
       * differs: with a site on file it goes straight in, and without one it
       * asks the browser first. That is a difference in what happens next, not
       * in what is being offered.
       */}
      <button
        className="button button--primary button--large"
        onClick={knownSite && onEnter ? onEnter : onRequestGps}
        disabled={!goIn && status === 'requesting'}
      >
        {!goIn && status === 'requesting' ? 'Finding you…' : 'Show me my sky'}
      </button>

      {knownSite && onEnter && (
        <p className="provenance">
          Computed for <span className="ask__known">{coordinates(knownSite)}</span>
        </p>
      )}

      {error && <p className="gate__error">{error}</p>}

      {status === 'denied' && (
        <div className="gate__hint">
          {permission === 'prompt' ? (
            <p>
              Safari says it still intends to ask you, but the request was refused before any
              prompt appeared. That points outside the browser: open Settings →{' '}
              <strong>Privacy &amp; Security</strong> → <strong>Location Services</strong> and check
              it is on, then find <strong>Safari Websites</strong> in that list and set it to{' '}
              <strong>While Using the App</strong>.
            </p>
          ) : (
            <p>
              On iPhone this is usually one of two switches. In Safari, tap <strong>ᴀA</strong> in
              the address bar → <strong>Website Settings</strong> → <strong>Location</strong> →
              Allow. If that is already set, check Settings → <strong>Privacy &amp; Security</strong>{' '}
              → <strong>Location Services</strong> → <strong>Safari Websites</strong>. Then reload
              and tap the button again.
            </p>
          )}
          <p className="provenance">
            Browser permission state: <span className="readout">{permission}</span>
          </p>
        </div>
      )}

      {!showManual ? (
        <button className="button button--quiet" onClick={() => setManualOpened(true)}>
          Enter coordinates instead
        </button>
      ) : (
        <form className="gate__form" onSubmit={submitManual}>
          <div className="gate__fields">
            <label className="field">
              <span className="engrave">Latitude</span>
              <input
                className="field__input readout"
                value={latitude}
                onChange={(event) => setLatitude(event.target.value)}
                placeholder="−26.20"
                inputMode="text"
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span className="engrave">Longitude</span>
              <input
                className="field__input readout"
                value={longitude}
                onChange={(event) => setLongitude(event.target.value)}
                placeholder="28.05"
                inputMode="text"
                autoComplete="off"
              />
            </label>
          </div>
          {formError && <p className="gate__error">{formError}</p>}
          <button className="button button--primary" type="submit">
            Use these coordinates
          </button>
          <p className="provenance">
            Positive latitude is north, positive longitude is east. Two decimal places is plenty.
          </p>
        </form>
      )}
    </div>
  );
}
