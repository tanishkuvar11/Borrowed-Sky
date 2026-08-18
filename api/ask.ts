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
import { checkGrounding } from './_lib/grounding.js';

const DEFAULT_URL = 'https://us-south.ml.cloud.ibm.com';
const API_VERSION = '2024-10-08';

/**
 * Granite models to try, in order.
 *
 * Which foundation models a watsonx project can actually call depends on its
 * region and plan, and a model that is present in one is simply absent in
 * another. Rather than let a demo die on a 404 for a model ID that was correct
 * when it was written, the endpoint walks this list and remembers the first one
 * that answers. `WATSONX_MODEL_ID` jumps the queue when it is set.
 */
const GRANITE_MODELS = [
  'ibm/granite-3-3-8b-instruct',
  'ibm/granite-4-h-small',
  'ibm/granite-3-2-8b-instruct',
  'ibm/granite-3-8b-instruct',
];

/** The model that last answered, so the walk happens once per cold start. */
let preferredModel: string | null = null;

function modelCandidates(): string[] {
  const configured = process.env.WATSONX_MODEL_ID?.trim();
  if (configured) return [configured];
  const rest = GRANITE_MODELS.filter((m) => m !== preferredModel);
  return preferredModel ? [preferredModel, ...rest] : rest;
}

/**
 * True when the failure is "this project cannot call that model" rather than
 * something that would fail identically for every other model. Only the former
 * is worth retrying down the list.
 */
function isModelUnavailable(status: number, detail: string): boolean {
  if (status !== 400 && status !== 404) return false;
  // A missing project is also a 404 whose body says "not_found", and walking
  // the whole model list against a project that does not exist just turns one
  // clear error into four slow ones.
  if (/container_not_found/i.test(detail)) return false;
  return /model_not|model_no_access|not supported|not_supported|invalid.*model/i.test(detail);
}

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
    const candidates = modelCandidates();

    let lastError = 'watsonx request failed';

    for (const modelId of candidates) {
      const upstream = await fetch(`${base}/ml/v1/text/chat?version=${API_VERSION}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model_id: modelId,
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
        lastError = `watsonx responded ${upstream.status} for ${modelId}: ${detail.slice(0, 300)}`;
        if (isModelUnavailable(upstream.status, detail)) continue;
        throw new Error(lastError);
      }

      const json = (await upstream.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const text = json.choices?.[0]?.message?.content?.trim();
      if (!text) {
        lastError = `${modelId} returned an empty completion`;
        continue;
      }

      preferredModel = modelId;

      // --- grounding check --------------------------------------------------
      //
      // Compare the answer against the sky context that was handed to the
      // model. An answer that mentions a number, name or direction the context
      // does not support gets one retry before the endpoint refuses to send it.
      // Two round trips is the limit before someone standing in a field gives
      // up and moves on.

      const firstReport = checkGrounding(text, skyContext);
      if (firstReport.ok) {
        sendJson(res, 200, { text, model: modelId, checked: true });
        return;
      }

      // Build a retry: replay the original conversation, append the first
      // answer as an assistant turn, then instruct the model to try again
      // using only what the JSON contains.
      const retryClaimsNote = firstReport.unsupported
        .map((u) => `- ${u}`)
        .join('\n');

      const retryUpstream = await fetch(`${base}/ml/v1/text/chat?version=${API_VERSION}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          model_id: modelId,
          project_id: projectId,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: text },
            {
              role: 'user',
              content:
                'Your previous answer contained claims that are not supported by the sky data:\n' +
                retryClaimsNote +
                '\nPlease answer again using only what is in the JSON. If the data does not ' +
                'support what was asked, say so rather than guess.',
            },
          ],
          max_tokens: tone === 'simple' ? 220 : 340,
          temperature: 0.4,
          time_limit: 20_000,
        }),
        signal: AbortSignal.timeout(25_000),
      });

      if (!retryUpstream.ok) {
        // The retry itself failed at the network level. Treat this the same as
        // any other upstream error so the outer catch can handle it cleanly.
        const detail = await retryUpstream.text().catch(() => '');
        throw new Error(
          `watsonx retry responded ${retryUpstream.status} for ${modelId}: ${detail.slice(0, 300)}`,
        );
      }

      const retryJson = (await retryUpstream.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const retryText = retryJson.choices?.[0]?.message?.content?.trim();

      if (retryText) {
        const retryReport = checkGrounding(retryText, skyContext);
        if (retryReport.ok) {
          sendJson(res, 200, { text: retryText, model: modelId, checked: true });
          return;
        }
        // Retry also failed grounding. Do not send either answer.
        sendJson(res, 502, {
          error: 'ai_ungrounded',
          unsupported: retryReport.unsupported,
        });
        return;
      }

      // Retry came back empty. Fall through to the next model candidate rather
      // than silently swallowing the failure: the empty-completion branch above
      // will handle it on the next iteration if we continue, but since we are
      // already past the model-walk, report it directly.
      sendJson(res, 502, {
        error: 'ai_ungrounded',
        unsupported: firstReport.unsupported,
      });
      return;
    }

    throw new Error(lastError);
  } catch (err) {
    sendJson(res, 502, {
      error: 'ai_unavailable',
      message: err instanceof Error ? err.message : 'watsonx request failed',
    });
  }
}
