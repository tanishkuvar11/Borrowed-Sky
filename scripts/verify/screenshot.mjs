#!/usr/bin/env node
/**
 * Drives headless Chrome over the DevTools protocol to capture the running app.
 *
 * Uses Node's built-in WebSocket, so it adds no dependencies. Seeds a location
 * into localStorage first, because the app deliberately refuses to show a sky
 * until it knows where the observer is standing.
 *
 * Usage: node scripts/verify/screenshot.mjs [outDir]
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = process.argv[2] || 'scripts/verify/shots';
const PORT = 9333;

/**
 * Johannesburg by default: a southern-hemisphere city, so the screenshots also
 * prove the app is not quietly assuming a northern sky. Override to shoot the
 * night side of the planet:
 * most of the scene (the galactic band, the afterglow, the terrain) only exists
 * once the Sun is down, so a daytime capture proves nothing about it.
 *
 *   SITE=14.6,121.0,16 node scripts/verify/screenshot.mjs
 */
const SITE = (() => {
  const raw = process.env.SITE;
  if (!raw) return { latitude: -26.2041, longitude: 28.0473, elevation: 1753, source: 'gps' };
  const [latitude, longitude, elevation = 0] = raw.split(',').map(Number);
  return { latitude, longitude, elevation, source: 'gps' };
})();

const profile = join(tmpdir(), `bs-chrome-${Date.now()}`);
let nextId = 1;

function rpc(socket, method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 30_000);
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(socket, expression) {
  const result = await rpc(socket, 'Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || 'evaluation failed');
  }
  return result.result.value;
}

async function shoot(socket, name) {
  const { data } = await rpc(socket, 'Page.captureScreenshot', { format: 'png' });
  const path = join(OUT, `${name}.png`);
  await writeFile(path, Buffer.from(data, 'base64'));
  console.log(`  captured ${path}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

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
      '--force-device-scale-factor=2',
    ],
    { stdio: 'ignore' },
  );

  try {
    // Wait for the debugging endpoint to come up.
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
      browser.addEventListener('error', () => reject(new Error('browser socket failed')), { once: true });
    });

    const { targetId } = await rpc(browser, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await rpc(browser, 'Target.attachToTarget', { targetId, flatten: true });

    // Wrap the socket so every call carries the session id.
    const page = {
      send: (data) => browser.send(data),
      addEventListener: (...args) => browser.addEventListener(...args),
      removeEventListener: (...args) => browser.removeEventListener(...args),
    };
    const call = (method, params) => rpc(page, method, params, sessionId);

    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 2,
      mobile: true,
    });

    // Land on the origin so localStorage is writable, seed the site, reload.
    await call('Page.navigate', { url: APP });
    await sleep(1500);
    await rpc(page, 'Runtime.evaluate', {
      expression: `localStorage.setItem('borrowed-sky:site', ${JSON.stringify(JSON.stringify(SITE))})`,
      returnByValue: true,
    }, sessionId);

    await call('Page.reload');
    console.log('waiting for the star catalogue and first frames…');
    await sleep(6000);

    const evalPage = (expr) =>
      rpc(page, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId)
        .then((r) => {
          if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
          return r.result.value;
        });

    const shotPage = async (name) => {
      const { data } = await call('Page.captureScreenshot', { format: 'png' });
      const path = join(OUT, `${name}.png`);
      await writeFile(path, Buffer.from(data, 'base64'));
      console.log(`  captured ${path}`);
    };

    // Report anything the page logged as an error before we judge the pixels.
    const errors = await evalPage(`JSON.stringify(window.__errors || [])`);
    console.log(`page errors: ${errors}`);

    const report = await evalPage(`
      JSON.stringify({
        rootChildren: document.getElementById('root').childElementCount,
        hasCanvas: !!document.querySelector('canvas'),
        railButtons: [...document.querySelectorAll('.rail__item')].map(b => b.textContent.trim()),
        aim: document.querySelector('.aim-note')?.textContent ?? null,
        plaque: document.querySelector('.guide-panel__text')?.textContent?.slice(0, 60) ?? null,
        loading: document.querySelector('.sky-view__loading-text')?.textContent ?? null,
      })
    `);
    console.log(`page state: ${report}`);

    await shotPage('01-sky');

    const clickRail = async (label) => {
      await evalPage(
        `[...document.querySelectorAll('.rail__item')].find(b => b.textContent.trim().startsWith(${JSON.stringify(label)}))?.click()`,
      );
      await sleep(1200);
    };

    await clickRail('Tonight');
    await shotPage('02-tonight');

    await clickRail('Explore');
    await shotPage('03-guide');

    await clickRail('Logbook');
    await shotPage('04-journal');

    // Night-vision mode, back on the sky where it matters most. It lives in the
    // settings sheet behind the header's left-hand rose.
    await clickRail('Sky');
    const toggleNightVision = async () => {
      await evalPage(`document.querySelector('.rose--plain')?.click()`);
      await sleep(400);
      await evalPage(
        `[...document.querySelectorAll('.pill')].find(b => /red display/i.test(b.textContent))?.click()`,
      );
      await sleep(300);
      await evalPage(`document.querySelector('.dialog__close')?.click()`);
      await sleep(500);
    };

    await toggleNightVision();
    await shotPage('09-night-vision');
    await toggleNightVision();

    // And the opening gate, with the stored location cleared.
    await evalPage(`localStorage.removeItem('borrowed-sky:site')`);
    await call('Page.reload');
    await sleep(2500);
    await shotPage('00-gate');

    browser.close();
    console.log('\ndone.');
  } finally {
    chrome.kill();
    await sleep(400);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }
}

void shoot;
void evaluate;

main().catch((err) => {
  console.error('screenshot run failed:', err.message);
  process.exit(1);
});
