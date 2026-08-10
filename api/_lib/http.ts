/**
 * Minimal request/response helpers.
 *
 * These handlers run unchanged in two places: as Vercel serverless functions in
 * production, and inside a Vite dev-server middleware locally (see vite.config.ts).
 * So they only use the plain Node http surface that both environments share.
 */

export interface ApiRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  on(event: string, cb: (chunk?: unknown) => void): void;
}

export interface ApiResponse {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(chunk?: string): void;
}

export function sendJson(res: ApiResponse, status: number, payload: unknown, cacheSeconds = 0) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Cache-Control',
    cacheSeconds > 0 ? `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}` : 'no-store',
  );
  res.end(JSON.stringify(payload));
}

/** Reads and parses a JSON body, tolerating hosts that pre-parse it for us. */
export async function readJsonBody(req: ApiRequest): Promise<Record<string, unknown>> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>;
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  const raw = await new Promise<string>((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += String(chunk);
      // Guard against an oversized body on a public endpoint.
      if (data.length > 64_000) reject(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', () => reject(new Error('stream error')));
  });

  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function queryParam(req: ApiRequest, name: string): string | undefined {
  const url = new URL(req.url || '/', 'http://localhost');
  return url.searchParams.get(name) ?? undefined;
}
