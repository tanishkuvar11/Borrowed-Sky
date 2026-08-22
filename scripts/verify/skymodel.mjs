/**
 * The fitted sky model, in a real browser, doing something you can see.
 *
 * Every other check drives the model through `_setModelForTesting`, which
 * proves the arithmetic and nothing about the app. Two earlier versions of this
 * feature shipped with the model fitted, the file written, the suite green and
 * the code never called once at runtime. So this one asks the only questions
 * those suites could not: does the browser fetch the model, and does the chart
 * look different because of it.
 *
 * The comparison is a controlled one, and the first draft of it was not. Two
 * different nights show two different halves of the sky, so counting stars in
 * one against the other measures the date far more than it measures the Moon;
 * that version reported the moonlit sky as the busier of the two and was right
 * to. What isolates the model is holding the instant fixed and taking the model
 * away: the same night, the same Moon in the same place, the same stars
 * overhead, with skymodel.json blocked at the network layer so the app falls
 * back to the uncorrected limit it used before any of this was fitted.
 * Whatever differs between those two frames is the model and can be nothing
 * else.
 *
 * A moonless night is captured alongside them, not as an assertion but because
 * the pair of pictures is the point of the feature.
 *
 * Run: node scripts/verify/skymodel.mjs [outdir]
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = process.argv[2] || 'scripts/verify/shots/skymodel';
const PORT = 9337;

/** Pune. A real city sky, so the light pollution term has something to say. */
const SITE = { latitude: 18.52, longitude: 73.86, elevation: 560, source: 'gps' };

/*
 * Chosen by walking the next sixty days for the extremes of the Moon term at
 * this site. Both sit well below -18 degrees, which is the only window the
 * model speaks in.
 */
const MOONLIT = 1790538051572;
const MOONLESS = 1792262451603;

const RUNS = [
  { name: 'moonlit', at: MOONLIT, model: true, note: 'Moon 82 degrees up, 98% lit' },
  { name: 'moonlit-no-model', at: MOONLIT, model: false, note: 'the same night, model blocked' },
  { name: 'moonless', at: MOONLESS, model: true, note: 'Moon below the horizon' },
];

