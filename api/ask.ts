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
import { clientIp, createBucket, originAllowed, tooManyFrom } from './_lib/guard.js';
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
- If you are asked something you have no computed source for, say plainly that you cannot see it in tonight's data. Never guess.
- Never claim something is visible if the JSON says it is below the horizon or not currently visible.

STYLE:
- Warm, direct, and concrete. Second person. Point people at the sky, not at a screen.
- Use compass directions and rough height above the horizon ("about a third of the way up in the south-east") rather than raw numbers, unless asked for precision.
- No emoji. No markdown headings. No bullet lists unless asked.`;

/**
 * The half of the instructions that only makes sense when there are tools.
 *
 * Kept separate and appended only when tools are actually offered, because it
 * is the exact opposite advice otherwise: told to look things up with nothing
 * to look them up with, the model narrates a search it cannot run.
 *
 * This exists because the guardrails were fighting the tools. The rules above
 * are written to stop a model answering from memory, and they worked so well
 * that a model holding a function which would have computed the real answer
 * still declined and asked the user for their location instead. "Never state
 * what you cannot source" and "here is how to source it" have to arrive
 * together, or the first one wins and the second is never used.
 */
const TOOL_RULES = `
LOOKING THINGS UP:
- You have functions that compute this observer's sky from the same astronomical engine that produced the JSON above. What they return is exactly as authoritative as the JSON.
- If a question needs a position, a time, or an identification that the JSON does not already contain, CALL A FUNCTION. Do not refuse, and do not answer from memory or from what you know about the night sky in general.
- Never ask the person where they are or what time it is. Both are already known and the functions use them.
- Only say you cannot see something in tonight's data once a function has actually told you so.`;

