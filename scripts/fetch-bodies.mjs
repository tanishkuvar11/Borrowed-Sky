#!/usr/bin/env node
/**
 * Fetches real photographs of the solar system bodies this app can show.
 *
 * The app's whole claim is that nothing above the horizon is invented, and
 * hand-drawn planets sat awkwardly against that: a drawing of Saturn is a
 * drawing, however carefully the rings are placed. These are photographs taken
 * by spacecraft, every one of them public domain, and each one's provenance is
 * recorded next to it so the page can say where the picture came from in the
 * same breath it says where the numbers came from.
 *
 * Public domain only, deliberately. Commons has better-looking Moon and Mars
 * shots under share-alike terms, and cropping one produces a derivative work
 * that would drag the licence along with it into this repository. NASA's own
 * imagery carries no such condition.
 *
 * Run: node scripts/fetch-bodies.mjs
 *
 * Needs headless Chrome, which is already how the repo's other image work is
 * done: it means no image codec dependency is added for a script that runs
 * once and commits its output.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
  process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const OUT = 'public/bodies';
const PORT = 9361;
const UA = 'BorrowedSky/1.0 (https://github.com/tanishkuvar11/Borrowed-Sky; build script)';

/**
 * What to fetch, and how to cut it out of its frame.
 *
 * `disc` bodies are a single round planet on black: the mask is a circle found
 * by measuring the disc, which is exact and leaves a clean edge. Saturn cannot
 * be treated that way because its rings reach well outside the globe, so it is
 * cut by brightness instead — slower to tune, but it is the only one that
 * needs it.
 */
const BODIES = [
  { name: 'mercury', file: 'Mercury in color - Prockter07-edit1.jpg', cut: 'disc' },
  { name: 'venus', file: 'Venus globe.jpg', cut: 'disc' },
  { name: 'moon', file: 'Moon nearside LRO.jpg', cut: 'disc' },
  { name: 'mars', file: 'Mars Valles Marineris.jpeg', cut: 'disc' },
  { name: 'jupiter', file: 'Jupiter and its shrunken Great Red Spot.jpg', cut: 'disc' },
  { name: 'saturn', file: 'Saturn (planet) large.jpg', cut: 'luma' },
  { name: 'uranus', file: 'Uranus2.jpg', cut: 'disc' },
  { name: 'neptune', file: 'Neptune Full.jpg', cut: 'disc' },
];

/** Output size. 512 covers the largest use (124 CSS px) on a 2x screen twice over. */
const SIZE = 512;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

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

