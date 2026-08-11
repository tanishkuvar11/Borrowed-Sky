#!/usr/bin/env node
/**
 * Captures the sky canvas at several aims, for judging the scene layers.
 *
 * The galactic band, the afterglow and the foreground terrain only exist under a
 * dark sky and only the terrain is visible when the view is aimed high, so the
 * default screenshot pass can miss all three at once. This drives the view down
 * to the horizon and shoots it deliberately.
 *
 *   SITE=14.6,121.0 node scripts/verify/scene.mjs
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = 'scripts/verify/shots';
const PORT = 9340;

const SITE = (() => {
  const raw = process.env.SITE;
  if (!raw) return { latitude: -26.2041, longitude: 28.0473, elevation: 1753, source: 'gps' };
  const [latitude, longitude, elevation = 0] = raw.split(',').map(Number);
  return { latitude, longitude, elevation, source: 'gps' };
})();

const profile = join(tmpdir(), `bs-chrome-s-${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try {
        wsUrl = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json())
          .webSocketDebuggerUrl;
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

    const { targetId } = await rpc(browser, 'Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await rpc(browser, 'Target.attachToTarget', { targetId, flatten: true });
    const call = (method, params) => rpc(browser, method, params, sessionId);

    await call('Page.enable');
    await call('Runtime.enable');
    await call('Emulation.setDeviceMetricsOverride', {
      width: 430,
      height: 932,
      deviceScaleFactor: 2,
      mobile: true,
    });

    const evalPage = async (expression) => {
      const r = await call('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.exception?.description || 'evaluation failed');
      }
      return r.result.value;
    };

    const shot = async (name) => {
      const { data } = await call('Page.captureScreenshot', { format: 'png' });
      await writeFile(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
      console.log(`  captured ${name}.png`);
    };

    /** Drag on the canvas: negative dy aims lower, positive dx swings west. */
    const drag = async (dx, dy) => {
      const x = 215;
      const y = 500;
      await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      const steps = 12;
      for (let i = 1; i <= steps; i++) {
        await call('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: x + (dx * i) / steps,
          y: y + (dy * i) / steps,
          button: 'left',
        });
        await sleep(16);
      }
      await call('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: x + dx,
        y: y + dy,
        button: 'left',
      });
      await sleep(500);
    };

    await call('Page.navigate', { url: APP });
    await sleep(1500);
    await evalPage(
      `localStorage.setItem('borrowed-sky:site', ${JSON.stringify(JSON.stringify(SITE))})`,
    );
    await call('Page.reload');
    await sleep(6500);

    console.log(`  site ${SITE.latitude}, ${SITE.longitude}`);
    console.log(`  ${await evalPage(`document.querySelector('.sky-view__status')?.innerText.replace(/\\s+/g,' ') ?? ''`)}`);

    await shot('10-scene-high');

    // Aim down towards the horizon, where the terrain and afterglow live.
    await drag(0, -260);
    await shot('11-scene-horizon');

    // And swing round to face the Sun's bearing.
    await drag(-300, 0);
    await shot('12-scene-turned');

    const errs = await evalPage(`JSON.stringify(window.__pageErrors || [])`);
    console.log(`  page errors: ${errs}`);
  } finally {
    chrome.kill();
  }
  console.log('\ndone.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
