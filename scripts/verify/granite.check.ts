/**
 * End-to-end check of the IBM Granite narration path.
 *
 * This talks to the real watsonx.ai deployment. Nothing here is stubbed: the
 * sky context handed to Granite is computed by the same code the browser runs,
 * for a real place and the real current moment, so a pass means the narration
 * path works on data of exactly the shape production sends.
 *
 * It answers three questions in order, because they fail for different reasons
 * and the message should say which:
 *
 *   1. Are the credentials good?          (IAM token exchange)
 *   2. Can this project call Granite?     (foundation model listing)
 *   3. Does a grounded request work?      (one real chat completion)
 *
 * Run: npx tsx scripts/verify/granite.check.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildSkyContext } from '../../src/lib/ai.ts';
import { buildTimeline } from '../../src/lib/astro/events.ts';
import { computeConditions, computeSolarSystem } from '../../src/lib/astro/solar.ts';
import type { ObserverSite } from '../../src/lib/astro/types.ts';

const API_VERSION = '2024-10-08';

/**
 * Reads .env without a dependency. Only KEY=value lines, which is all the file
 * is documented to contain.
 */
function loadEnvFile(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, '');
    if (value && !process.env[match[1]]) process.env[match[1]] = value;
  }
}

/**
 * Explains a `container_not_found`.
 *
 * watsonx says only "failed to find project_id", which is the same message for
 * a mistyped ID, a project belonging to a different IBM Cloud account, and a
 * project that exists in another region. Those need three different fixes, so
 * ask the Cloud Pak for Data projects API, which is global, what this token can
 * actually see. If the project is in that list the ID is right and the region
 * is wrong; if it is not, the key and the project belong to different accounts.
 */
async function diagnoseProject(token: string, projectId: string) {
  const res = await fetch('https://api.dataplatform.cloud.ibm.com/v2/projects?limit=100', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.log(`\n      (could not list projects for this key: ${res.status})`);
    return;
  }

  const json = (await res.json()) as {
    resources?: { metadata?: { guid?: string }; entity?: { name?: string; storage?: unknown } }[];
  };
  const projects = json.resources ?? [];

  console.log(`\n      This API key can see ${projects.length} project(s):`);
  for (const p of projects) {
    const guid = p.metadata?.guid ?? '?';
    const mark = guid === projectId ? '  <- the one in .env' : '';
    console.log(`        ${guid}  ${p.entity?.name ?? '(unnamed)'}${mark}`);
  }

  if (projects.some((p) => p.metadata?.guid === projectId)) {
    console.log('\n      The ID is right and the key is on the correct account, so the region is');
    console.log('      wrong: this project lives somewhere other than the endpoint above. Set');
    console.log('      WATSONX_URL to its region. The "url" field of the watsonx.ai Runtime');
    console.log('      service credential names it.');
  } else if (projects.length) {
    console.log('\n      The ID in .env is not among them. Either it is a different project, or');
    console.log('      it is a deployment space ID rather than a project ID. Copy the right one');
    console.log('      from the list above.');
  } else {
    console.log('\n      This key sees no projects at all, so it belongs to a different IBM Cloud');
    console.log('      account than the project does. Switch accounts, top right, and make a key');
    console.log('      there.');
  }
}

/**
 * The whole check lives in a function so that a failure can return an exit code
 * rather than call process.exit. Killing the process while fetch still holds a
 * keep-alive socket trips a libuv assertion on Windows, which buries the actual
 * error message under a crash that has nothing to do with it.
 */
