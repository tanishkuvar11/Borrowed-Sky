/**
 * Turns a question into a vector, so the corpus can be searched by meaning.
 *
 * This is the second model in the app and it does a completely different job
 * from the first. Granite writes sentences; this one only ever produces
 * numbers, and those numbers are compared against the ones baked into
 * public/data/corpus.json at build time. Nothing here generates text and
 * nothing here decides anything.
 *
 * The search itself happens in the browser. A hundred and twenty passages
 * against one query is a hundred and twenty dot products, which is nothing, and
 * doing it on the client means the corpus never has to be uploaded and the
 * question never has to be stored anywhere. This endpoint is the one step that
 * cannot be done locally, and it is deliberately the smallest possible step:
 * text in, vector out.
 *
 * THE PART THAT MATTERS
 *
 * A vector is only meaningful next to vectors from the same model. Mixing them
 * fails silently and expensively: the arithmetic still works, the nearest
 * neighbours are noise, and the guide starts citing a passage about Neptune's
 * winds in answer to a question about magnitude. So the model that produced
 * each vector is named in the response, the corpus records the model that built
 * it, and the client refuses to search when the two disagree. There is no
 * degraded mode here. Either the comparison is valid or there is no comparison.
 */

import { readJsonBody, sendJson, type ApiRequest, type ApiResponse } from './_lib/http.js';

const DEFAULT_URL = 'https://us-south.ml.cloud.ibm.com';
const API_VERSION = '2024-10-08';

/** IBM's retrieval embedder on watsonx, and its local counterpart. */
const HOSTED_MODEL = 'ibm/slate-125m-english-rtrvr';
const LOCAL_MODEL = 'granite-embedding:30m';

/** A question is one short string. Anything else is somebody else's workload. */
const MAX_INPUTS = 4;
const MAX_CHARS = 1000;

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getIamToken(apiKey: string): Promise<string> {
  if (tokenCache && Date.now() < tokenCache.expiresAt) return tokenCache.token;

  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: apiKey,
    }),
    signal: AbortSignal.timeout(12_000),
  });

  if (!res.ok) throw new Error(`IAM rejected the API key (${res.status})`);
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + Math.max(60, (json.expires_in ?? 3600) - 300) * 1000,
  };
  return json.access_token;
}

/** Unit length, so the client's search is a dot product and needs no norms. */
function normalise(vector: number[]): number[] {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum) || 1;
  return vector.map((v) => Math.round((v / length) * 10000) / 10000);
}

export default async function handler(req: ApiRequest, res: ApiResponse) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'method_not_allowed' });
    return;
  }

  const body = await readJsonBody(req);
  const raw = Array.isArray(body.input) ? body.input : [];
  const inputs = raw
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .slice(0, MAX_INPUTS)
    .map((t) => t.slice(0, MAX_CHARS));

  if (!inputs.length) {
    sendJson(res, 400, { error: 'no_input', message: 'input must be a non-empty array of strings.' });
    return;
  }

  const apiKey = process.env.WATSONX_API_KEY;
  const projectId = process.env.WATSONX_PROJECT_ID;
  const localModel = process.env.OLLAMA_EMBED_MODEL || (process.env.OLLAMA_MODEL ? LOCAL_MODEL : null);

  try {
    if (apiKey && projectId) {
      const token = await getIamToken(apiKey);
      const base = (process.env.WATSONX_URL || DEFAULT_URL).replace(/\/+$/, '');
      const model = process.env.WATSONX_EMBED_MODEL || HOSTED_MODEL;

      const upstream = await fetch(`${base}/ml/v1/text/embeddings?version=${API_VERSION}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ model_id: model, project_id: projectId, inputs }),
        signal: AbortSignal.timeout(20_000),
      });

      if (upstream.ok) {
        const json = (await upstream.json()) as { results?: { embedding: number[] }[] };
        const vectors = (json.results ?? []).map((r) => normalise(r.embedding));
        sendJson(res, 200, { model: `watsonx:${model}`, vectors }, 300);
        return;
      }

      // Fall through to the local embedder rather than failing outright. A dead
      // quota should cost the hosted answer, not the whole retrieval path.
      if (!localModel) {
        const detail = await upstream.text().catch(() => '');
        throw new Error(`watsonx embeddings responded ${upstream.status}: ${detail.slice(0, 200)}`);
      }
    }

    if (!localModel) {
      sendJson(res, 503, {
        error: 'embeddings_unconfigured',
        message: 'No embedding model is available on this deployment.',
      });
      return;
    }

    const ollama = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
    const upstream = await fetch(`${ollama}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: localModel, input: inputs }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!upstream.ok) throw new Error(`local embeddings responded ${upstream.status}`);
    const json = (await upstream.json()) as { embeddings?: number[][]; error?: string };
    if (json.error) throw new Error(`local embeddings: ${json.error}`);

    sendJson(
      res,
      200,
      { model: `ollama:${localModel}`, vectors: (json.embeddings ?? []).map(normalise) },
      300,
    );
  } catch (err) {
    sendJson(res, 502, {
      error: 'embeddings_unavailable',
      message: err instanceof Error ? err.message : 'the embedding request failed',
    });
  }
}
