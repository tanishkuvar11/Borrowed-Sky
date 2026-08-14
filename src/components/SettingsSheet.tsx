/**
 * The menu behind the header's left-hand button.
 *
 * Holds the things that change how the whole app behaves (where you are, how
 * bright the screen is allowed to be, and how the guide talks) so none of them
 * has to take up permanent space over the sky.
 */

import type { Tone } from '../lib/ai';
import type { ObserverSite } from '../lib/astro/types';

export function SettingsSheet({
  site,
  tone,
  nightVision,
  onTone,
  onNightVision,
  onChangeSite,
  onClose,
}: {
  site: ObserverSite;
  tone: Tone;
  nightVision: boolean;
  onTone: (tone: Tone) => void;
  onNightVision: (on: boolean) => void;
  onChangeSite: () => void;
  onClose: () => void;
}) {
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
      </div>
    </div>
  );
}
