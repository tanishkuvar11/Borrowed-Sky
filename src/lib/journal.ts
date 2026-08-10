/**
 * The sky journal — a personal record of what you have found, kept entirely on
 * the device. No account, no server, nothing to sign up for. That is a
 * deliberate constraint: the whole product is meant to work for someone who
 * cannot or will not create an account.
 */

import { useCallback, useEffect, useState } from 'react';
import type { ObjectKind, SkyBody, ObserverSite } from './astro/types';

const STORAGE_KEY = 'borrowed-sky:journal';
const MAX_ENTRIES = 500;

export interface JournalEntry {
  id: string;
  seenAt: string;
  name: string;
  kind: ObjectKind;
  designation?: string;
  /** Where it was in the sky at the moment it was logged. */
  altitude: number;
  azimuth: number;
  magnitude: number;
  constellation?: string;
  latitude: number;
  longitude: number;
  note?: string;
}

function read(): JournalEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
  } catch {
    return [];
  }
}

function write(entries: JournalEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage unavailable — the session still works, it just will not persist.
  }
}

export interface JournalStats {
  total: number;
  distinctObjects: number;
  nights: number;
  firstSeen?: Date;
  /** How many of the eight planets have been logged. */
  planetsFound: number;
  kinds: Record<string, number>;
}

export function summarise(entries: JournalEntry[]): JournalStats {
  const names = new Set<string>();
  const nights = new Set<string>();
  const kinds: Record<string, number> = {};
  const planets = new Set<string>();

  for (const entry of entries) {
    names.add(entry.name);
    // Group by local calendar date, shifted so an after-midnight sighting still
    // counts as the same night's observing.
    const date = new Date(entry.seenAt);
    date.setHours(date.getHours() - 12);
    nights.add(date.toDateString());
    kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
    if (entry.kind === 'planet') planets.add(entry.name);
  }

  const sorted = [...entries].sort(
    (a, b) => new Date(a.seenAt).getTime() - new Date(b.seenAt).getTime(),
  );

  return {
    total: entries.length,
    distinctObjects: names.size,
    nights: nights.size,
    firstSeen: sorted.length ? new Date(sorted[0].seenAt) : undefined,
    planetsFound: planets.size,
    kinds,
  };
}

export function useJournal() {
  const [entries, setEntries] = useState<JournalEntry[]>(read);

  useEffect(() => {
    write(entries);
  }, [entries]);

  const record = useCallback((body: SkyBody, site: ObserverSite, note?: string) => {
    const entry: JournalEntry = {
      id: `${body.id}-${Date.now()}`,
      seenAt: new Date().toISOString(),
      name: body.name,
      kind: body.kind,
      designation: body.designation,
      altitude: Math.round(body.altitude * 10) / 10,
      azimuth: Math.round(body.azimuth * 10) / 10,
      magnitude: Math.round(body.magnitude * 100) / 100,
      constellation: body.constellation,
      latitude: Math.round(site.latitude * 100) / 100,
      longitude: Math.round(site.longitude * 100) / 100,
      note,
    };
    setEntries((prev) => [entry, ...prev].slice(0, MAX_ENTRIES));
    return entry;
  }, []);

  const remove = useCallback((id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const clear = useCallback(() => setEntries([]), []);

  /** True when this object has already been logged tonight. */
  const seenTonight = useCallback(
    (name: string) => {
      const cutoff = Date.now() - 14 * 3_600_000;
      return entries.some((e) => e.name === name && new Date(e.seenAt).getTime() > cutoff);
    },
    [entries],
  );

  return { entries, record, remove, clear, seenTonight, stats: summarise(entries) };
}
