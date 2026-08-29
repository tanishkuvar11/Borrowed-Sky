/**
 * Tonight's Sky: a horizontal rule you can read like an instrument scale.
 *
 * The band behind the events is a plot of the real Sun altitude across the
 * window, so the darkness you can see on the strip is the darkness that is
 * actually coming. Every bar is a computed visibility window, not a guess at
 * when something is "usually" up.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { headlineSpan, type TimelineSpan, type TonightTimeline } from '../lib/astro/events';
import { funFactFor, type Fact } from '../lib/facts';
import type { ObserverSite, SkyConditions } from '../lib/astro/types';
import { askGuide, buildSkyContext, type GuideAnswer, type Tone } from '../lib/ai';
import type { SkyBody } from '../lib/astro/types';

const PIXELS_PER_HOUR = 88;

export interface TimelineViewProps {
  timeline: TonightTimeline | null;
  site: ObserverSite;
  now: Date;
  bodies: SkyBody[];
  conditions: SkyConditions | null;
  tone: Tone;
  satelliteError: string | null;
  onRetrySatellites: () => void;
}

/**
 * A wall-clock time where the observer is standing, not where their device is.
 *
 * Every time on this page is a statement about the sky over one place: the hour
 * the Sun clears that horizon, the minute a station crosses it. Printing those
 * off the watch of somebody four thousand miles away gives a number that is not
 * wrong by a rounding error but wrong by hours, and reads as authoritative
 * either way. Falls back to the device's zone while the lookup is still out, or
 * for good if it never answers.
 */
function clock(date: Date, timeZone: string | undefined): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

function relative(target: Date, now: Date): string {
  const minutes = Math.round((target.getTime() - now.getTime()) / 60_000);
  if (minutes < 0) return 'now';
  if (minutes < 1) return 'any moment';
  if (minutes < 60) return `in ${minutes} min`;
  const hours = minutes / 60;
  return `in ${hours.toFixed(hours < 10 ? 1 : 0)} h`;
}

/** Sky colour for a given Sun altitude: the same ramp the canvas background uses. */
function bandColor(altitude: number): string {
  const darkness = Math.max(0, Math.min(1, (-altitude - 2) / 16));
  const r = Math.round(46 * (1 - darkness) + 10 * darkness);
  const g = Math.round(70 * (1 - darkness) + 10 * darkness);
  const b = Math.round(130 * (1 - darkness) + 26 * darkness);
  return `rgb(${r},${g},${b})`;
}

