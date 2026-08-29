/**
 * The menu behind the header's left-hand button.
 *
 * Holds the things that change how the whole app behaves (where you are, how
 * bright the screen is allowed to be, and how the guide talks) so none of them
 * has to take up permanent space over the sky.
 */

import { useState } from 'react';

import type { Tone } from '../lib/ai';
import { toLocalInputValue } from '../lib/instant';
import type { ObserverSite } from '../lib/astro/types';

export function SettingsSheet({
  site,
  tone,
  nightVision,
  skyModel,
  pinnedInstant,
  onPinInstant,
  onTone,
  onNightVision,
  onSkyModel,
  onChangeSite,
  onClose,
}: {
  site: ObserverSite;
  tone: Tone;
  nightVision: boolean;
  skyModel: boolean;
  /** The moment the app is held at, or null on the live clock. */
  pinnedInstant: Date | null;
  onPinInstant: (when: Date | null) => void;
  onTone: (tone: Tone) => void;
  onNightVision: (on: boolean) => void;
  onSkyModel: (on: boolean) => void;
  onChangeSite: () => void;
  onClose: () => void;
}) {
  /*
   * Seeded from wherever the app currently is, so opening this on a held sky
   * offers that moment rather than making somebody find it again.
   */
  const [moment, setMoment] = useState(() => toLocalInputValue(pinnedInstant ?? new Date()));
  const chosen = moment ? new Date(moment) : null;
  const usable = chosen !== null && Number.isFinite(chosen.getTime());

  return (
    <div className="dialog" role="dialog" aria-label="Settings">
      <div className="dialog__scrim" onClick={onClose} />
      <div className="dialog__panel panel">
        <div className="dialog__head">
          <h2 className="dialog__title">Settings</h2>
          <button className="dialog__close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <span className="engrave">Where you are</span>
        <div className="dialog__row">
          <span className="readout dialog__value">
            {site.latitude.toFixed(3)}°, {site.longitude.toFixed(3)}°
          </span>
          <button className="pill" onClick={onChangeSite}>
            Change
          </button>
        </div>
        <p className="provenance">
          {site.source === 'gps'
            ? 'From your device’s location.'
            : 'Entered by hand, so times and directions are only as good as the coordinates.'}
        </p>

        <div className="hairline" />

        <span className="engrave">How the guide talks</span>
        <div className="dialog__row">
          <button
            className={tone === 'simple' ? 'pill is-on' : 'pill'}
            onClick={() => onTone('simple')}
            aria-pressed={tone === 'simple'}
          >
            Explain like I’m 10
          </button>
          <button
            className={tone === 'standard' ? 'pill is-on' : 'pill'}
            onClick={() => onTone('standard')}
            aria-pressed={tone === 'standard'}
          >
            Standard
          </button>
        </div>
        <p className="provenance">This changes the words, never the numbers behind them.</p>

        <div className="hairline" />

        <span className="engrave">Night vision</span>
        <div className="dialog__row">
          <button
            className={nightVision ? 'pill is-on' : 'pill'}
            onClick={() => onNightVision(!nightVision)}
            aria-pressed={nightVision}
          >
            {nightVision ? 'Red display on' : 'Red display off'}
          </button>
        </div>
        <p className="provenance">
          A bright screen costs you about twenty minutes of dark adaptation. This turns the whole
          display red, sky included.
        </p>

        <div className="hairline" />

        <span className="engrave">Another moment</span>
        <div className="dialog__row">
          <input
            className="dialog__datetime readout"
            type="datetime-local"
            value={moment}
            onChange={(e) => setMoment(e.target.value)}
            aria-label="The date and time to show"
          />
          <button
            className="pill"
            disabled={!usable}
            onClick={() => {
              if (!chosen) return;
              onPinInstant(chosen);
              onClose();
            }}
          >
            Show it
          </button>
        </div>
        <p className="provenance">
          The whole sky computed for a moment of your choosing, past or future: a meteor shower next
          week, an eclipse you missed, the night you were born. Read in this device's clock, and the
          address bar carries it, so a sky worth seeing is a link you can send. There is a way back to
          now at the top of the screen.
        </p>

        <div className="hairline" />

        <span className="engrave">Sky model</span>
        <div className="dialog__row">
          <button
            className={skyModel ? 'pill is-on' : 'pill'}
            onClick={() => onSkyModel(!skyModel)}
            aria-pressed={skyModel}
          >
            {skyModel ? 'Correction on' : 'Correction off'}
          </button>
        </div>
        <p className="provenance">
          The chart normally allows for moonlight and local light pollution, fitted to 143,528 Globe
          at Night observations. Switching it off draws every star the older thresholds would have
          shown.
        </p>
      </div>
    </div>
  );
}
