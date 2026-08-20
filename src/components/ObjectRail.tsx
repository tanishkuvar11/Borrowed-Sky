/**
 * The left-hand column: what is up, and what the chart is showing.
 *
 * The sky already labels everything it draws, but a label on the chart only
 * helps if you have already found the thing. This is the other half of that:
 * a standing list of what is actually above the horizon right now, brightest
 * first, so the answer to "is there anything worth looking at" does not
 * require hunting across the projection first.
 *
 * Two tabs, because the column is doing two different jobs and they should not
 * be interleaved. OBJECTS is the list. VIEW is what the chart draws. The field
 * of view sits beside them as a reading rather than a control, since it is
 * changed by pinching the sky and not by pressing anything here.
 */

import { PlanetMark } from './planet-marks';
import { compassPoint } from '../lib/astro/satellites';
import type { SkyBody } from '../lib/astro/types';

/**
 * How many rows the column will show.
 *
 * On a busy night with satellites overhead the honest list runs to dozens,
 * and a column of dozens is a scrollbar sitting over the sky. Six is about
 * what fits beside the chart without the list becoming the page.
 */
const MAX_ROWS = 6;

export type RailTab = 'objects' | 'view';

/**
 * Everything above the horizon, brightest first.
 *
 * Satellites have to earn their place twice: above the horizon, and in
 * sunlight. One in the Earth's shadow is geometrically up and completely
 * invisible, and a column headed "objects" that lists things you cannot see is
 * worse than one that lists nothing.
 *
 * Nothing is invented to fill the list. If the sky is empty the column says so.
 */
function visible(bodies: SkyBody[]): SkyBody[] {
  return bodies
    .filter((b) => b.altitude > 0)
    .filter((b) => b.kind !== 'satellite' || b.sunlit === true)
    .sort((a, b) => a.magnitude - b.magnitude)
    .slice(0, MAX_ROWS);
}

/**
 * The one line worth knowing about a thing at a glance.
 *
 * Per kind, because "magnitude" is not universally meaningful here. A
 * satellite's magnitude field is a sort key and not a measurement — brightness
 * depends on range, phase and attitude in ways the orbit model does not carry
 * — so printing it as one would be inventing a reading. What a satellite
 * actually needs is where to point, since it will not be there long.
 */
function reading(body: SkyBody): string {
  switch (body.kind) {
    case 'satellite':
      return `${Math.round(body.altitude)}° up · ${compassPoint(body.azimuth)}`;
    case 'moon':
      return body.illuminatedFraction !== undefined
        ? `${Math.round(body.illuminatedFraction * 100)}% lit`
        : `${Math.round(body.altitude)}° up`;
    default:
      return `${body.magnitude >= 0 ? '+' : ''}${body.magnitude.toFixed(1)} mag`;
  }
}

export function ObjectRail({
  bodies,
  tab,
  open,
  onOpen,
  onToggle,
  fov,
  selectedId,
  onSelect,
  showConstellations,
  onShowConstellations,
  showGrid,
  onShowGrid,
}: {
  bodies: SkyBody[];
  tab: RailTab;
  fov: number;
  selectedId: string | null;
  onSelect: (id: string) => void;
  showConstellations: boolean;
  onShowConstellations: (on: boolean) => void;
  showGrid: boolean;
  onShowGrid: (on: boolean) => void;
  /**
   * Whether the column below the strip is showing.
   *
   * Only the small-screen layout is ever shut — above the breakpoint the
   * stylesheet ignores this and the column is permanently open — but the
   * disclosure still needs to know, because it is the thing that says so.
   */
  open: boolean;
  /** Picks a tab, and opens the column if it was shut. */
  onOpen: (tab: RailTab) => void;
  /** The disclosure: open when shut, shut when open. */
  onToggle: () => void;
}) {
  const rows = visible(bodies);

  return (
    <div className="object-rail">
      <div className="segment" role="tablist" aria-label="Left column">
        <button
          className={tab === 'objects' ? 'segment__tab is-on' : 'segment__tab'}
          role="tab"
          aria-selected={tab === 'objects'}
          onClick={() => onOpen('objects')}
        >
          Objects
        </button>
        <button
          className={tab === 'view' ? 'segment__tab is-on' : 'segment__tab'}
          role="tab"
          aria-selected={tab === 'view'}
          onClick={() => onOpen('view')}
        >
          View
        </button>
        <span className="segment__reading readout" title="Field of view">
          {Math.round(fov)}°
        </span>

        {/*
          The disclosure.

          On a phone this strip is all you land on, and a strip of tabs does not
          announce that there is anything underneath it to pull down — you have
          to already know. This says so. It is hidden above the breakpoint,
          where the column never closes and a control for opening it would be a
          control that does nothing.
        */}
        <button
          className="segment__disclosure"
          onClick={onToggle}
          aria-expanded={open}
          aria-controls="sky-column"
          aria-label={open ? 'Hide what is up' : 'Show what is up'}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden focusable="false">
            <path
              d="M3 5l4 4 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div id="sky-column" className="object-rail__body">
        {tab === 'objects' ? (
        rows.length ? (
          <ul className="object-list">
            {rows.map((body) => (
              <li key={body.id}>
                <button
                  className={
                    body.id === selectedId ? 'object-card is-selected' : 'object-card'
                  }
                  onClick={() => onSelect(body.id)}
                >
                  <span className="object-card__mark">
                    <PlanetMark
                      name={body.name}
                      kind={body.kind}
                      illuminatedFraction={body.illuminatedFraction}
                      size={38}
                    />
                  </span>
                  <span className="object-card__text">
                    <span className="object-card__name">{body.name}</span>
                    <span className="object-card__reading">{reading(body)}</span>
                  </span>
                  <span className="object-card__chevron" aria-hidden>
                    <svg width="14" height="14" viewBox="0 0 14 14">
                      <path
                        d="M5 3l4 4-4 4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          /*
           * The honest empty state. Every other app would pad this out with
           * something; the whole claim here is that what is listed is what is
           * up, and sometimes nothing is.
           */
          <p className="object-list__empty provenance">
            Nothing bright is above your horizon at this moment.
          </p>
        )
      ) : (
        <div className="view-options">
          <label className="switch">
            <input
              type="checkbox"
              checked={showConstellations}
              onChange={(e) => onShowConstellations(e.target.checked)}
            />
            <span className="switch__track" aria-hidden />
            <span className="switch__label">Figures</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={showGrid}
              onChange={(e) => onShowGrid(e.target.checked)}
            />
            <span className="switch__track" aria-hidden />
            <span className="switch__label">Grid</span>
          </label>
          <p className="view-options__note provenance">
            Figures draws the constellation joins. Grid rules the sky in altitude
            and azimuth.
          </p>
        </div>
      )}
      </div>
    </div>
  );
}
