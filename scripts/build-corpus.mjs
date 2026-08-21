#!/usr/bin/env node
/**
 * Builds the explanation corpus: the only prose in this app the guide is
 * allowed to teach from.
 *
 * WHY THERE IS ONE
 *
 * Everything above the horizon is computed, and the guard makes sure the model
 * never states a position it was not given. That covers where things are. It
 * does not cover what they are, and the people this app is for ask both:
 * "why is Mars red", "what does magnitude mean", "why does the Moon change
 * shape". Until now the model answered those from memory, which is exactly the
 * thing the rest of the project refuses to do. A recalled fact is unverifiable
 * and usually right, and "usually right" is the standard this app exists to
 * beat.
 *
 * So the explanations come from somewhere too. NASA publishes its science
 * writing in the public domain; this fetches it, cuts it into passages, records
 * the page and the date each one came from, and embeds it so the guide can find
 * the passage that answers a question. What the guide says about what a thing
 * is now has a citation, the same way what it says about where a thing is has
 * an ephemeris.
 *
 * WHY THE EMBEDDING MODEL IS RECORDED
 *
 * A vector only means anything next to vectors from the same model. Corpus
 * built with one embedder and questions embedded with another produces
 * confident nonsense: the arithmetic works, the nearest neighbours are noise,
 * and nothing anywhere reports a problem. So the model that built the file is
 * written into it, and the reader refuses to use a corpus it cannot match
 * rather than retrieving garbage.
 *
 * Run: node scripts/build-corpus.mjs
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'public/data/corpus.json';
const PORT = 9371;
const UA = 'BorrowedSky/1.0 (https://github.com/tanishkuvar11/Borrowed-Sky; build script)';

/**
 * Where the explanations come from.
 *
 * NASA only, and deliberately. Its science writing is public domain, which
 * means a passage can be quoted in an app without dragging a licence condition
 * along with it, and it is written for exactly this audience. Wikipedia is
 * better on breadth and is share-alike, which would put a condition on this
 * repository that nobody reading the code would ever discover.
 *
 * The topic is what the passage is filed under, not what it is about; the text
 * decides that. It exists so a lookup can be narrowed when the question names
 * an object the app already knows.
 */
const SOURCES = [
  { topic: 'Sun', url: 'https://science.nasa.gov/sun/facts/' },
  { topic: 'Moon', url: 'https://science.nasa.gov/moon/facts/' },
  { topic: 'Moon', url: 'https://science.nasa.gov/moon/lunar-phases-and-eclipses/' },
  { topic: 'Mercury', url: 'https://science.nasa.gov/mercury/facts/' },
  { topic: 'Venus', url: 'https://science.nasa.gov/venus/venus-facts/' },
  { topic: 'Mars', url: 'https://science.nasa.gov/mars/facts/' },
  { topic: 'Jupiter', url: 'https://science.nasa.gov/jupiter/jupiter-facts/' },
  { topic: 'Saturn', url: 'https://science.nasa.gov/saturn/facts/' },
  { topic: 'Uranus', url: 'https://science.nasa.gov/uranus/facts/' },
  { topic: 'Neptune', url: 'https://science.nasa.gov/neptune/neptune-facts/' },
  { topic: 'stars', url: 'https://science.nasa.gov/universe/stars/' },
  { topic: 'Milky Way', url: 'https://science.nasa.gov/universe/galaxies/' },
  { topic: 'space station', url: 'https://www.nasa.gov/international-space-station/' },
];

