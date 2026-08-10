/**
 * The opening screen.
 *
 * Nothing in this app can be computed without a position on Earth, so this is
 * the one thing it asks for before it can do anything. It asks plainly, says
 * what the coordinates are used for, and offers typing them in as an equal
 * option rather than a punishment for saying no.
 */

import { useState } from 'react';
import type { LocationStatus } from '../hooks/useObserverSite';

export interface LocationGateProps {
  status: LocationStatus;
  error: string | null;
  onRequestGps: () => void;
  onManual: (latitude: number, longitude: number, label?: string) => void;
}

export function LocationGate({ status, error, onRequestGps, onManual }: LocationGateProps) {
  const [showManual, setShowManual] = useState(false);
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

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
    <div className="gate">
      <div className="gate__inner">
        <p className="engrave gate__eyebrow">Borrowed Sky</p>
        <h1 className="gate__title">
          The sky is <em>overhead</em>.<br />
          Here is what you are looking at.
        </h1>
        <p className="gate__lede">
          No telescope. No app to install. No prior knowledge. Point your phone up and this tells
          you what is there — computed for exactly where you are standing, right now.
        </p>

        <div className="hairline gate__rule" />

        <div className="gate__ask">
          <p className="engrave">One thing first</p>
          <p className="gate__ask-text">
            Every position depends on where on Earth you are. Your coordinates stay in your browser
            and are never stored on a server.
          </p>

          <button
            className="button button--primary button--large"
            onClick={onRequestGps}
            disabled={status === 'requesting'}
          >
            {status === 'requesting' ? 'Finding you…' : 'Use my location'}
          </button>

          {error && <p className="gate__error">{error}</p>}

          {!showManual ? (
            <button className="button button--quiet" onClick={() => setShowManual(true)}>
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

        <p className="provenance provenance--block gate__credits">
          Star positions from the HYG catalogue. Planets and the Moon from astronomy-engine.
          Satellites propagated with SGP4 from Celestrak orbital elements. Nothing in this app is
          simulated or placeholder data.
        </p>
      </div>
    </div>
  );
}
