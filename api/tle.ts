/**
 * Celestrak TLE proxy.
 *
 * Celestrak serves orbital elements for free and without an API key, but sends
 * no Access-Control-Allow-Origin header, so a browser cannot fetch it directly.
 * This endpoint is that missing hop and nothing more — it forwards the response
 * verbatim. It never synthesises elements: if Celestrak is unreachable the
 * client is told so explicitly and the UI drops into a stated "unavailable"
 * state rather than showing invented passes.
 */

import { queryParam, sendJson, type ApiRequest, type ApiResponse } from './_lib/http.js';

/** Only these Celestrak groups may be requested, so this is not an open proxy. */
const ALLOWED_GROUPS = new Set(['stations', 'visual']);

const UPSTREAM = 'https://celestrak.org/NORAD/elements/gp.php';

/** Celestrak asks clients not to poll faster than the elements actually change. */
const TTL_MS = 2 * 60 * 60 * 1000;

interface CacheEntry {
  fetchedAt: number;
  text: string;
}
const cache = new Map<string, CacheEntry>();

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const group = queryParam(req, 'group') || 'stations';
  if (!ALLOWED_GROUPS.has(group)) {
    sendJson(res, 400, {
      error: 'unsupported_group',
      message: `group must be one of: ${[...ALLOWED_GROUPS].join(', ')}`,
    });
    return;
  }

  const cached = cache.get(group);
  if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
    sendJson(
      res,
      200,
      { group, source: 'celestrak.org', fetchedAt: cached.fetchedAt, tle: cached.text },
      3600,
    );
    return;
  }

  try {
    const upstream = await fetch(`${UPSTREAM}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`, {
      headers: { 'User-Agent': 'BorrowedSky/1.0 (open-source sky guide)' },
      signal: AbortSignal.timeout(12_000),
    });

    if (!upstream.ok) throw new Error(`celestrak responded ${upstream.status}`);
    const text = await upstream.text();

    // A valid TLE set is groups of three lines; anything else means Celestrak
    // returned an error page. Serving that as elements would be worse than failing.
    if (!/^1 \d{5}/m.test(text) || !/^2 \d{5}/m.test(text)) {
      throw new Error('upstream payload was not TLE data');
    }

    const entry: CacheEntry = { fetchedAt: Date.now(), text };
    cache.set(group, entry);
    sendJson(res, 200, { group, source: 'celestrak.org', fetchedAt: entry.fetchedAt, tle: text }, 3600);
  } catch (err) {
    // Stale elements are still real elements, and SGP4 degrades gracefully over
    // a few days, so prefer them over nothing — but say that is what happened.
    if (cached) {
      sendJson(res, 200, {
        group,
        source: 'celestrak.org',
        fetchedAt: cached.fetchedAt,
        stale: true,
        tle: cached.text,
      });
      return;
    }
    sendJson(res, 502, {
      error: 'upstream_unavailable',
      message: err instanceof Error ? err.message : 'could not reach celestrak.org',
    });
  }
}