export function TimelineView({
  timeline,
  site,
  now,
  bodies,
  conditions,
  tone,
  satelliteError,
  onRetrySatellites,
}: TimelineViewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [narration, setNarration] = useState<GuideAnswer | null>(null);
  const [asking, setAsking] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const headline = useMemo(
    () => (timeline ? headlineSpan(timeline, now) : null),
    // Recomputing every second would thrash; the timeline object is the real input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [timeline],
  );

  // Open the strip on the interesting part of the night rather than at "now",
  // which for a daytime visitor would be hours of empty scale.
  const scrolledRef = useRef(false);
  useEffect(() => {
    if (!timeline || !scrollRef.current || scrolledRef.current) return;
    const anchor = timeline.darkness?.start ?? now;
    const hoursIn = (anchor.getTime() - timeline.from.getTime()) / 3_600_000;
    scrollRef.current.scrollLeft = Math.max(0, hoursIn * PIXELS_PER_HOUR - 40);
    scrolledRef.current = true;
  }, [timeline, now]);

  if (!timeline) {
    return (
      <div className="view view--pad">
        <p className="engrave">Tonight's sky</p>
        <p className="view__lede">Working out what is coming up from your location…</p>
      </div>
    );
  }

  const zone = site.timezone;
  const totalHours = (timeline.to.getTime() - timeline.from.getTime()) / 3_600_000;
  const width = totalHours * PIXELS_PER_HOUR;
  const xFor = (date: Date) =>
    ((date.getTime() - timeline.from.getTime()) / 3_600_000) * PIXELS_PER_HOUR;

  /*
   * What a window actually occupies, which is not always its bar.
   *
   * A four-minute station pass is a ten-pixel bar carrying a two-hundred-pixel
   * name, and that name is rendered *outside* the bar — see .bar--narrow, which
   * hangs the label off one end. Packing lanes by the bars alone therefore put
   * Jupiter into the lane beside Tiangong because their bars cleared each other
   * by eight pixels, and printed the two names straight through one another.
   *
   * So each window is placed once, here, and the lane packer is given the span
   * of everything that will be drawn for it rather than the span of its bar.
   * The render below reads these back instead of deriving them a second time,
   * because the packer and the renderer disagreeing about where a label sits is
   * exactly the bug this is fixing.
   */
  const LABEL_CHAR_WIDTH = 9.5;
  const LABEL_GAP = 6;
  const NARROW_BAR = 76;

  interface PlacedSpan {
    span: TimelineSpan;
    left: number;
    barWidth: number;
    narrow: boolean;
    before: boolean;
    from: number;
    to: number;
  }

  const placed: PlacedSpan[] = timeline.spans.map((span) => {
    const left = xFor(span.start);
    const barWidth = Math.max(10, xFor(span.end) - left);
    // A short pass is only a few pixels wide, so its name goes beside the bar
    // rather than being clipped inside it...
    const narrow = barWidth < NARROW_BAR;
    // ...and on whichever side of it there is room. Late in the night a short
    // pass sits near the end of the scrollable content, where a name hung off
    // its right ran past the end and was clipped away entirely.
    const before = narrow && left + barWidth > width - 120;
    const labelWidth = span.name.length * LABEL_CHAR_WIDTH;
    return {
      span,
      left,
      barWidth,
      narrow,
      before,
      from: narrow && before ? left - LABEL_GAP - labelWidth : left,
      to: narrow && !before ? left + barWidth + LABEL_GAP + labelWidth : left + barWidth,
    };
  });

  // Give each object its own lane so overlapping windows stay readable.
  const lanes: PlacedSpan[][] = [];
  for (const item of placed) {
    const lane = lanes.find((l) => l.every((o) => o.to + 8 < item.from || item.to + 8 < o.from));
    if (lane) lane.push(item);
    else lanes.push([item]);
  }

  /*
   * Stack the moment labels that would otherwise be printed through each other.
   *
   * The dashed line stays on the moment's real time; only the name moves down.
   * Events landing minutes apart is the ordinary case rather than the edge one:
   * the sky starts to brighten about twenty minutes before the Sun clears the
   * horizon, and at 88 pixels to the hour that is thirty pixels between two
   * labels that need two hundred, so "Sky starts to brighten" and "Sunrise"
   * were drawn on top of one another every single night.
   *
   * Label width is estimated from the character count rather than measured.
   * Measuring would mean laying the strip out, reading the boxes back and
   * laying it out again, which is a lot of machinery for a nudge of a few
   * pixels. The estimate is deliberately generous, because the two failures
   * are not equal: a label given more room than it needs drops to the next row
   * slightly earlier than it had to, which nobody can see, while one given too
   * little goes straight back to overlapping.
   *
   * Eight pixels a character was not generous, it was short. These are set in
   * Unbounded — a wide display face — at eleven pixels with letter-spacing on
   * top, where the real average advance is nearer nine and a half. 'Sky starts
   * to brighten' was being booked at 181px against the 198px it actually takes,
   * so Moonset was told there was room beside it on the row and landed close
   * enough to read as part of the same phrase.
   */
  const MOMENT_CHAR_WIDTH = LABEL_CHAR_WIDTH;
  const MOMENT_ROW_HEIGHT = 13;
  const rowEnds: number[] = [];
  const momentPlacements = timeline.moments.map((moment) => {
    const left = xFor(moment.time);
    const end = left + 5 + moment.label.length * MOMENT_CHAR_WIDTH;
    let row = rowEnds.findIndex((taken) => taken <= left);
    if (row === -1) row = rowEnds.push(0) - 1;
    rowEnds[row] = end + 6;
    return { moment, left, row };
  });

  /*
   * Give the rows somewhere to go. Two rows fit in the gap the bars already
   * left above them, so an ordinary night is laid out exactly as it was and
   * only a crowded one grows.
   */
  const lanesTop = Math.max(62, 44 + (rowEnds.length - 1) * MOMENT_ROW_HEIGHT);

  /*
   * The lanes are what makes the strip tall, so measure it from them rather
   * than from a number that happened to fit the night it was written on. 210px
   * was four lanes plus the clearance the 'now' label needs beneath them, and
   * a fifth lane is not an exotic night: the Moon, two or three planets and a
   * station pass all clearing the horizon is most of them. That fifth lane ran
   * sixteen pixels past the bottom, where overflow-y: hidden on the frame cut
   * it in half.
   *
   * Lane height and gap are the stylesheet values restated. Measuring the laid
   * out lanes instead would mean a second pass over the strip to recover two
   * numbers that are constants a few lines apart in the CSS.
   */
  const LANE_HEIGHT = 28;
  const LANE_GAP = 6;
  const LANE_FOOT = 18;
  const stripHeight =
    lanesTop +
    lanes.length * LANE_HEIGHT +
    Math.max(0, lanes.length - 1) * LANE_GAP +
    LANE_FOOT;

  const gradient = timeline.sunTrack.length
    ? `linear-gradient(90deg, ${timeline.sunTrack
        .map(
          (p) =>
            `${bandColor(p.altitude)} ${(((p.ms - timeline.from.getTime()) / 3_600_000 / totalHours) * 100).toFixed(2)}%`,
        )
        .join(', ')})`
    : 'var(--ink-indigo)';

  const upcoming = timeline.spans.filter((s) => s.end > now);

  const narrate = async () => {
    if (!conditions) return;
    setAsking(true);
    try {
      const context = buildSkyContext({ now, site, bodies, conditions, timeline });
      setNarration(await askGuide({ skyContext: context, tone }));
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="view">
      <div className="view__pad">
        <p className="engrave">Tonight's sky</p>
        <h2 className="view__title">
          {headline ? headline.name : 'Nothing bright is due tonight'}
        </h2>
        <p className="view__lede">
          {headline
            ? headline.detail
            : timeline.darkness
              ? 'No planets or station passes clear the rooftops during tonight\'s dark hours. The stars are still there. Open the sky view.'
              : 'The Sun does not get far enough below the horizon here tonight for the sky to go properly dark.'}
        </p>

        <div className="conditions">
          <div className="conditions__item">
            <span className="engrave">Moon</span>
            <span className="conditions__value">
              {timeline.moonPhase.name} · {Math.round(timeline.moonPhase.illuminatedFraction * 100)}%
            </span>
          </div>
          <div className="conditions__item">
            <span className="engrave">Darkness</span>
            <span className="conditions__value">
              {timeline.darkness
                ? `${clock(timeline.darkness.start, zone)} – ${clock(timeline.darkness.end, zone)}`
                : 'None tonight'}
            </span>
          </div>
        </div>
      </div>

      <div className="strip" ref={scrollRef}>
        <div className="strip__inner" style={{ width, height: stripHeight }}>
          <div className="strip__band" style={{ background: gradient }} />

          {Array.from({ length: Math.ceil(totalHours) + 1 }, (_, i) => {
            const at = new Date(timeline.from.getTime() + i * 3_600_000);
            const major = at.getHours() % 3 === 0;
            return (
              <div
                key={i}
                className={major ? 'strip__tick strip__tick--major' : 'strip__tick'}
                style={{ left: i * PIXELS_PER_HOUR }}
              >
                {major && <span className="strip__tick-label">{clock(at, zone)}</span>}
              </div>
            );
          })}

          {momentPlacements.map(({ moment, left, row }) => (
            <div key={moment.id} className="strip__moment" style={{ left }}>
              <span className="strip__moment-label" style={{ top: row * MOMENT_ROW_HEIGHT }}>
                {moment.label}
              </span>
            </div>
          ))}

          <div className="strip__lanes" style={{ top: lanesTop }}>
            {lanes.map((lane, laneIndex) => (
              <div className="strip__lane" key={laneIndex}>
                {lane.map(({ span, left, barWidth, narrow, before }) => {
                  return (
                    <button
                      key={span.id}
                      className={
                        `bar bar--${span.kind} bar--${span.quality}` +
                        (narrow ? ' bar--narrow' : '') +
                        (before ? ' bar--narrow-before' : '')
                      }
                      style={{ left, width: barWidth }}
                      onClick={() => setExpanded(expanded === span.id ? null : span.id)}
                      aria-expanded={expanded === span.id}
                      title={`${span.name} · ${clock(span.start, zone)}–${clock(span.end, zone)}`}
                    >
                      <span className="bar__label">{span.name}</span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="strip__now" style={{ left: xFor(now) }}>
            <span className="strip__now-label">now</span>
          </div>
        </div>
      </div>

      <div className="view__pad">
        {satelliteError && (
          <div className="notice notice--warn">
            <p className="engrave">Satellite passes unavailable</p>
            <p>
              Orbital elements could not be loaded, so no station passes are listed. Everything else
              on this page is computed locally and unaffected.
            </p>
            <p className="provenance">{satelliteError}</p>
            <button className="button button--quiet" onClick={onRetrySatellites}>
              Try again
            </button>
          </div>
        )}

        <div className="agenda">
          {upcoming.length === 0 && (
            <p className="view__lede">Nothing further is due before the sky brightens again.</p>
          )}
          {upcoming.map((span) => (
            <article
              key={span.id}
              className={`agenda__item ${expanded === span.id ? 'is-open' : ''}`}
            >
              <button className="agenda__head" onClick={() => setExpanded(expanded === span.id ? null : span.id)}>
                <span className={`agenda__dot agenda__dot--${span.kind}`} aria-hidden="true" />
                <span className="agenda__name">{span.name}</span>
                <span className="agenda__when">
                  {span.start > now ? relative(span.start, now) : `until ${clock(span.end, zone)}`}
                </span>
              </button>
              {expanded === span.id && (
                <div className="agenda__body">
                  <p>{span.detail}</p>
                  <AgendaFact name={span.name} kind={span.kind} fallback={span.fact} />
                  <dl className="readings readings--inline">
                    <div className="reading">
                      <dt className="engrave">Window</dt>
                      <dd className="readout">
                        {clock(span.start, zone)} – {clock(span.end, zone)}
                      </dd>
                    </div>
                    {span.peakAltitude !== undefined && (
                      <div className="reading">
                        <dt className="engrave">Highest</dt>
                        <dd className="readout">{Math.round(span.peakAltitude)}°</dd>
                      </div>
                    )}
                    {span.magnitude !== undefined && (
                      <div className="reading">
                        <dt className="engrave">Magnitude</dt>
                        <dd className="readout">{span.magnitude.toFixed(1)}</dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
            </article>
          ))}
        </div>

        <div className="narration">
          {narration ? (
            <>
              <p className="narration__text">{narration.text}</p>
              <p className="provenance">
                {narration.source === 'granite'
                  ? `IBM Granite (${narration.model ?? 'watsonx'}), written from the computed windows above.`
                  : narration.note ?? 'Built-in narrator, written from the computed windows above.'}
              </p>
            </>
          ) : (
            <button className="button" onClick={() => void narrate()} disabled={asking || !conditions}>
              {asking ? 'Asking…' : 'Narrate tonight'}
            </button>
          )}
        </div>

        <p className="provenance provenance--block">
          Windows computed with astronomy-engine for {site.latitude.toFixed(2)}°,{' '}
          {site.longitude.toFixed(2)}°. Station passes propagated with SGP4 from Celestrak elements.
          Times shown in this device's timezone.
        </p>
      </div>
    </div>
  );
}

/**
 * A different true thing each time a row is opened.
 *
 * The timeline already carried one fact per object, written into the span when
 * it was built, which meant the Moon said the same sentence every night for as
 * long as you used the app. These come out of the NASA corpus and rotate, and
 * they carry the page they were taken from.
 *
 * The old one is kept as the fallback rather than deleted. It needs no corpus
 * and no network, so a build without either still says something rather than
 * showing a gap where a fact used to be.
 */
function AgendaFact({
  name,
  kind,
  fallback,
}: {
  name: string;
  kind: string;
  fallback?: string;
}) {
  const [fact, setFact] = useState<Fact | null>(null);

  useEffect(() => {
    let cancelled = false;
    funFactFor(name, kind === 'satellite-pass' ? 'satellite' : kind).then((found) => {
      if (!cancelled) setFact(found);
    });
    return () => {
      cancelled = true;
    };
  }, [name, kind]);

  if (fact) {
    return (
      <p className="agenda__fact">
        {fact.text}{' '}
        <a
          className="agenda__fact-source"
          href={fact.source}
          target="_blank"
          rel="noreferrer noopener"
        >
          NASA
        </a>
      </p>
    );
  }

  return fallback ? <p className="agenda__fact">{fallback}</p> : null;
}
