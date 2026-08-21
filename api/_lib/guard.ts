/**
 * The two crude defences the public endpoints share.
 *
 * WHAT THIS IS FOR
 *
 * Three of the four endpoints here spend something that belongs to whoever
 * deployed this: /api/ask and /api/embed spend watsonx tokens on the owner's
 * key, and /api/place spends goodwill at OpenStreetMap, whose usage policy is
 * one request a second and whose remedy for ignoring it is blocking the
 * address. None of them requires a caller to prove anything, because none of
 * them can: this is an app somebody opens in a browser without an account, and
 * a secret shipped to a browser is not a secret.
 *
 * So what is here is deterrence, not authentication, and it is worth being
 * exact about the difference.
 *
 * WHAT IT STOPS AND WHAT IT DOES NOT
 *
 * The origin check stops another website from putting this app's AI behind its
 * own page, because a browser sets Origin on cross-site requests and will not
 * let script forge it. It does not stop curl, which simply omits the header or
 * sends whatever it likes. Anybody determined enough to read this file can get
 * past it in a minute; the point is that the accidental and the opportunistic
 * cases are the common ones.
 *
 * The throttle is per address and lives in memory, which on a serverless host
 * means per address per warm instance. A cold start begins with an empty map
 * and concurrent invocations do not share one, so the real ceiling is some
 * multiple of the number below rather than the number itself. It is written
 * down here rather than glossed over, because a limit that is quietly four
 * times looser than it claims is worse than a limit that says what it is.
 *
 * The honest summary: this raises the cost of casual abuse and does nothing
 * about a determined one. The thing actually protecting the account is that
 * the quota is finite and the URL is not advertised.
 */

import type { ApiRequest } from './http.js';

function header(req: ApiRequest, name: string): string | undefined {
  const value = req.headers[name] ?? req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The caller's address, as far as it can be known behind a proxy.
 *
 * The first entry in X-Forwarded-For is the client as the edge saw it. It is
 * caller-supplied and therefore forgeable, which matters not at all for a
 * throttle whose worst failure is letting somebody through.
 */
export function clientIp(req: ApiRequest): string {
  const forwarded = header(req, 'x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return header(req, 'x-real-ip') || 'local';
}

interface Bucket {
  hits: Map<string, number[]>;
}

/** A counter for one endpoint. Each keeps its own, so one cannot starve another. */
export function createBucket(): Bucket {
  return { hits: new Map() };
}

export function tooManyFrom(
  bucket: Bucket,
  ip: string,
  max: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const recent = (bucket.hits.get(ip) || []).filter((t) => now - t < windowMs);
  recent.push(now);
  bucket.hits.set(ip, recent);
  // A map that only ever grows is a slow leak on a warm instance. Nothing here
  // is worth remembering across a clear-out.
  if (bucket.hits.size > 5000) bucket.hits.clear();
  return recent.length > max;
}

/**
 * Whether this request came from somewhere the deployment recognises.
 *
 * Inert until ALLOWED_ORIGINS is set, so a clone runs, a tunnel works and the
 * dev server works without anybody configuring anything. That default is
 * deliberate and it is also the permissive one, which is the right way round
 * for a thing whose failure mode when misconfigured is refusing its own users.
 *
 * A request with no Origin at all is allowed. Browsers send it on exactly the
 * requests this is meant to stop, and everything else that omits it was never
 * going to be stopped by a header.
 */
export function originAllowed(req: ApiRequest): boolean {
  const configured = process.env.ALLOWED_ORIGINS?.trim();
  if (!configured) return true;

  const origin = header(req, 'origin');
  if (!origin) return true;

  return configured
    .split(',')
    .map((entry) => entry.trim().replace(/\/+$/, ''))
    .filter(Boolean)
    .includes(origin.replace(/\/+$/, ''));
}
