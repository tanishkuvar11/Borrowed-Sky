#!/usr/bin/env node
/**
 * Integration pass over the interactive parts of the app: tapping an object in
 * the sky, reading its panel, asking the guide to explain it, logging it to the
 * journal, and confirming the journal chart picks it up.
 *
 * Run against `npm run dev`: node scripts/verify/interact.mjs
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = 'scripts/verify/shots';
const PORT = 9334;
const SITE = { latitude: -26.2041, longitude: 28.0473, elevation: 1753, source: 'gps' };

const profile = join(tmpdir(), `bs-chrome-i-${Date.now()}`);
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

const failures = [];
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
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
      const r = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
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

    const tap = async (x, y) => {
      for (const type of ['mousePressed', 'mouseReleased']) {
        await call('Input.dispatchMouseEvent', {
          type,
          x,
          y,
          button: 'left',
          clickCount: 1,
          pointerType: 'mouse',
        });
      }
      await sleep(600);
    };

    await call('Page.navigate', { url: APP });
    await sleep(1500);
    await evalPage(`localStorage.setItem('borrowed-sky:site', ${JSON.stringify(JSON.stringify(SITE))});
                    localStorage.removeItem('borrowed-sky:journal')`);
    await call('Page.reload');

    /*
     * Wait for the canvas to publish tap targets rather than sleeping a fixed
     * six seconds and hoping.
     *
     * The targets only exist after the star catalogue has loaded and the first
     * frame has drawn, and how long that takes depends on what else the machine
     * is doing: this suite runs several headless browsers in sequence, and the
     * first run after a source change also pays for Vite transforming the
     * module graph. A guessed sleep is right on an idle machine and wrong
     * exactly when it is busy, which is how this passed alone and failed in the
     * suite. Waiting costs nothing when the page is quick.
     */
    const hasTargets = async (timeout = 45000) => {
      const until = Date.now() + timeout;
      while (Date.now() < until) {
        const count = await evalPage(
          `(document.querySelector('canvas')?.__targets || []).length`,
        );
        if (count > 0) return true;
        await sleep(250);
      }
      return false;
    };
    // Let the navigation actually begin before polling. Without this the first
    // poll can land on the outgoing document, find its targets, and return
    // immediately, after which the reload tears that page down and the very
    // next evaluation has no canvas to query.
    await sleep(1500);
    await hasTargets();

    console.log('\ntap to identify:');

    // Aim at a real marker using the tap targets the canvas publishes in dev.
    const target = await evalPage(`
      (() => {
        const c = document.querySelector('canvas');
        const r = c.getBoundingClientRect();
        const targets = (c.__targets || []).filter(
          t => t.x > 20 && t.x < r.width - 20 && t.y > 60 && t.y < r.height - 160,
        );
        // Prefer a planet or the Moon over the Sun, which is what a user would tap.
        const pick = targets.find(t => t.id !== 'sun' && !t.id.startsWith('star-')) || targets[0];
        return pick ? JSON.stringify({ id: pick.id, x: r.left + pick.x, y: r.top + pick.y, count: targets.length }) : null;
      })()
    `);
    check('canvas published tap targets', !!target, target ?? 'none found');
    if (!target) throw new Error('no tap targets to exercise');

    const pick = JSON.parse(target);
    console.log(`  tapping ${pick.id} at (${pick.x.toFixed(0)}, ${pick.y.toFixed(0)}) of ${pick.count} targets`);
    await tap(pick.x, pick.y);

    const sheet = await evalPage(`
      (() => {
        const s = document.querySelector('.sheet');
        if (!s) return null;
        return JSON.stringify({
          name: s.querySelector('.sheet__name')?.textContent,
          where: s.querySelector('.sheet__where')?.textContent,
          readings: [...s.querySelectorAll('.reading')].map(r => r.textContent.trim()),
        });
      })()
    `);
    check('object panel opened', !!sheet);
    if (sheet) console.log(`  ${sheet}`);
    await shot('05-object');

    console.log('\nask the guide to explain it:');
    await evalPage(
      `[...document.querySelectorAll('.sheet .button')].find(b => /tell me about/i.test(b.textContent))?.click()`,
    );
    await sleep(2500);
    const narration = await evalPage(`
      (() => {
        const t = document.querySelector('.sheet__narration')?.textContent;
        const p = document.querySelector('.sheet__guide .provenance')?.textContent;
        return t ? JSON.stringify({ text: t, provenance: p }) : null;
      })()
    `);
    check('explanation rendered', !!narration);
    if (narration) console.log(`  ${narration}`);
    await shot('06-explained');

    console.log('\nadd to journal:');
    await evalPage(
      `[...document.querySelectorAll('.sheet .button')].find(b => /add to journal/i.test(b.textContent))?.click()`,
    );
    await sleep(900);
    const logged = await evalPage(`
      JSON.stringify({
        stored: JSON.parse(localStorage.getItem('borrowed-sky:journal') || '[]').length,
        toast: document.querySelector('.toast')?.textContent ?? null,
      })
    `);
    check('journal entry stored', JSON.parse(logged).stored === 1, logged);

    await evalPage(
      `[...document.querySelectorAll('.rail__item')].find(b => b.textContent.trim().startsWith('Logbook'))?.click()`,
    );
    await sleep(900);
    const chart = await evalPage(`
      JSON.stringify({
        marks: document.querySelectorAll('.planisphere g').length,
        stats: [...document.querySelectorAll('.stats__value')].map(s => s.textContent),
        title: document.querySelector('.view__title')?.textContent,
      })
    `);
    check('journal chart plotted the sighting', JSON.parse(chart).marks === 1, chart);
    await shot('07-journal-filled');

    console.log('\nask a question in the guide:');
    await evalPage(
      `[...document.querySelectorAll('.rail__item')].find(b => b.textContent.trim().startsWith('Explore'))?.click()`,
    );
    await sleep(700);
    await evalPage(`document.querySelectorAll('.chat__suggestions .pill')[0]?.click()`);
    await sleep(2500);
    const chat = await evalPage(`
      JSON.stringify([...document.querySelectorAll('.bubble')].map(b => b.textContent.trim().slice(0, 220)))
    `);
    const bubbles = JSON.parse(chat);
    check('guide answered', bubbles.length >= 2, `${bubbles.length} bubbles`);
    for (const b of bubbles) console.log(`  · ${b}`);
    await shot('08-guide-answer');

    const errors = await evalPage(`JSON.stringify(window.__pageErrors || [])`);
    console.log(`\npage errors: ${errors}`);

    browser.close();
  } finally {
    chrome.kill();
    await sleep(400);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log(failures.length ? `\nFAIL (${failures.join(', ')})` : '\nPASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((err) => {
  console.error('interaction run failed:', err.message);
  process.exit(1);
});
