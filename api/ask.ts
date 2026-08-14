/**
 * IBM watsonx.ai (Granite) narration endpoint.
 *
 * The single rule this file exists to enforce: the model never computes the sky.
 * Every position, time, magnitude and distance is calculated in the browser from
 * astronomy-engine and SGP4, then passed in here as structured JSON. Granite's
 * only job is turning that JSON into a sentence a ten-year-old can follow.
 *
 * If credentials are absent or watsonx errors, this returns a machine-readable
 * failure and the client falls back to a deterministic template narrator built
 * from the same numbers. The app never invents sky data to cover a gap.
 */

import { readJsonBody, sendJson, type ApiRequest, type ApiResponse } from './_lib/http.js';

const DEFAULT_URL = 'https://us-south.ml.cloud.ibm.com';
const DEFAULT_MODEL = 'ibm/granite-3-3-8b-instruct';
const API_VERSION = '2024-10-08';

const SYSTEM_PROMPT = `You are the sky guide inside "Borrowed Sky", an app for people who have never used an astronomy tool and may have no telescope and no prior knowledge.

ABSOLUTE RULES:
- The JSON block you are given is the ONLY authoritative description of this observer's sky. It was computed from real astronomical data for their exact location and moment.
- Never state a position, altitude, direction, time, distance or brightness that is not present in that JSON. Do not estimate or recall them from memory.
- If you are asked something the JSON does not answer, say plainly that you cannot see it in tonight's data. Never guess.
- Never claim something is visible if the JSON says it is below the horizon or not currently visible.

STYLE:
- Warm, direct, and concrete. Second person. Point people at the sky, not at a screen.
- Use compass directions and rough height above the horizon ("about a third of the way up in the south-east") rather than raw numbers, unless asked for precision.
- No emoji. No markdown headings. No bullet lists unless asked.`;

const TONE = {
  simple: `Write for a curious ten-year-old. Two or three short sentences. Everyday words only, no jargon. One vivid, true comparison is welcome.`,
  standard: `Write for an interested adult beginner. Three or four sentences. Plain language, but you may name real physical facts (distance, type of object, why it looks the way it does) when they appear in the data.`,
} as const;

type Tone = keyof typeof TONE;

// --- IBM Cloud IAM token, cached until shortly before it expires -------------

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getIamToken(apiKey: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: apiKey,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`IAM token request failed (${res.status})`);
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!json.access_token) throw new Error('IAM response contained no access token');

  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000,
  };
  return tokenCache.token;
}

// --- crude per-IP throttle, since this endpoint is public and unauthenticated -

const hits = new Map<string, number[]>();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

function throttled(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > MAX_PER_WINDOW;
}

// ---------------------------------------------------------------------------

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const apiKey = process.env.WATSONX_API_KEY;
  const projectId = process.env.WATSONX_PROJECT_ID;

  if (!apiKey || !projectId) {
    // Not an error condition, just an unconfigured deployment. The client has a
    // deterministic narrator for exactly this case.
    sendJson(res, 503, {
      error: 'ai_unconfigured',
      message:
        'watsonx credentials are not set on this deployment. Set WATSONX_API_KEY and WATSONX_PROJECT_ID to enable Granite narration.',
    });
    return;
  }

  const forwarded = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded || 'local').split(',')[0].trim();
  if (throttled(ip)) {
    sendJson(res, 429, { error: 'rate_limited', message: 'Too many questions in a minute.' });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'bad_request', message: 'Could not read request body.' });
    return;
  }

  const question = typeof body.question === 'string' ? body.question.slice(0, 500) : '';
  const tone: Tone = body.tone === 'simple' ? 'simple' : 'standard';
  const skyContext = body.skyContext;

  if (!skyContext || typeof skyContext !== 'object') {
    sendJson(res, 400, {
      error: 'missing_context',
      message: 'skyContext is required. The model is never allowed to compute the sky itself.',
    });
    return;
  }

  const userPrompt = [
    'COMPUTED SKY DATA (the only source of truth):',
    '```json',
    JSON.stringify(skyContext),
    '```',
    '',
    TONE[tone],
    '',
    question
      ? `The person watching the sky asks: "${question}"`
      : 'Introduce what is worth looking at right now, and where to look.',
  ].join('\n');

  try {
    const token = await getIamToken(apiKey);
    const base = (process.env.WATSONX_URL || DEFAULT_URL).replace(/\/+$/, '');

    const upstream = await fetch(`${base}/ml/v1/text/chat?version=${API_VERSION}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model_id: process.env.WATSONX_MODEL_ID || DEFAULT_MODEL,
        project_id: projectId,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: tone === 'simple' ? 220 : 340,
        temperature: 0.4,
        time_limit: 20_000,
      }),
      signal: AbortSignal.timeout(25_000),
    });

    if (!upstream.ok) {
      const detail = await upstream.text().catch(() => '');
      throw new Error(`watsonx responded ${upstream.status}: ${detail.slice(0, 300)}`);
    }

    const json = (await upstream.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = json.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('watsonx returned an empty completion');

    sendJson(res, 200, {
      text,
      model: process.env.WATSONX_MODEL_ID || DEFAULT_MODEL,
      grounded: true,
    });
  } catch (err) {
    sendJson(res, 502, {
      error: 'ai_unavailable',
      message: err instanceof Error ? err.message : 'watsonx request failed',
    });
  }
}
