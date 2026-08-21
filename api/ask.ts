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

/**
 * One turn of the exchange, in the shape watsonx wants it.
 *
 * `tool` messages are how a result gets back to the model: the client runs the
 * function and posts the answer back keyed to the call it answers.
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: { id: string; type?: string; function?: { name?: string; arguments?: string } }[];
  tool_call_id?: string;
}

/**
 * How far this will carry a conversation.
 *
 * A question needing four lookups is a question, and one needing forty is
 * either a loop or somebody using the endpoint as a relay for something else.
 * The cap is on turns and on bytes, because either can run away on its own.
 */
const MAX_TRANSCRIPT_TURNS = 24;
const MAX_TRANSCRIPT_BYTES = 120_000;

/** Thrown when a model is simply absent from this project, so the walk continues. */
class ModelUnavailable extends Error {}

/**
 * Everything the tools returned during this exchange, read back out of the
 * transcript.
 *
 * Parsed rather than taken on trust: a tool message whose content is not JSON
 * is dropped instead of being fed to the guard as a string, because a string
 * full of digits would widen the pool of numbers the answer is allowed to
 * contain and that pool is the whole point of the check.
 */
function toolResultsIn(transcript: ChatMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of transcript) {
    if (message.role !== 'tool' || typeof message.content !== 'string') continue;
    try {
      out.push(JSON.parse(message.content));
    } catch {
      /* Not JSON, so not evidence. */
    }
  }
  return out;
}

/** One call to watsonx, returning the assistant turn it produced. */
async function callModel(options: {
  base: string;
  token: string;
  projectId: string;
  modelId: string;
  messages: ChatMessage[];
  tools?: unknown[];
  tone: Tone;
}): Promise<ChatMessage> {
  const { base, token, projectId, modelId, messages, tools, tone } = options;

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
      messages,
      ...(tools?.length ? { tools, tool_choice_option: 'auto' } : {}),
      max_tokens: tone === 'simple' ? 220 : 340,
      temperature: 0.4,
      time_limit: 20_000,
    }),
    signal: AbortSignal.timeout(25_000),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    const message = `watsonx responded ${upstream.status} for ${modelId}: ${detail.slice(0, 300)}`;
    if (isModelUnavailable(upstream.status, detail)) throw new ModelUnavailable(message);
    throw new Error(message);
  }

  const json = (await upstream.json()) as { choices?: { message?: ChatMessage }[] };
  return json.choices?.[0]?.message ?? { role: 'assistant' };
}

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

  /*
   * The exchange so far, as the model left it.
   *
   * The endpoint holds nothing between requests, because the tools do not run
   * here: they run in the browser, on the observer's own machine, which is the
   * only place this app computes a sky. So a question that needs a tool takes
   * two trips. The model asks, this returns the request to the client, the
   * client answers it out of astronomy-engine and comes back with the result,
   * and the transcript is what carries the middle of that conversation across
   * the gap.
   *
   * It arrives from the client and is therefore not trusted: capped in length
   * and in size, and never executed. It is text on its way to a model.
   */
  const transcript = Array.isArray(body.transcript)
    ? (body.transcript as ChatMessage[]).slice(0, MAX_TRANSCRIPT_TURNS)
    : [];

  /*
   * The tools come from the client too, for the same reason the sky does: the
   * functions live next to the astronomy that implements them, and a second
   * copy of their declarations over here would be a second copy to drift. This
   * endpoint never calls them. It forwards a list of names and shapes to the
   * model and hands the model's requests back.
   */
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]).slice(0, 12) : undefined;

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
    ...transcript,
  ];

  if (JSON.stringify(messages).length > MAX_TRANSCRIPT_BYTES) {
    sendJson(res, 413, {
      error: 'conversation_too_long',
      message: 'This exchange has grown past what the endpoint will forward.',
    });
    return;
  }

  /*
   * Everything the answer is allowed to be built from.
   *
   * The sky context, plus whatever the tools actually returned during this
   * exchange, read back out of the transcript rather than passed separately so
   * the two can never disagree. This is the pool the grounding guard tests
   * against: a number in the answer has to have come from the computed sky or
   * from a function that computed it, and there is no third source.
   */
  const evidence: unknown[] = [skyContext, ...toolResultsIn(transcript)];

  try {
    const token = await getIamToken(apiKey);
    const base = (process.env.WATSONX_URL || DEFAULT_URL).replace(/\/+$/, '');

    let lastError = 'watsonx request failed';

    for (const modelId of modelCandidates()) {
      let reply: ChatMessage;
      try {
        reply = await callModel({ base, token, projectId, modelId, messages, tools, tone });
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (err instanceof ModelUnavailable) continue;
        throw err;
      }

      preferredModel = modelId;

      /*
       * The model wants to look something up.
       *
       * Handed straight back to the client, which is where the sky is. Nothing
       * is decided here about whether the request is reasonable; the tools
       * themselves refuse what they cannot answer, and they are the only ones
       * in a position to know.
       */
      if (reply.tool_calls?.length) {
        sendJson(res, 200, {
          kind: 'tool_calls',
          model: modelId,
          calls: reply.tool_calls.map((call) => ({
            id: call.id,
            name: call.function?.name,
            arguments: call.function?.arguments,
          })),
          transcript: [...transcript, reply],
        });
        return;
      }

      const text = reply.content?.trim();
      if (!text) {
        lastError = `${modelId} returned an empty completion`;
        continue;
      }

      // --- grounding check --------------------------------------------------
      //
      // Against the sky context and every tool result in this exchange. An
      // answer that states a number, name or direction none of them supports
      // gets one retry before the endpoint refuses to send it. Two round trips
      // is the limit before someone standing in a field gives up and moves on.

      const firstReport = checkGrounding(text, evidence);
      if (firstReport.ok) {
        sendJson(res, 200, { kind: 'answer', text, model: modelId, checked: true });
        return;
      }

      const retry = await callModel({
        base,
        token,
        projectId,
        modelId,
        tone,
        tools,
        messages: [
          ...messages,
          { role: 'assistant', content: text },
          {
            role: 'user',
            content:
              'Your previous answer contained claims that are not supported by the sky data ' +
              'or by any tool result in this conversation:\n' +
              firstReport.unsupported.map((u) => `- ${u}`).join('\n') +
              '\nPlease answer again using only what those contain. If they do not support ' +
              'what was asked, say so rather than guess.',
          },
        ],
      });

      const retryText = retry.content?.trim();
      if (retryText) {
        const retryReport = checkGrounding(retryText, evidence);
        if (retryReport.ok) {
          sendJson(res, 200, { kind: 'answer', text: retryText, model: modelId, checked: true });
          return;
        }
        sendJson(res, 502, { error: 'ai_ungrounded', unsupported: retryReport.unsupported });
        return;
      }

      sendJson(res, 502, { error: 'ai_ungrounded', unsupported: firstReport.unsupported });
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
