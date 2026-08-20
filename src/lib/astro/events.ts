/**
 * "Tonight's Sky": what becomes visible over the next several hours.
 *
 * A body being above the horizon is not the same as a body being worth going
 * outside for. A window here means: high enough to clear rooftops and haze,
 * during a sky dark enough to see it, and bright enough to see with bare eyes.
 * All three conditions are computed, never assumed.
 */

import {
  Body,
  MakeTime,
  SearchAltitude,
  SearchRiseSet,
  type AstroTime,
} from 'astronomy-engine';

import type { ObserverSite, SkyBody } from './types.js';
import {
  BODY_FACTS,
  PLANETS,
  computeSolarSystem,
  darknessFromSunAltitude,
  moonPhaseName,
  toObserver,
} from './solar.js';
import {
  compassPoint,
  findPasses,
  heightInWords,
  TRACKED_FOR_PASSES,
  type SatellitePass,
  type TleSet,
} from './satellites.js';

/** Minimum altitude for something to be practically observable from a street. */
const MIN_USEFUL_ALTITUDE = 10;
/** Sun altitude below which the sky is dark enough for planets and stars. */
const DARK_ENOUGH_SUN_ALTITUDE = -6;

export type SpanKind = 'planet' | 'moon' | 'satellite-pass' | 'darkness';

export interface TimelineSpan {
  id: string;
  kind: SpanKind;
  name: string;
  start: Date;
  end: Date;
  peak?: Date;
  peakAltitude?: number;
  peakAzimuth?: number;
  magnitude?: number;
  /** Plain-language description assembled entirely from the computed numbers. */
  detail: string;
  fact?: string;
  /** Ranking hint for the UI, derived from altitude and brightness. */
  quality: 'headline' | 'good' | 'faint';
}

export interface TimelineMoment {
  id: string;
  label: string;
  time: Date;
  kind: 'sunset' | 'sunrise' | 'dusk' | 'dawn' | 'moonrise' | 'moonset';
}

export interface TonightTimeline {
  from: Date;
  to: Date;
  spans: TimelineSpan[];
  moments: TimelineMoment[];
  /** The stretch of real darkness inside the window, if there is one. */
  darkness?: { start: Date; end: Date };
  /**
   * Sun altitude across the window. The timeline paints its twilight band
   * straight from these numbers, so the graphic is a plot rather than a mood.
   */
  sunTrack: { ms: number; altitude: number }[];
  moonPhase: { name: string; illuminatedFraction: number };
  /** Set when satellite elements could not be loaded; the UI must say so. */
  satelliteDataError?: string;
}

// ---------------------------------------------------------------------------
// sampling
// ---------------------------------------------------------------------------

const SAMPLE_MINUTES = 5;

interface Sample {
  ms: number;
  sunAltitude: number;
  altitudes: Map<string, number>;
  magnitudes: Map<string, number>;
  azimuths: Map<string, number>;
}

/**
 * Walks the window at a fixed cadence, recording every body's altitude.
 *
 * Sampling rather than root-finding keeps the awkward cases honest for free:
 * circumpolar planets, bodies that never rise, and polar summers where it never
 * gets dark all fall out of the same code path instead of needing special cases.
 */
function sampleWindow(from: Date, hours: number, site: ObserverSite): Sample[] {
  const samples: Sample[] = [];
  const steps = Math.round((hours * 60) / SAMPLE_MINUTES);

  for (let i = 0; i <= steps; i++) {
    const when = new Date(from.getTime() + i * SAMPLE_MINUTES * 60_000);
    const { sun, moon, planets } = computeSolarSystem(when, site);

    const altitudes = new Map<string, number>();
    const magnitudes = new Map<string, number>();
    const azimuths = new Map<string, number>();

    for (const body of [moon, ...planets]) {
      altitudes.set(body.id, body.altitude);
      magnitudes.set(body.id, body.magnitude);
      azimuths.set(body.id, body.azimuth);
    }

    samples.push({ ms: when.getTime(), sunAltitude: sun.altitude, altitudes, magnitudes, azimuths });
  }

  return samples;
}

