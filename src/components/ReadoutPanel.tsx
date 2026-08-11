/**
 * The observer's own coordinates, engraved on a small brass plate.
 *
 * Everything the rest of the app computes hangs off these four numbers, so they
 * sit permanently in the corner where they can be checked. Latitude and
 * longitude are shown in degrees, minutes and seconds — the form they appear in
 * on a chart, and the form that makes it obvious how much precision is actually
 * being claimed.
 */

import { ClockFace } from './icons';
import type { ObserverSite } from '../lib/astro/types';

function sexagesimal(value: number, positive: string, negative: string): string {
  const hemisphere = value >= 0 ? positive : negative;
  const abs = Math.abs(value);
  const degrees = Math.floor(abs);
  const minutesFloat = (abs - degrees) * 60;
  const minutes = Math.floor(minutesFloat);
  const seconds = Math.round((minutesFloat - minutes) * 60);

  // Carry the rounding rather than printing 60″.
  let m = minutes;
  let s = seconds;
  let d = degrees;
  if (s === 60) {
    s = 0;
    m += 1;
  }
  if (m === 60) {
    m = 0;
    d += 1;
  }

  return `${d}°${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″ ${hemisphere}`;
}

export function ReadoutPanel({
  site,
  now,
  onChangeSite,
}: {
  site: ObserverSite;
  now: Date;
  onChangeSite: () => void;
}) {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}  ${now.toLocaleTimeString(undefined, { hour12: false })}`;

  return (
    <button className="readout-panel" onClick={onChangeSite} title="Change location">
      <div className="readout-panel__rows">
        <span className="readout-panel__line readout">{stamp}</span>
        <span className="readout-panel__line readout">
          <span className="readout-panel__key">LAT</span>
          {sexagesimal(site.latitude, 'N', 'S')}
        </span>
        <span className="readout-panel__line readout">
          <span className="readout-panel__key">LON</span>
          {sexagesimal(site.longitude, 'E', 'W')}
        </span>
        <span className="readout-panel__line readout">
          <span className="readout-panel__key">ELEV</span>
          {Math.round(site.elevation)} m
          {site.source === 'manual' && <em className="readout-panel__flag">set by hand</em>}
        </span>
      </div>
      <span className="readout-panel__clock">
        <ClockFace date={now} size={44} />
      </span>
    </button>
  );
}