/** Ask Commons for the file's licence, author and a working image URL. */
async function describe(file) {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json&prop=imageinfo' +
    '&iiprop=url|size|extmetadata&iiurlwidth=1024&titles=' +
    encodeURIComponent('File:' + file);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Commons API returned ${res.status} for ${file}`);
  const page = Object.values((await res.json()).query.pages)[0];
  const info = page?.imageinfo?.[0];
  if (!info) throw new Error(`Commons has no file named ${file}`);

  const meta = info.extmetadata || {};
  const licence = strip(meta.LicenseShortName?.value);

  /*
   * Refuse anything that is not public domain rather than quietly shipping it.
   * A share-alike image would put a condition on this repository that nobody
   * reading the code would ever discover, and the failure mode of guessing
   * wrong here is a licence violation rather than a broken picture.
   */
  if (!/public domain/i.test(licence)) {
    throw new Error(`${file} is licensed "${licence}", not public domain`);
  }

  return {
    url: info.thumburl || info.url,
    page: info.descriptionurl,
    author: strip(meta.Artist?.value),
    credit: strip(meta.Credit?.value),
    licence,
  };
}

/**
 * The masking, done in a page so canvas does the decoding.
 *
 * Two cuts. `disc` measures the planet: it walks in from each edge to find
 * where the black stops, takes the centre and radius from that, and applies a
 * circular alpha with a two-pixel feather — exact, and it leaves no halo of
 * background pixels around the limb. `luma` is for Saturn, whose rings extend
 * past the globe: alpha comes from brightness, which keeps the ring system and
 * drops the sky, at the cost of thinning the darkest part of the rings.
 */
function maskScript(dataUrl, cut, size) {
  return `(async () => {
    const img = new Image();
    img.src = ${JSON.stringify(dataUrl)};
    await img.decode();

    const W = img.naturalWidth, H = img.naturalHeight;
    const src = document.createElement('canvas');
    src.width = W; src.height = H;
    const s = src.getContext('2d');
    s.drawImage(img, 0, 0);
    const d = s.getImageData(0, 0, W, H);
    const px = d.data;

    const lum = (o) => (px[o] * 0.299 + px[o + 1] * 0.587 + px[o + 2] * 0.114) / 255;

    let box;
    if (${JSON.stringify(cut)} === 'disc') {
      // Where the subject actually is: the extremes of everything above the
      // background. Taken from all four sides so an off-centre crop is found
      // rather than assumed.
      let minX = W, maxX = -1, minY = H, maxY = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (lum((y * W + x) * 4) > 0.08) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
      const r = Math.max(maxX - minX, maxY - minY) / 2;
      box = { cx, cy, r };

      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          const dist = Math.hypot(x - cx, y - cy);
          // Two pixels of feather at the limb: a hard cut on a round edge
          // stair-steps, and a wide one makes the planet look out of focus.
          px[o + 3] = Math.round(255 * Math.max(0, Math.min(1, (r - dist) / 2 + 1)));
        }
      }
    } else {
      let minX = W, maxX = -1, minY = H, maxY = -1;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          const l = lum(o);
          // Ramped rather than thresholded, so the faint outer ring fades out
          // instead of ending on a visible contour line.
          px[o + 3] = Math.round(255 * Math.max(0, Math.min(1, (l - 0.04) / 0.1)));
          if (l > 0.06) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      box = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, r: Math.max(maxX - minX, maxY - minY) / 2 };
    }

    s.putImageData(d, 0, 0);

    // Square, centred on the subject, with a little air so the feathered edge
    // is never clipped by the frame.
    const out = document.createElement('canvas');
    out.width = ${size}; out.height = ${size};
    const g = out.getContext('2d');
    g.imageSmoothingQuality = 'high';
    const span = box.r * 2.08;
    g.drawImage(src, box.cx - span / 2, box.cy - span / 2, span, span, 0, 0, ${size}, ${size});

    return JSON.stringify({ png: out.toDataURL('image/png'), source: W + 'x' + H });
  })()`;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  console.log('asking Commons about each file…');
  const described = [];
  for (const body of BODIES) {
    const info = await describe(body.file);
    console.log(`  ${body.name.padEnd(8)} ${info.licence.padEnd(14)} ${info.author.slice(0, 44)}`);
    described.push({ ...body, ...info });
  }

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${join(tmpdir(), `bs-bodies-${Date.now()}`)}`,
      '--window-size=600,400',
      '--no-first-run',
      '--disable-gpu',
    ],
    { stdio: 'ignore' },
  );

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
    await call('Runtime.enable');

    const credits = [];
    console.log('\ndownloading and cutting out…');

    for (const body of described) {
      const res = await fetch(body.url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`${body.name}: image fetch returned ${res.status}`);
      const bytes = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || 'image/jpeg';
      const dataUrl = `data:${type};base64,${bytes.toString('base64')}`;

      const { result, exceptionDetails } = await call('Runtime.evaluate', {
        expression: maskScript(dataUrl, body.cut, SIZE),
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(`${body.name}: ${exceptionDetails.exception?.description ?? 'mask failed'}`);
      }

      const out = JSON.parse(result.value);
      const png = Buffer.from(out.png.split(',')[1], 'base64');
      await writeFile(join(OUT, `${body.name}.png`), png);
      console.log(
        `  ${body.name.padEnd(8)} ${out.source.padEnd(11)} -> ${SIZE}x${SIZE}  ${(png.length / 1024).toFixed(0)}KB`,
      );

      credits.push({
        body: body.name,
        file: body.file,
        source: body.page,
        author: body.author,
        credit: body.credit,
        licence: body.licence,
      });
    }

    /*
     * Written next to the images rather than only into the README, because the
     * page shows the credit and needs to read it from somewhere that cannot
     * drift out of step with the files themselves.
     */
    await writeFile(join(OUT, 'credits.json'), JSON.stringify(credits, null, 2) + '\n');
    console.log(`\nwrote ${credits.length} images and credits.json into ${OUT}`);
  } finally {
    chrome.kill();
  }
}

await main();
