/**
 * The sky journal.
 *
 * Rendered as a chart rather than a list, because the point is accumulation:
 * each thing you have found is plotted where you found it, and the dome slowly
 * fills in. The list underneath is the record; the chart is the reward.
 *
 * The projection is the standard planisphere layout — zenith at the centre,
 * horizon at the rim, north at the top — so it reads like the paper star wheels
 * this app is a descendant of.
 */

import { useMemo, useState } from 'react';

import type { JournalEntry, JournalStats } from '../lib/journal';

export interface JournalViewProps {
  entries: JournalEntry[];
  stats: JournalStats;
  onRemove: (id: string) => void;
  onClear: () => void;
}

const KIND_COLOR: Record<string, string> = {
  star: 'var(--starlight)',
  planet: 'var(--brass-bright)',
  moon: 'var(--starlight-soft)',
  sun: '#FFE9A8',
  satellite: 'var(--visible)',
};

const CHART = 300;
const CENTRE = CHART / 2;
const RIM = CENTRE - 26;

/** Alt/az to planisphere coordinates: zenith centre, horizon rim, north up. */
function plot(altitude: number, azimuth: number) {
  const radius = ((90 - Math.max(0, Math.min(90, altitude))) / 90) * RIM;
  const angle = (azimuth - 90) * (Math.PI / 180);
  return { x: CENTRE + radius * Math.cos(angle), y: CENTRE + radius * Math.sin(angle) };
}

export function JournalView({ entries, stats, onRemove, onClear }: JournalViewProps) {
  const [confirmingClear, setConfirmingClear] = useState(false);

  const grouped = useMemo(() => {
    const map = new Map<string, JournalEntry[]>();
    for (const entry of entries) {
      const date = new Date(entry.seenAt);
      date.setHours(date.getHours() - 12);
      const key = date.toDateString();
      const list = map.get(key);
      if (list) list.push(entry);
      else map.set(key, [entry]);
    }
    return [...map.entries()];
  }, [entries]);

  if (entries.length === 0) {
    return (
      <div className="view view--pad">
        <p className="engrave">Your sky journal</p>
        <h2 className="view__title">Nothing logged yet</h2>
        <p className="view__lede">
          Tap anything in the sky view and add it here. Over time this fills in with everything you
          have found, and where in the sky you found it.
        </p>
        <div className="journal__chart-wrap">
          <PlanisphereChart entries={[]} />
        </div>
        <p className="provenance provenance--block">
          Stored only on this device. No account, nothing uploaded.
        </p>
      </div>
    );
  }

  return (
    <div className="view view--pad">
      <p className="engrave">Your sky journal</p>
      <h2 className="view__title">
        {stats.distinctObjects} {stats.distinctObjects === 1 ? 'object' : 'objects'} found
      </h2>

      <div className="stats">
        <div className="stats__item">
          <span className="stats__value readout">{stats.total}</span>
          <span className="engrave">Sightings</span>
        </div>
        <div className="stats__item">
          <span className="stats__value readout">{stats.nights}</span>
          <span className="engrave">Nights out</span>
        </div>
        <div className="stats__item">
          <span className="stats__value readout">{stats.planetsFound}/7</span>
          <span className="engrave">Planets</span>
        </div>
      </div>

      <div className="journal__chart-wrap">
        <PlanisphereChart entries={entries} />
        <p className="provenance">
          Each mark sits where the object was when you logged it. Centre is straight up, the rim is
          the horizon.
        </p>
      </div>

      <div className="journal__log">
        {grouped.map(([night, list]) => (
          <section key={night} className="journal__night">
            <h3 className="journal__night-title engrave">
              {new Date(list[0].seenAt).toLocaleDateString(undefined, {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              })}
            </h3>
            <ul className="journal__entries">
              {list.map((entry) => (
                <li key={entry.id} className="journal__entry">
                  <span
                    className="journal__entry-dot"
                    style={{ background: KIND_COLOR[entry.kind] ?? 'var(--starlight)' }}
                    aria-hidden="true"
                  />
                  <span className="journal__entry-name">{entry.name}</span>
                  <span className="journal__entry-meta readout">
                    {new Date(entry.seenAt).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · '}
                    {Math.round(entry.altitude)}° up
                  </span>
                  <button
                    className="icon-button icon-button--small"
                    onClick={() => onRemove(entry.id)}
                    aria-label={`Remove ${entry.name} from the journal`}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="journal__foot">
        {confirmingClear ? (
          <>
            <p>Delete every entry? This cannot be undone.</p>
            <div className="journal__foot-actions">
              <button className="button button--danger" onClick={() => { onClear(); setConfirmingClear(false); }}>
                Delete everything
              </button>
              <button className="button button--quiet" onClick={() => setConfirmingClear(false)}>
                Keep it
              </button>
            </div>
          </>
        ) : (
          <button className="button button--quiet" onClick={() => setConfirmingClear(true)}>
            Clear journal
          </button>
        )}
        <p className="provenance">Stored only on this device. No account, nothing uploaded.</p>
      </div>
    </div>
  );
}

function PlanisphereChart({ entries }: { entries: JournalEntry[] }) {
  return (
    <svg
      className="planisphere"
      viewBox={`0 0 ${CHART} ${CHART}`}
      role="img"
      aria-label={`Star chart showing ${entries.length} logged sightings`}
    >
      {/* Altitude rings at 30 and 60 degrees, plus the horizon. */}
      {[0, 30, 60].map((alt) => (
        <circle
          key={alt}
          cx={CENTRE}
          cy={CENTRE}
          r={((90 - alt) / 90) * RIM}
          fill="none"
          stroke="var(--brass-hairline)"
          strokeWidth={alt === 0 ? 1.2 : 0.6}
        />
      ))}

      {/* Cardinal spokes. */}
      {[0, 90, 180, 270].map((az) => {
        const outer = plot(0, az);
        return (
          <line
            key={az}
            x1={CENTRE}
            y1={CENTRE}
            x2={outer.x}
            y2={outer.y}
            stroke="var(--brass-engrave)"
            strokeWidth={0.6}
          />
        );
      })}

      {(
        [
          [0, 'N'],
          [90, 'E'],
          [180, 'S'],
          [270, 'W'],
        ] as [number, string][]
      ).map(([az, label]) => {
        const at = plot(-7, az);
        return (
          <text
            key={label}
            x={at.x}
            y={at.y}
            textAnchor="middle"
            dominantBaseline="middle"
            className="planisphere__cardinal"
          >
            {label}
          </text>
        );
      })}

      {entries.map((entry) => {
        const at = plot(entry.altitude, entry.azimuth);
        return (
          <g key={entry.id}>
            <circle
              cx={at.x}
              cy={at.y}
              r={5}
              fill={KIND_COLOR[entry.kind] ?? 'var(--starlight)'}
              opacity={0.18}
            />
            <circle cx={at.x} cy={at.y} r={2} fill={KIND_COLOR[entry.kind] ?? 'var(--starlight)'} />
          </g>
        );
      })}
    </svg>
  );
}