/** Linear interpolation of the crossing time between two bracketing samples. */
function crossingMs(a: Sample, b: Sample, valueA: number, valueB: number, threshold: number): number {
  const span = valueB - valueA;
  if (Math.abs(span) < 1e-9) return b.ms;
  const t = (threshold - valueA) / span;
  return a.ms + t * (b.ms - a.ms);
}

interface Run {
  startMs: number;
  endMs: number;
  peakMs: number;
  peakAltitude: number;
}

/** Contiguous stretches where a body is both high enough and the sky is dark. */
function findRuns(samples: Sample[], id: string): Run[] {
  const runs: Run[] = [];
  let current: Run | null = null;

  const usable = (s: Sample) =>
    (s.altitudes.get(id) ?? -90) >= MIN_USEFUL_ALTITUDE &&
    s.sunAltitude <= DARK_ENOUGH_SUN_ALTITUDE;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const alt = s.altitudes.get(id) ?? -90;

    if (usable(s)) {
      if (!current) {
        // Interpolate back to whichever condition was the limiting one.
        const prev = samples[i - 1];
        let startMs = s.ms;
        if (prev) {
          const prevAlt = prev.altitudes.get(id) ?? -90;
          const altCross =
            prevAlt < MIN_USEFUL_ALTITUDE
              ? crossingMs(prev, s, prevAlt, alt, MIN_USEFUL_ALTITUDE)
              : prev.ms;
          const darkCross =
            prev.sunAltitude > DARK_ENOUGH_SUN_ALTITUDE
              ? crossingMs(prev, s, prev.sunAltitude, s.sunAltitude, DARK_ENOUGH_SUN_ALTITUDE)
              : prev.ms;
          startMs = Math.max(altCross, darkCross);
        }
        current = { startMs, endMs: s.ms, peakMs: s.ms, peakAltitude: alt };
      }
      current.endMs = s.ms;
      if (alt > current.peakAltitude) {
        current.peakAltitude = alt;
        current.peakMs = s.ms;
      }
    } else if (current) {
      const prev = samples[i - 1];
      const prevAlt = prev.altitudes.get(id) ?? -90;
      const altCross =
        alt < MIN_USEFUL_ALTITUDE
          ? crossingMs(prev, s, prevAlt, alt, MIN_USEFUL_ALTITUDE)
          : Infinity;
      const darkCross =
        s.sunAltitude > DARK_ENOUGH_SUN_ALTITUDE
          ? crossingMs(prev, s, prev.sunAltitude, s.sunAltitude, DARK_ENOUGH_SUN_ALTITUDE)
          : Infinity;
      current.endMs = Math.min(altCross, darkCross, s.ms);
      runs.push(current);
      current = null;
    }
  }

  if (current) runs.push(current);
  return runs.filter((r) => r.endMs - r.startMs > 10 * 60_000);
}

// ---------------------------------------------------------------------------
// moments
// ---------------------------------------------------------------------------

function toDate(t: AstroTime | null): Date | null {
  return t ? t.date : null;
}

function collectMoments(from: Date, hours: number, site: ObserverSite): TimelineMoment[] {
  const observer = toObserver(site);
  const start = MakeTime(from);
  const limitDays = hours / 24;
  const moments: TimelineMoment[] = [];

  const push = (
    id: string,
    label: string,
    date: Date | null,
    kind: TimelineMoment['kind'],
  ) => {
    if (!date) return;
    if (date < from || date.getTime() > from.getTime() + hours * 3_600_000) return;
    moments.push({ id, label, time: date, kind });
  };

  push('sunset', 'Sunset', toDate(SearchRiseSet(Body.Sun, observer, -1, start, limitDays)), 'sunset');
  push('sunrise', 'Sunrise', toDate(SearchRiseSet(Body.Sun, observer, +1, start, limitDays)), 'sunrise');
  push(
    'dusk',
    'Dark enough for stars',
    toDate(SearchAltitude(Body.Sun, observer, -1, start, limitDays, -12)),
    'dusk',
  );
  push(
    'dawn',
    'Sky starts to brighten',
    toDate(SearchAltitude(Body.Sun, observer, +1, start, limitDays, -12)),
    'dawn',
  );
  push('moonrise', 'Moonrise', toDate(SearchRiseSet(Body.Moon, observer, +1, start, limitDays)), 'moonrise');
  push('moonset', 'Moonset', toDate(SearchRiseSet(Body.Moon, observer, -1, start, limitDays)), 'moonset');

  return moments.sort((a, b) => a.time.getTime() - b.time.getTime());
}