async function main(): Promise<number> {
  loadEnvFile(fileURLToPath(new URL('../../.env', import.meta.url)));

  const apiKey = process.env.WATSONX_API_KEY;
  const projectId = process.env.WATSONX_PROJECT_ID;
  const base = (process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com').replace(/\/+$/, '');

  if (!apiKey || !projectId) {
    console.log('SKIP  no watsonx credentials found.');
    console.log('      Put WATSONX_API_KEY and WATSONX_PROJECT_ID in .env, then run this again.');
    console.log('      Without them the app still works; it narrates with the built-in narrator.');
    return 0;
  }

  // --- 1. credentials -------------------------------------------------------

  console.log(`endpoint  ${base}`);
  console.log(`project   ${projectId.slice(0, 8)}...`);
  console.log(`key       ${apiKey.length} chars, starts ${apiKey.slice(0, 4)}...`);

  /*
   * Two mistakes are worth catching before spending a round trip on them,
   * because IAM reports both as simply "could not be found" and that phrasing
   * sends people to check the wrong things.
   */
  if (/^ApiKey-/i.test(apiKey) || /^[0-9a-f-]{36}$/i.test(apiKey)) {
    console.log('\nFAIL  that looks like the API key’s ID, not the key itself.');
    console.log('      The ID is the short reference shown in the key list; the key is the long');
    console.log('      random string revealed once when it is created and never shown again.');
    return 1;
  }
  if (apiKey.length < 30) {
    console.log(`\nFAIL  the key is only ${apiKey.length} characters. IBM Cloud API keys are longer.`);
    console.log('      Most likely the paste was cut short.');
    return 1;
  }

  const tokenRes = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
      apikey: apiKey,
    }),
  });

  if (!tokenRes.ok) {
    const detail = await tokenRes.text();
    console.log(`\nFAIL  IAM rejected the API key (${tokenRes.status}).`);
    console.log(`      ${detail.slice(0, 200)}`);
    if (detail.includes('BXNIM0415E')) {
      console.log('\n      "could not be found" means IAM has no such key at all, so this is not');
      console.log('      a permissions problem. In order of likelihood:');
      console.log('        1. The key belongs to a different IBM Cloud account than the one the');
      console.log('           watsonx project is in. Check the account switcher, top right.');
      console.log('        2. The paste is incomplete or has a stray character.');
      console.log('        3. The key was deleted.');
      console.log('      The quickest fix is a fresh key from cloud.ibm.com/iam/apikeys while the');
      console.log('      correct account is selected. Service credentials on the watsonx.ai');
      console.log('      Runtime instance carry an "apikey" field that works here too.');
    }
    return 1;
  }
  const token = ((await tokenRes.json()) as { access_token: string }).access_token;
  console.log('token     ok');

  // --- 2. which Granite models this deployment can actually call ------------

  const specsRes = await fetch(
    `${base}/ml/v1/foundation_model_specs?version=${API_VERSION}&limit=200`,
    { headers: { Accept: 'application/json', Authorization: `Bearer ${token}` } },
  );

  let available: string[] = [];
  if (specsRes.ok) {
    const specs = (await specsRes.json()) as {
      resources?: { model_id?: string; functions?: { id?: string }[] }[];
    };

    /*
     * "Granite" is a family, not a chat model. The same listing carries text
     * embedding models, the Guardian safety classifiers and the TTM time series
     * models, none of which will answer a chat request, and base models, which
     * will answer one badly because they were never instruction tuned. Trust
     * the declared functions where the listing provides them, and fall back to
     * reading the name where it does not.
     */
    const NOT_CHAT = /embedding|guardian|ttm|rerank|vision|-base$/;

    available = (specs.resources ?? [])
      .filter((r) => {
        const id = r.model_id ?? '';
        if (!id.startsWith('ibm/granite')) return false;
        const functions = r.functions?.map((f) => f.id ?? '') ?? [];
        if (functions.length) return functions.includes('text_chat');
        return !NOT_CHAT.test(id);
      })
      .map((r) => r.model_id ?? '');

    console.log(`granite   ${available.length} chat model(s) offered in this region`);
    for (const id of available) console.log(`            ${id}`);
  } else {
    // Not fatal. Some plans decline this listing but still serve chat.
    console.log(`granite   could not list models (${specsRes.status}); trying chat anyway`);
  }

  // --- 3. one real, grounded request ---------------------------------------

  const site: ObserverSite = {
    latitude: 51.4779,
    longitude: -0.0015,
    elevation: 45,
    source: 'manual',
    label: 'Royal Observatory, Greenwich',
  };

  const now = new Date();
  const solar = computeSolarSystem(now, site);
  const conditions = computeConditions(now, site);
  const bodies = [solar.sun, solar.moon, ...solar.planets];
  const timeline = buildTimeline(now, site, null, 'satellites not fetched in this check', 12);

  const skyContext = buildSkyContext({ now, site, bodies, conditions, timeline });

  console.log(`\ncontext   ${now.toISOString()} at ${site.label}`);
  console.log(
    `          sun ${skyContext.conditions.sunAltitudeDegrees}deg, ${skyContext.conditions.darkness}`,
  );
  console.log(
    `          ${skyContext.visibleNow.length} visible, ${skyContext.aboveHorizonButHardToSee.length} marginal, ` +
      `${skyContext.comingUp.length} coming up`,
  );

  const modelId = process.env.WATSONX_MODEL_ID || available[0] || 'ibm/granite-3-3-8b-instruct';
  console.log(`model     ${modelId}`);

  const started = Date.now();
  const chatRes = await fetch(`${base}/ml/v1/text/chat?version=${API_VERSION}`, {
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
        {
          role: 'system',
          content:
            'You are a sky guide. The JSON you are given is the only authoritative description of ' +
            'this observer’s sky. Never state a position, time, distance or brightness that is ' +
            'not in it. If the JSON does not answer the question, say so rather than guess.',
        },
        {
          role: 'user',
          content: [
            'COMPUTED SKY DATA (the only source of truth):',
            '```json',
            JSON.stringify(skyContext),
            '```',
            '',
            'Three or four sentences for an interested adult beginner.',
            '',
            'The person watching the sky asks: "What should I look at first, and where?"',
          ].join('\n'),
        },
      ],
      max_tokens: 340,
      temperature: 0.4,
      time_limit: 20_000,
    }),
  });

  const elapsed = Date.now() - started;

  if (!chatRes.ok) {
    const detail = await chatRes.text();
    console.log(`\nFAIL  chat request returned ${chatRes.status} after ${elapsed} ms`);
    console.log(`      ${detail.slice(0, 500)}`);
    if (/model_not|not supported|model_no_access/i.test(detail)) {
      console.log('      That model is not offered here. Set WATSONX_MODEL_ID to one listed above.');
    }
    if (detail.includes('container_not_found')) await diagnoseProject(token, projectId);
    return 1;
  }

  const answer = (
    (await chatRes.json()) as { choices?: { message?: { content?: string } }[] }
  ).choices?.[0]?.message?.content?.trim();

  if (!answer) {
    console.log(`\nFAIL  Granite returned an empty completion after ${elapsed} ms.`);
    return 1;
  }

  console.log(`\nGranite answered in ${elapsed} ms:\n`);
  console.log(answer.replace(/^/gm, '  '));
  console.log('\nPASS  the narration path works end to end.');
  return 0;
}

process.exitCode = await main();
