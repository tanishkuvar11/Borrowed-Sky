/**
 * The observer's own coordinates, engraved on a small brass plate.
 *
 * Everything the rest of the app computes hangs off these four numbers, so they
 * sit permanently in the corner where they can be checked. Latitude and
 * longitude are shown in degrees, minutes and seconds: the form they appear in
 * on a chart, and the form that makes it obvious how much precision is actually
 * being claimed.
 */

import { ClockFace } from './icons';
import type { ObserverSite } from '../lib/astro/types';
import { clockDiffersFrom, deviceTimezone, type Place } from '../lib/place';

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
  place,
  onChangeSite,
}: {
  site: ObserverSite;
  now: Date;
  /** Looked up rather than computed, so null until it answers, and null if it never does. */
  place: Place | null;
  onChangeSite: () => void;
}) {
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}  ${now.toLocaleTimeString(undefined, { hour12: false })}`;

  return (
    <button className="readout-panel" onClick={onChangeSite} title="Change location">
      <div className="readout-panel__rows">
        <span className="readout-panel__line">{stamp}</span>
        <span className="readout-panel__line">
          <span className="readout-panel__key">LAT</span>
          {sexagesimal(site.latitude, 'N', 'S')}
        </span>
        <span className="readout-panel__line">
          <span className="readout-panel__key">LON</span>
          {sexagesimal(site.longitude, 'E', 'W')}
        </span>
        <span className="readout-panel__line">
          <span className="readout-panel__key">ELEV</span>
          {Math.round(site.elevation)} m
          {site.source === 'manual' && <em className="readout-panel__flag">set by hand</em>}
        </span>

        {/*
          Added at the bottom rather than at the top, where the name belongs by
          importance. These two arrive over the network some time after the
          coordinates, and putting them first means the plate shoves its own
          contents down a line the moment they land. Growing downwards, nothing
          that was already readable moves.
        */}
        {place?.name && (
          <span className="readout-panel__line">
            <span className="readout-panel__key">NEAR</span>
            {place.name}
          </span>
        )}

        {place?.timezone && (
          <span className="readout-panel__line">
            <span className="readout-panel__key">TZ</span>
            {place.timezone}
          </span>
        )}

        {/*
          The one thing the old banner was right about, said as a fact rather
          than as a warning, and only when it is one.

          Every clock in this app is drawn in the device's zone. That is correct
          when you are standing where you say you are, and wrong the moment
          somebody types in coordinates on the far side of the world. It used to
          be a red bar across the top of the screen telling them their own input
          disagreed with their laptop. Same information; the difference is
          whether the app is informing them or arguing with them.

          On its own line because the plate's rows do not wrap, and this one ran
          out past the edge of the brass when it sat beside the zone.
        */}
        {clockDiffersFrom(place?.timezone ?? null, now) && (
          <span className="readout-panel__line readout-panel__note">
            <span className="readout-panel__key" />
            clocks shown in {deviceTimezone()}
          </span>
        )}
      </div>
      <span className="readout-panel__clock">
        <ClockFace date={now} size={44} />
      </span>
    </button>
  );
}