function findDarkness(samples: Sample[]): { start: Date; end: Date } | undefined {
  let bestStart: number | null = null;
  let best: { start: number; end: number } | null = null;

  for (let i = 0; i < samples.length; i++) {
    const dark = samples[i].sunAltitude <= DARK_ENOUGH_SUN_ALTITUDE;
    if (dark && bestStart === null) bestStart = samples[i].ms;
    if ((!dark || i === samples.length - 1) && bestStart !== null) {
      const end = samples[i].ms;
      if (!best || end - bestStart > best.end - best.start) best = { start: bestStart, end };
      bestStart = null;
    }
  }

  return best ? { start: new Date(best.start), end: new Date(best.end) } : undefined;
}

// ---------------------------------------------------------------------------
// phrasing
// ---------------------------------------------------------------------------

/**
 * A wall-clock time where the observer is standing.
 *
 * `timeZone: undefined` is not the same as omitting the option in spirit, but
 * it is in effect: Intl falls back to the device's zone, which is right when
 * the lookup has not answered yet and right again when the observer really is
 * where their device thinks they are.
 */
function formatClock(date: Date, timeZone: string | undefined): string {
  return date.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });
}

function describeBodySpan(
  name: string,
  run: Run,
  azimuth: number,
  magnitude: number,
  timeZone: string | undefined,
): string {
  const hours = (run.endMs - run.startMs) / 3_600_000;
  const duration =
    hours >= 1.5 ? `${hours.toFixed(1)} hours` : `${Math.round(hours * 60)} minutes`;
  const brightness =
    magnitude < 0
      ? 'It is one of the brightest things in the sky tonight'
      : magnitude < 2
        ? 'It is bright enough to spot from a lit street'
        : magnitude < 4
          ? 'You will want to be away from direct lights'
          : 'It is faint; you need a properly dark sky';

  return (
    `${name} is well placed from ${formatClock(new Date(run.startMs), timeZone)} for about ${duration}, ` +
    `reaching ${heightInWords(run.peakAltitude)} toward the ${compassPoint(azimuth)} ` +
    `around ${formatClock(new Date(run.peakMs), timeZone)}. ${brightness}.`
  );
}