const profile = join(tmpdir(), `bs-chrome-sm-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;

function rpc(socket, method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
      else resolve(msg.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

/**
 * A number for how much sky is lit, that moonlight itself cannot fake.
 *
 * Mean brightness is useless here: the Moon floods the background, so a moonlit
 * frame is brighter overall while showing fewer stars. This counts pixels that
 * are much brighter than their own surroundings instead, which is what a star
 * is and what a wash of moonlight is not. Sampled on a grid rather than every
 * pixel, because a few thousand samples settle this and a million is slow.
 */
const COUNT_POINTS = `(() => {
  const c = document.querySelector('canvas');
  if (!c) return null;
  const g = c.getContext('2d', { willReadFrequently: true });
  const w = c.width, h = c.height;
  const top = Math.floor(h * 0.08), bottom = Math.floor(h * 0.5);
  const img = g.getImageData(0, top, w, bottom - top).data;
  const W = w, H = bottom - top;
  const lum = (x, y) => {
    const o = (y * W + x) * 4;
    return 0.2126 * img[o] + 0.7152 * img[o + 1] + 0.0722 * img[o + 2];
  };
  let points = 0, total = 0, n = 0;
  const R = 3;
  for (let y = R; y < H - R; y += 2) {
    for (let x = R; x < W - R; x += 2) {
      const v = lum(x, y);
      total += v; n++;
      const around = (lum(x - R, y) + lum(x + R, y) + lum(x, y - R) + lum(x, y + R)) / 4;
      if (v > around + 18) points++;
    }
  }
  return { points, meanLuminance: total / n, samples: n };
})()`;

async function main() {
  await mkdir(OUT, { recursive: true });
  const failures = [];
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures.push(label);
  };

  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=430,932',
      '--hide-scrollbars',
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
        wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl;
      } catch {
        /* not up yet */
      }
    }
    if (!wsUrl) throw new Error('Chrome did not expose a debugging endpoint');

    const browser = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      browser.addEventListener('open', resolve, { once: true });
      browser.addEventListener('error', () => reject(new Error('socket failed')), { once: true });
    });

    const results = {};

    for (const moment of RUNS) {
      const { targetId } = await rpc(browser, 'Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await rpc(browser, 'Target.attachToTarget', { targetId, flatten: true });
      const page = {
        send: (d) => browser.send(d),
        addEventListener: (...a) => browser.addEventListener(...a),
        removeEventListener: (...a) => browser.removeEventListener(...a),
      };
      const call = (m, p) => rpc(page, m, p, sessionId);
      const evalPage = (expression) =>
        rpc(page, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId).then(
          (r) => {
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
            return r.result.value;
          },
        );

      await call('Page.enable');
      await call('Runtime.enable');
      await call('Network.enable');
      await call('Emulation.setDeviceMetricsOverride', {
        width: 430,
        height: 932,
        deviceScaleFactor: 2,
        mobile: true,
      });

      // Watch for the model file, so "it loaded" is observed rather than assumed.
      let modelStatus = null;
      const onMessage = (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (
          msg.method === 'Network.responseReceived' &&
          msg.params &&
          msg.params.response &&
          typeof msg.params.response.url === 'string' &&
          msg.params.response.url.includes('skymodel.json')
        ) {
          modelStatus = msg.params.response.status;
        }
      };
      browser.addEventListener('message', onMessage);

      /*
       * The control. Blocked at the network layer rather than by deleting the
       * file, so the app takes exactly the path a visitor takes when the fetch
       * fails: a silent zero correction and the limits it has always had.
       */
      if (!moment.model) {
        await call('Network.setBlockedURLs', { urls: ['*skymodel.json*'] });
      }

      /*
       * The clock, stopped, before a line of the app runs. The app rebuilds its
       * conditions every second from a fresh Date, so stubbing after load would
       * race the first paint; installed on new document it cannot.
       */
      await call('Page.addScriptToEvaluateOnNewDocument', {
        source: [
          '(() => {',
          `  const T = ${moment.at};`,
          '  const R = Date;',
          '  function F(...a) { return a.length === 0 ? new R(T) : new R(...a); }',
          '  F.prototype = R.prototype;',
          '  F.now = () => T;',
          '  F.parse = R.parse;',
          '  F.UTC = R.UTC;',
          '  window.Date = F;',
          '  try {',
          `    localStorage.setItem('borrowed-sky:site', ${JSON.stringify(JSON.stringify(SITE))});`,
          '  } catch {}',
          '})();',
        ].join('\n'),
      });

      await call('Page.navigate', { url: APP });
      await sleep(7000);

      // Past the landing page and into the instrument.
      let entered = false;
      for (let i = 0; i < 60 && !entered; i++) {
        entered = await evalPage(`!!document.querySelector('.app')`);
        if (!entered) {
          await evalPage(`document.querySelector('.overture__panel--close .button--primary')?.click()`);
          await sleep(250);
        }
      }
      if (!entered) throw new Error('never got past the landing page');
      await sleep(4000);

      /*
       * Wait for the canvas to stop resizing before measuring it.
       *
       * The backing store settles a beat after the layout does, and a capture
       * taken mid-settle comes back at a different pixel count from the run
       * before it. Two counts taken over two differently sized canvases compare
       * the viewport rather than the sky, which is how this check first
       * reported a 6.3% effect and a 2.3% one for the same pair of frames.
       */
      let stable = 0;
      let lastWidth = -1;
      for (let i = 0; i < 40 && stable < 3; i++) {
        const w = await evalPage(`document.querySelector('canvas')?.width ?? -1`);
        stable = w === lastWidth ? stable + 1 : 0;
        lastWidth = w;
        await sleep(300);
      }

      const clock = await evalPage(`new Date().toISOString()`);
      const stats = await evalPage(COUNT_POINTS);
      const { data } = await call('Page.captureScreenshot', { format: 'png' });
      const path = join(OUT, `${moment.name}.png`);
      await writeFile(path, Buffer.from(data, 'base64'));

      browser.removeEventListener('message', onMessage);
      results[moment.name] = { ...stats, modelStatus, clock, path };

      console.log(`\n${moment.name} (${moment.note})`);
      console.log(`  clock in page   ${clock}`);
      console.log(`  skymodel.json   ${modelStatus}`);
      console.log(`  bright points   ${stats && stats.points} of ${stats && stats.samples} samples`);
      console.log(`  mean luminance  ${stats && stats.meanLuminance.toFixed(2)}`);
      console.log(`  captured        ${path}`);

      await rpc(browser, 'Target.closeTarget', { targetId });
    }

    const withModel = results.moonlit;
    const without = results['moonlit-no-model'];
    const dark = results.moonless;

    console.log('\nwhat this proves');
    check(
      'the browser actually fetched the model',
      withModel.modelStatus === 200 && dark.modelStatus === 200,
      `${withModel.modelStatus} and ${dark.modelStatus}`,
    );
    check('and the control ran without it', without.modelStatus === null, `${without.modelStatus}`);
    check(
      'both frames are the same instant, so the same stars are up',
      withModel.clock === without.clock,
      withModel.clock,
    );
    check('every frame drew a sky at all', withModel.points > 0 && without.points > 0 && dark.points > 0);
    /*
     * Without this the count below is meaningless: a canvas that came back a
     * different size carries a different number of samples, and the comparison
     * measures the viewport instead of the model.
     */
    check(
      'and the two were measured over the same canvas',
      withModel.samples === without.samples,
      `${withModel.samples} and ${without.samples} samples`,
    );

    /*
     * The whole claim, in one line. Same night, same Moon, same stars overhead;
     * the only difference is whether the fitted correction was available. If
     * these two counts ever come out equal the model is loaded and ignored,
     * which is precisely how this feature failed twice before.
     */
    const removed = without.points - withModel.points;
    check(
      'the model removes stars the uncorrected limit would have drawn',
      withModel.points < without.points,
      `${withModel.points} against ${without.points}, ${removed} fewer points of light`,
    );
    check(
      'and it is a correction rather than a blackout',
      removed / without.points < 0.6,
      `${((removed / without.points) * 100).toFixed(1)}% of the field`,
    );

    console.log('\nfor the eye, not the assertion');
    /*
     * As a density rather than a count. The captures are not guaranteed to come
     * back at the same canvas size, so raw totals across two runs compare the
     * viewport as much as the sky. Nothing is asserted on this pair anyway;
     * the assertion above is the controlled one.
     */
    const density = (r) => ((r.points / r.samples) * 1000).toFixed(1);
    console.log(`  moonlit   ${density(withModel)} points per thousand samples`);
    console.log(`  moonless  ${density(dark)} points per thousand samples`);

    console.log('');
    if (failures.length) {
      console.error(`FAIL  ${failures.length} case(s): ${failures.join(', ')}`);
      process.exitCode = 1;
    } else {
      console.log('PASS  the model loads in the browser and visibly thins a moonlit sky');
    }
  } finally {
    chrome.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