const TONE = {
  simple: `Write for a curious ten-year-old who is standing outside, looking up.

- Two or three short sentences. Stop there.
- Everyday words only. Never write magnitude, azimuth, altitude, declination, apparent, celestial, ecliptic, elongation, or degrees.
- Never give a height as a number. Say it the way a person points: low down near the rooftops, about halfway up, high overhead, almost straight above you.
- A comparison is welcome when it is true and the child already knows the thing you compare it to.
- Sound pleased to be telling them. You are pointing at the sky with them, not reading them a fact.
- No lists, no headings, no bullet points. Just talk.`,
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

/*
 * The ceiling on one address.
 *
 * Twenty a minute, and a question can cost three of them: the model asks for a
 * lookup, the browser answers it, the model is asked again. So this is six or
 * seven questions a minute, which is faster than anybody types and slower than
 * anything trying to drain the quota. See _lib/guard.ts for what this does and
 * does not actually prevent.
 */
const bucket = createBucket();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20;

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

/*
 * Tool calls the model wrote out as prose instead of asking for properly.
 *
 * granite-4-h-small does this: rather than filling in the structured
 * tool_calls field, it prints `<tool_call> {"name": "where_is", ...}` into the
 * message body as if it were talking. The reply then looks like an ordinary
 * answer with no tool calls attached, so it went through the grounding check
 * and out to the client, which rendered the raw tag to somebody who had asked
 * where the space station was.
 *
 * Recovered rather than rejected. The model asked a perfectly sensible
 * question in the wrong envelope, and everything needed to answer it is
 * there — so it is lifted out, checked against the functions actually on
 * offer, and handed back as the tool call it was meant to be. The assistant
 * turn written into the transcript is the structured form too, because the
 * tool results that follow reference these ids and watsonx will not accept
 * them against a turn whose tool_calls are prose.
 */
const TOOL_CALL_BLOCK = /<\|?tool_call\|?>([\s\S]*?)<\/\|?tool_call\|?>/gi;

function leakedToolCalls(
  content: string | undefined,
  tools: unknown[] | undefined,
): ChatMessage['tool_calls'] {
  if (!content || !tools?.length) return undefined;

  const offered = new Set(
    tools
      .map((tool) => (tool as { function?: { name?: string } })?.function?.name)
      .filter((name): name is string => typeof name === 'string'),
  );

  const found: NonNullable<ChatMessage['tool_calls']> = [];
  for (const match of content.matchAll(TOOL_CALL_BLOCK)) {
    let parsed: { name?: string; arguments?: unknown };
    try {
      parsed = JSON.parse(match[1].trim());
    } catch {
      continue;
    }
    // Only functions this request actually offered. A name the model invented
    // is not a call, it is a hallucination with angle brackets around it.
    if (!parsed?.name || !offered.has(parsed.name)) continue;
    found.push({
      id: `leaked_${found.length}`,
      type: 'function',
      function: {
        name: parsed.name,
        // The wire format is a JSON string; the leaked form is usually an
        // object, because it was written by something composing prose.
        arguments:
          typeof parsed.arguments === 'string'
            ? parsed.arguments
            : JSON.stringify(parsed.arguments ?? {}),
      },
    });
  }

  return found.length ? found : undefined;
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
 * Whether a refusal looks like it was about the tools rather than about
 * anything else.
 *
 * Worth distinguishing, because the response to "you may not send me a tools
 * array" is to ask again without one, and the response to "your quota is
 * spent" or "that key is wrong" is not: retrying those just spends a second
 * call to be told the same thing. A rejected request is cheap and a wasted
 * round trip is not free either, so the retry is narrowed to the shape of
 * refusal it can actually do something about.
 *
 * Deliberately loose about the wording. Every host phrases this differently
 * and the cost of matching one phrase too many is one extra call.
 */
function looksLikeToolRefusal(message: string): boolean {
  if (/(401|403|429)/.test(message)) return false;
  return /tool|function[_ ]call|not supported|unsupported|invalid.*request|400/i.test(message);
}

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

/**
 * The same Granite, running on the machine this is served from.
 *
 * IBM publishes the Granite weights under Apache 2.0, so the model behind a
 * watsonx deployment is a model anybody can run. That is useful here for one
 * specific reason and it is worth being exact about it: the hosted path is the
 * real one, and this exists so that the tool-calling loop can be exercised
 * without spending a hosted token on every malformed argument and every
 * misunderstanding about message shape while it is being built.
 *
 * It is a fallback, never a preference. watsonx is tried first every time, and
 * when this answers instead the interface says so by name, because "which
 * model said this" is exactly the kind of thing this app refuses to be vague
 * about.
 *
 * Ollama differs from watsonx in two ways that matter. Its tool calls carry
 * arguments as an object rather than as a JSON string, and they have no id, so
 * both are normalised here into the shape the rest of this file already
 * speaks. Nothing downstream should have to know which one answered.
 */
async function callLocalModel(options: {
  messages: ChatMessage[];
  tools?: unknown[];
  tone: Tone;
}): Promise<{ reply: ChatMessage; model: string }> {
  const base = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_MODEL || 'granite3.3:8b';

  const upstream = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: options.messages,
      ...(options.tools?.length ? { tools: options.tools } : {}),
      stream: false,
      options: { temperature: 0.4, num_predict: options.tone === 'simple' ? 220 : 340 },
    }),
    // Generous. A local model on a laptop is slower than a datacentre and the
    // alternative to waiting is the narrator, which is always available anyway.
    signal: AbortSignal.timeout(120_000),
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    throw new Error(`local granite responded ${upstream.status}: ${detail.slice(0, 200)}`);
  }

  const json = (await upstream.json()) as {
    message?: {
      role?: string;
      content?: string;
      tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
    };
  };

  const raw = json.message ?? {};
  const reply: ChatMessage = { role: 'assistant', content: raw.content };

  if (raw.tool_calls?.length) {
    reply.tool_calls = raw.tool_calls.map((call, index) => ({
      id: `local-${index}`,
      type: 'function',
      function: {
        name: call.function?.name,
        arguments:
          typeof call.function?.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? {}),
      },
    }));
  }

  return { reply, model: `${model} (local)` };
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

  /*
   * A local Granite counts as configured, but only as a fallback.
   *
   * OLLAMA_MODEL has to be set for this to be considered at all: a machine that
   * happens to have Ollama running should not quietly start answering for
   * watsonx, because then a broken deployment looks like a working one and
   * nobody finds out until the credentials are needed.
   */
  const localAllowed = Boolean(process.env.OLLAMA_MODEL);

  if ((!apiKey || !projectId) && !localAllowed) {
    // Not an error condition, just an unconfigured deployment. The client has a
    // deterministic narrator for exactly this case.
    sendJson(res, 503, {
      error: 'ai_unconfigured',
      message:
        'watsonx credentials are not set on this deployment. Set WATSONX_API_KEY and WATSONX_PROJECT_ID to enable Granite narration.',
    });
    return;
  }

  /*
   * Refused before anything is spent, not after.
   *
   * Both of these run ahead of the IAM exchange and the model call, so a
   * request that is not going to be served costs the account nothing at all.
   */
  if (!originAllowed(req)) {
    sendJson(res, 403, {
      error: 'origin_not_allowed',
      message: 'This deployment does not answer requests from that origin.',
    });
    return;
  }

  if (tooManyFrom(bucket, clientIp(req), MAX_PER_WINDOW, WINDOW_MS)) {
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

  /*
   * The tools come from the client too, for the same reason the sky does: the
   * functions live next to the astronomy that implements them, and a second
   * copy of their declarations over here would be a second copy to drift. This
   * endpoint never calls them. It forwards a list of names and shapes to the
   * model and hands the model's requests back.
   */
  const tools = Array.isArray(body.tools) ? (body.tools as unknown[]).slice(0, 12) : undefined;
  /*
   * Passages retrieved from the corpus for this question.
   *
   * NASA's own writing, found by meaning rather than by keyword, and sent in
   * with the question so the model explains from a source instead of from
   * memory. It is the same rule the positions follow, applied to prose: the
   * guide may say what a thing is, as long as somebody it can cite said it
   * first.
   *
   * The client does the searching. This only carries the result, and the
   * grounding guard treats it as evidence like everything else, so a number
   * quoted out of a NASA passage is supported and one invented around it is
   * not.
   */
  const sources = Array.isArray(body.sources)
    ? (body.sources as { title?: string; source?: string; text?: string }[]).slice(0, 4)
    : [];

  const hasTools = Boolean(tools?.length);

  const userPrompt = [
    'COMPUTED SKY DATA (the only source of truth):',
    '```json',
    JSON.stringify(skyContext),
    '```',
    '',
    TONE[tone],
    '',
    ...(sources.length
      ? [
          'BACKGROUND, from NASA. You may explain using these and you must not explain from memory. Name the source in passing when you use one, as "NASA says" or similar. If they do not cover what was asked, say so.',
          ...sources.map(
            (passage, i) =>
              `[${i + 1}] ${passage.title ?? 'NASA'} (${passage.source ?? ''})\n${passage.text ?? ''}`,
          ),
          '',
        ]
      : []),
    question
      ? `The person watching the sky asks: "${question}"`
      : 'Introduce what is worth looking at right now, and where to look.',
    /*
     * The same instruction as the system rules, repeated last.
     *
     * Not redundancy for its own sake. A system prompt sits behind a JSON block
     * describing the whole sky, and a model reading that block concludes it has
     * been given everything there is; the smaller ones then decline rather than
     * look further, which is the failure this whole layer exists to fix. Put
     * next to the question, where it is the last thing read, it is acted on.
     */
    ...(hasTools
      ? [
          '',
          'If answering this needs a position, a time, or an identification that is not already in the JSON above, call one of the functions. Do not say you cannot see it until a function has told you so.',
        ]
      : []),
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


  const messages: ChatMessage[] = [
    { role: 'system', content: tools?.length ? SYSTEM_PROMPT + TOOL_RULES : SYSTEM_PROMPT },
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
  const evidence: unknown[] = [skyContext, ...toolResultsIn(transcript), ...sources];

  try {
    /*
     * One way to ask, whichever model ends up answering.
     *
     * watsonx is walked first, down the list of Granite deployments this
     * project might be offered, skipping any that are simply absent from the
     * region. Only when none of them can answer does the local model get a
     * turn, and only when it was explicitly allowed. Everything after this
     * point is written as though there were one model, because from here there
     * is.
     */
    const hosted = apiKey && projectId;
    const token = hosted ? await getIamToken(apiKey) : null;
    const base = (process.env.WATSONX_URL || DEFAULT_URL).replace(/\/+$/, '');
    let lastError = 'watsonx request failed';

    /*
     * Whether the tools had to be given up to get an answer at all.
     *
     * Reported rather than hidden, because an answer written without the
     * lookups is a different thing from one written with them, and the panel
     * under it says which.
     */
    let toolsDropped = false;

    const ask = async (turns: ChatMessage[]): Promise<{ reply: ChatMessage; model: string }> => {
      if (hosted && token) {
        for (const modelId of modelCandidates()) {
          try {
            const reply = await callModel({
              base,
              token,
              projectId,
              modelId,
              messages: turns,
              tools: toolsDropped ? undefined : tools,
              tone,
            });
            preferredModel = modelId;
            return { reply, model: modelId };
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
            if (err instanceof ModelUnavailable) continue;

            /*
             * One retry with the tools taken off.
             *
             * A host that will not accept a tools array, or a model that has
             * none, refuses the whole request; the failure is indistinguishable
             * from any other 400 and the result was no answer at all. Every
             * question would have fallen through to the deterministic narrator
             * and nothing would have said why.
             *
             * Granite answering from the sky snapshot without lookups is worse
             * than Granite with them and far better than silence, so the tools
             * are dropped and the question asked again. Once: a second failure
             * is not about the tools.
             */
            if (!toolsDropped && tools?.length && looksLikeToolRefusal(lastError)) {
              toolsDropped = true;
              try {
                const reply = await callModel({
                  base,
                  token,
                  projectId,
                  modelId,
                  messages: turns,
                  tone,
                });
                preferredModel = modelId;
                return { reply, model: modelId };
              } catch (second) {
                lastError = second instanceof Error ? second.message : String(second);
              }
            }

            if (!localAllowed) throw err;
            break;
          }
        }
      }

      if (!localAllowed) throw new Error(lastError);
      try {
        return await callLocalModel({ messages: turns, tools: toolsDropped ? undefined : tools, tone });
      } catch (err) {
        // Same reasoning as above. Plenty of local models have no tool support
        // at all and say so by refusing the request outright.
        const detail = err instanceof Error ? err.message : String(err);
        if (toolsDropped || !tools?.length || !looksLikeToolRefusal(detail)) throw err;
        toolsDropped = true;
        return callLocalModel({ messages: turns, tone });
      }
    };

    const { reply, model } = await ask(messages);

    /*
     * The model wants to look something up.
     *
     * Handed straight back to the client, which is where the sky is. Nothing is
     * decided here about whether the request is reasonable; the tools
     * themselves refuse what they cannot answer, and they are the only ones in
     * a position to know.
     */
    const asked = reply.tool_calls?.length
      ? reply.tool_calls
      : leakedToolCalls(reply.content, toolsDropped ? undefined : tools);

    if (asked?.length) {
      sendJson(res, 200, {
        kind: 'tool_calls',
        model,
        calls: asked.map((call) => ({
          id: call.id,
          name: call.function?.name,
          arguments: call.function?.arguments,
        })),
        transcript: [
          ...transcript,
          reply.tool_calls?.length ? reply : { role: 'assistant', content: '', tool_calls: asked },
        ],
      });
      return;
    }

    /*
     * Anything left over that still looks like a call is not an answer.
     *
     * A leak this did not recognise - a function name it invented, or JSON it
     * mangled - must not be printed at somebody as prose. Stripping it leaves
     * whatever real sentences came with it, and if that is nothing then this
     * completion was empty in every way that matters and is treated as such.
     */
    const text = reply.content?.replace(TOOL_CALL_BLOCK, '').trim();
    if (!text) throw new Error(`${model} returned an empty completion`);

    // --- grounding check ----------------------------------------------------
    //
    // Against the sky context and every tool result in this exchange. An answer
    // that states a number, name or direction none of them supports gets one
    // retry before the endpoint refuses to send it. Two round trips is the
    // limit before someone standing in a field gives up and moves on.

    const firstReport = checkGrounding(text, evidence);
    if (firstReport.ok) {
      sendJson(res, 200, { kind: 'answer', text, model, checked: true, toolsDropped });
      return;
    }

    const { reply: second } = await ask([
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
    ]);

    const retryText = second.content?.trim();
    if (retryText) {
      const retryReport = checkGrounding(retryText, evidence);
      if (retryReport.ok) {
        sendJson(res, 200, { kind: 'answer', text: retryText, model, checked: true, toolsDropped });
        return;
      }
      sendJson(res, 502, { error: 'ai_ungrounded', unsupported: retryReport.unsupported });
      return;
    }

    sendJson(res, 502, { error: 'ai_ungrounded', unsupported: firstReport.unsupported });
    return;
  } catch (err) {
    sendJson(res, 502, {
      error: 'ai_unavailable',
      message: err instanceof Error ? err.message : 'watsonx request failed',
    });
  }
}