export function describePass(pass: SatellitePass, timeZone?: string): string {
  if (!pass.visible || !pass.visibleFrom || !pass.visibleTo) {
    return (
      `${pass.name} crosses the sky from ${formatClock(pass.start, timeZone)}, but it is either in Earth's ` +
      `shadow or the sky is too bright; nothing to see on this one.`
    );
  }

  const minutes = Math.max(1, Math.round((pass.visibleTo.getTime() - pass.visibleFrom.getTime()) / 60_000));
  // A pass that never gets high never "climbs" anywhere, so say what it does.
  const arc =
    pass.peakAltitude < 15
      ? `stays low along the ${compassPoint(pass.peakAzimuth)} horizon`
      : `climbs ${heightInWords(pass.peakAltitude)} toward the ${compassPoint(pass.peakAzimuth)}`;

  return (
    `${pass.name} appears at ${formatClock(pass.visibleFrom, timeZone)} in the ${compassPoint(pass.startAzimuth)}, ` +
    `${arc}, and is visible for about ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
    `It looks like a steady white point sliding across the sky, no flashing lights.`
  );
}

// ---------------------------------------------------------------------------
// assembly
// ---------------------------------------------------------------------------

/**
 * @param hours Length of the window. The default covers a full day so that
 * someone opening the app in the morning still sees tonight, rather than an
 * empty timeline; the view then focuses itself on the dark hours.
 */
export function buildTimeline(
  from: Date,
  site: ObserverSite,
  tleSet: TleSet | null,
  satelliteError?: string,
  hours = 24,
): TonightTimeline {
  const samples = sampleWindow(from, hours, site);
  const spans: TimelineSpan[] = [];

  const bodyNames = new Map<string, string>([['moon', 'The Moon']]);
  for (const planet of PLANETS) bodyNames.set(String(planet).toLowerCase(), String(planet));

  for (const [id, label] of bodyNames) {
    for (const [index, run] of findRuns(samples, id).entries()) {
      const peakSample = samples.reduce((best, s) =>
        Math.abs(s.ms - run.peakMs) < Math.abs(best.ms - run.peakMs) ? s : best,
      );
      const magnitude = peakSample.magnitudes.get(id) ?? 99;
      const azimuth = peakSample.azimuths.get(id) ?? 0;

      // Nothing fainter than the naked-eye limit gets promoted as an event.
      if (magnitude > 6) continue;

      const properName = id === 'moon' ? 'Moon' : label;
      spans.push({
        id: `${id}-${index}`,
        kind: id === 'moon' ? 'moon' : 'planet',
        name: label,
        start: new Date(run.startMs),
        end: new Date(run.endMs),
        peak: new Date(run.peakMs),
        peakAltitude: run.peakAltitude,
        peakAzimuth: azimuth,
        magnitude,
        detail: describeBodySpan(label, run, azimuth, magnitude, site.timezone),
        fact: BODY_FACTS[properName],
        quality: magnitude < 0.5 ? 'headline' : magnitude < 4 ? 'good' : 'faint',
      });
    }
  }

  // --- satellite passes ---
  if (tleSet) {
    for (const noradId of TRACKED_FOR_PASSES) {
      const record = tleSet.records.find((r) => r.noradId === noradId);
      if (!record) continue;

      for (const pass of findPasses(record, site, from, hours)) {
        if (!pass.visible) continue;
        spans.push({
          id: `pass-${noradId}-${pass.start.getTime()}`,
          kind: 'satellite-pass',
          name: pass.name,
          start: pass.visibleFrom ?? pass.start,
          end: pass.visibleTo ?? pass.end,
          peak: pass.peak,
          peakAltitude: pass.peakAltitude,
          peakAzimuth: pass.peakAzimuth,
          detail: describePass(pass, site.timezone),
          quality: pass.peakAltitude > 40 ? 'headline' : 'good',
        });
      }
    }
  }

  spans.sort((a, b) => a.start.getTime() - b.start.getTime());

  const { moon } = computeSolarSystem(from, site);

  return {
    from,
    to: new Date(from.getTime() + hours * 3_600_000),
    spans,
    moments: collectMoments(from, hours, site),
    darkness: findDarkness(samples),
    // Every third sample is plenty to draw a smooth band.
    sunTrack: samples
      .filter((_, i) => i % 3 === 0)
      .map((s) => ({ ms: s.ms, altitude: s.sunAltitude })),
    moonPhase: {
      name: moon.phaseName ?? moonPhaseName(0),
      illuminatedFraction: moon.illuminatedFraction ?? 0,
    },
    satelliteDataError: satelliteError,
  };
}

/**
 * The single most interesting thing coming up, for the app's opening line.
 * Prefers a satellite pass: a moving object with a deadline beats a planet
 * that will still be there in an hour.
 */
export function headlineSpan(timeline: TonightTimeline, now: Date): TimelineSpan | null {
  const upcoming = timeline.spans.filter((s) => s.end > now);
  if (!upcoming.length) return null;

  const pass = upcoming.find((s) => s.kind === 'satellite-pass');
  if (pass) return pass;

  const live = upcoming.filter((s) => s.start <= now);
  const pool = live.length ? live : upcoming;
  return pool.reduce((best, s) => ((s.magnitude ?? 99) < (best.magnitude ?? 99) ? s : best));
}

/** Current sky darkness, exposed for the header readout. */
export function currentDarkness(now: Date, site: ObserverSite) {
  const { sun } = computeSolarSystem(now, site);
  return darknessFromSunAltitude(sun.altitude);
}

export function visibleNow(bodies: SkyBody[], now: Date, site: ObserverSite): SkyBody[] {
  const darkness = currentDarkness(now, site);
  const limit =
    darkness === 'day' ? -3.5 : darkness === 'civil-twilight' ? 1.5 : darkness === 'nautical-twilight' ? 3.5 : 5.5;
  return bodies.filter((b) => b.altitude > 5 && (b.magnitude <= limit || b.kind === 'moon'));
}