/** Passages this long read as an answer. Much shorter and they lose their subject. */
const TARGET_CHARS = 700;
const MIN_CHARS = 220;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
function rpc(socket, method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      socket.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

/**
 * The article, without the site around it.
 *
 * Paragraphs are taken by length rather than by hunting for a content wrapper,
 * because the wrapper's class name is a thing NASA can change on a Tuesday and
 * the length of a sentence is not. Navigation is hundreds of short links; prose
 * is a few dozen long paragraphs. A floor of 120 characters separates them
 * cleanly and keeps working when the markup moves.
 */
function extractScript() {
  return `(() => {
    const drop = ['nav', 'header', 'footer', 'aside'];
    const paragraphs = [...document.querySelectorAll('p')]
      .filter((p) => !drop.some((tag) => p.closest(tag)))
      .map((p) => p.innerText.replace(/\\s+/g, ' ').trim())
      .filter((t) => t.length >= 120);
    return JSON.stringify({
      title: document.title.replace(/\\s*[-|].*$/, '').trim(),
      paragraphs,
    });
  })()`;
}

/** Groups paragraphs into passages that are big enough to answer something. */
function toPassages(paragraphs) {
  const passages = [];
  let buffer = '';
  for (const paragraph of paragraphs) {
    buffer = buffer ? `${buffer} ${paragraph}` : paragraph;
    if (buffer.length >= TARGET_CHARS) {
      passages.push(buffer);
      buffer = '';
    }
  }
  if (buffer.length >= MIN_CHARS) passages.push(buffer);
  return passages;
}

// ---------------------------------------------------------------------------
// embedding
// ---------------------------------------------------------------------------

/**
 * Whichever embedder is available, named in the output so the reader can check.
 *
 * watsonx is the one that ships. Ollama is here for the same reason it is in
 * the ask endpoint: so this can be built and tested without a hosted quota,
 * and the corpus it produces still works, as long as questions are embedded by
 * the same model that built it. The name written into the file is what makes
 * that checkable instead of assumed.
 */
async function makeEmbedder() {
  const apiKey = process.env.WATSONX_API_KEY;
  const projectId = process.env.WATSONX_PROJECT_ID;

  if (apiKey && projectId) {
    const base = (process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com').replace(/\/+$/, '');
    const model = process.env.WATSONX_EMBED_MODEL || 'ibm/slate-125m-english-rtrvr';

    const tokenRes = await fetch('https://iam.cloud.ibm.com/identity/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ibm:params:oauth:grant-type:apikey',
        apikey: apiKey,
      }),
    });

    if (tokenRes.ok) {
      const { access_token: token } = await tokenRes.json();
      return {
        name: `watsonx:${model}`,
        async embed(texts) {
          const res = await fetch(`${base}/ml/v1/text/embeddings?version=2024-10-08`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ model_id: model, project_id: projectId, inputs: texts }),
          });
          if (!res.ok) throw new Error(`watsonx embeddings responded ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const json = await res.json();
          return json.results.map((r) => r.embedding);
        },
      };
    }
    console.log('  watsonx credentials did not mint a token; falling back to a local embedder');
  }

  /*
   * IBM's own embedding model, which keeps the local path honest: the corpus a
   * developer builds is embedded by a Granite model, the same family as the one
   * that will read it. It is also thirty million parameters and sixty
   * megabytes, so it costs nothing to have around.
   */
  const ollama = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const model = process.env.OLLAMA_EMBED_MODEL || 'granite-embedding:30m';
  const probe = await fetch(`${ollama}/api/tags`).catch(() => null);
  if (!probe?.ok) {
    throw new Error(
      'No embedder available. Set watsonx credentials, or: ollama pull granite-embedding:30m',
    );
  }

  return {
    name: `ollama:${model}`,
    async embed(texts) {
      const res = await fetch(`${ollama}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`ollama embeddings responded ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`ollama embeddings: ${json.error}`);
      return json.embeddings;
    },
  };
}

/** Unit length, so similarity is a dot product and the reader needs no norms. */
function normalise(vector) {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const length = Math.sqrt(sum) || 1;
  return vector.map((v) => Math.round((v / length) * 10000) / 10000);
}

async function main() {
  console.log('choosing an embedder…');
  const embedder = await makeEmbedder();
  console.log(`  ${embedder.name}`);

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${join(tmpdir(), `bs-corpus-${Date.now()}`)}`,
      '--window-size=1280,900',
      '--no-first-run',
      '--disable-gpu',
      `--user-agent=${UA}`,
    ],
    { stdio: 'ignore' },
  );

  const documents = [];

  try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        wsUrl = (await res.json()).webSocketDebuggerUrl;
      } catch {
        /* not up yet */
      }
    }
    if (!wsUrl) throw new Error('Chrome did not expose a debugging endpoint');

    const browser = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      browser.addEventListener('open', resolve, { once: true });
      browser.addEventListener('error', () => reject(new Error('browser socket failed')), {
        once: true,
      });
    });

    const { targetId } = await rpc(browser, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await rpc(browser, 'Target.attachToTarget', { targetId, flatten: true });
    const call = (m, p) => rpc(browser, m, p, sessionId);
    await call('Page.enable');
    await call('Runtime.enable');

    console.log('\nreading NASA…');
    for (const source of SOURCES) {
      await call('Page.navigate', { url: source.url });
      await sleep(2500);

      const { result, exceptionDetails } = await call('Runtime.evaluate', {
        expression: extractScript(),
        returnByValue: true,
      });
      if (exceptionDetails) {
        console.log(`  ${source.topic.padEnd(14)} FAILED to read`);
        continue;
      }

      const { title, paragraphs } = JSON.parse(result.value);
      const passages = toPassages(paragraphs);
      console.log(
        `  ${source.topic.padEnd(14)} ${String(paragraphs.length).padStart(3)} paragraphs -> ${passages.length} passages`,
      );

      for (const text of passages) {
        documents.push({
          topic: source.topic,
          title: title || source.topic,
          source: source.url,
          text,
        });
      }
    }

    browser.close();
  } finally {
    chrome.kill();
  }

  if (!documents.length) throw new Error('nothing was extracted; refusing to write an empty corpus');

  console.log(`\nembedding ${documents.length} passages…`);
  const vectors = [];
  const BATCH = 16;
  for (let i = 0; i < documents.length; i += BATCH) {
    const slice = documents.slice(i, i + BATCH).map((d) => d.text);
    const embedded = await embedder.embed(slice);
    for (const vector of embedded) vectors.push(normalise(vector));
    process.stdout.write(`\r  ${Math.min(i + BATCH, documents.length)}/${documents.length}`);
  }
  console.log('');

  const corpus = {
    embeddingModel: embedder.name,
    dimensions: vectors[0].length,
    retrievedAt: new Date().toISOString(),
    licence: 'Public domain (NASA). See each passage’s source.',
    passages: documents.map((d, i) => ({ ...d, vector: vectors[i] })),
  };

  await mkdir('public/data', { recursive: true });
  await writeFile(OUT, JSON.stringify(corpus) + '\n');

  const kb = (JSON.stringify(corpus).length / 1024).toFixed(0);
  console.log(`\nwrote ${corpus.passages.length} passages (${corpus.dimensions}d, ${kb}KB) to ${OUT}`);
}

await main();
