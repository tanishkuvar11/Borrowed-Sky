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


/**
 * Clicks through the landing page to the app.
 *
 * A seeded site no longer skips the overture; it only changes what the closing
 * plate offers, from the question to the way in. Retried rather than clicked
 * once, because the plate is on the page before the star catalogue has arrived
 * and this runs against whatever else the machine happens to be doing.
 */
function enterAppWith(evalPage, sleep) {
  return async () => {
    for (let i = 0; i < 60; i++) {
      if (await evalPage(`!!document.querySelector('.app')`)) return;
      await evalPage(
        `document.querySelector('.overture__panel--close .button--primary')?.click()`,
      );
      await sleep(250);
    }
    throw new Error('never got past the landing page');
  };
}

/**
 * Polls until something is there, or gives up.
 *
 * Returns whatever the probe returned, or null on the timeout, so the caller
 * still gets to decide whether absence is a failure.
 */
async function until(probe, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await probe();
    if (found) return found;
    await sleep(500);
  }
  return null;
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

    // Past the landing page, which every visit now opens on.
    const enterApp = enterAppWith(evalPage, sleep);
    await enterApp();

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

    /*
     * The fun fact, and the button that asks for the next one.
     *
     * The line under the fact used to read "tap the Moon again for another",
     * which was not true: the sheet is already open on the Moon, so tapping it
     * changes nothing, and on a phone the sheet is covering the Moon anyway. It
     * is a button now, and this is the check that it does what it says.
     *
     * Four in a row, because one different fact could be luck and a rotation
     * that has quietly stopped moving looks exactly like a rotation that has
     * not until you ask it more than twice.
     */
    console.log('');
    console.log('ask for another fact:');
    const factSeen = [];
    for (let i = 0; i < 4; i++) {
      factSeen.push(
        await evalPage(
          `document.querySelector('.sheet__fact-text')?.textContent?.trim() ?? '(none)'`,
        ),
      );
      await evalPage(
        `[...document.querySelectorAll('.sheet__fact button')].find(b => /another/i.test(b.textContent))?.click()`,
      );
      await sleep(400);
    }

    check('the sheet offers a fact at all', factSeen[0] !== '(none)', factSeen[0]?.slice(0, 70));
    check(
      'and a different one each time it is asked',
      new Set(factSeen).size === factSeen.length,
      `${new Set(factSeen).size} distinct of ${factSeen.length}`,
    );
    for (const f of factSeen) console.log(`  · ${f.slice(0, 88)}`);
    await shot('11-another-fact');


    console.log('\nask the guide to explain it:');
    /*
     * What the sheet said before anybody asked.
     *
     * The description is written on open by the built-in narrator, so
     * `.sheet__narration` exists from the moment the panel does. Waiting for it
     * to appear therefore returns instantly and proves nothing, which is what
     * this check did until it was pointed at a working model and cheerfully
     * reported the local text back. What is being waited for is the answer
     * changing hands, so the line it started with is recorded first.
     */
    const beforeAsking = await evalPage(
      `document.querySelector('.sheet__guide .provenance')?.textContent ?? ''`,
    );
    await evalPage(
      `[...document.querySelectorAll('.sheet .button')].find(b => /ask the ai guide/i.test(b.textContent))?.click()`,
    );
    /*
     * Waited for rather than slept through.
     *
     * How long an answer takes depends on which model produced it, and that is
     * no longer one number: watsonx answers in a second or two, a local Granite
     * on a laptop can take the better part of a minute, and a question that
     * needs a lookup costs a whole extra round trip on top. A fixed sleep
     * encodes whichever of those the machine happened to be doing on the day it
     * was written, and fails on every other one. Polling costs nothing when the
     * answer is quick.
     */
    const narration = await until(async () => {
      return evalPage(`
        (() => {
          const t = document.querySelector('.sheet__narration')?.textContent;
          const p = document.querySelector('.sheet__guide .provenance')?.textContent ?? '';
          return t && p !== ${JSON.stringify(beforeAsking)}
            ? JSON.stringify({ text: t, provenance: p })
            : null;
        })()
      `);
    }, 90_000);
    check('the guide answered, and not with the line already on screen', !!narration);
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

    /*
     * Back goes back one step.
     *
     * Tapping the briefing leaves the sky for Explore, and the button in the
     * corner then said "go back" and returned to the landing page, which is a
     * long way further back than anybody meant. From anywhere that is not the
     * sky it now returns to the sky, and only from the sky does it leave.
     */
    console.log('');
    console.log('back from a reading view:');
    await evalPage(
      `[...document.querySelectorAll('.rail__item')].find(b => /explore/i.test(b.textContent))?.click()`,
    );
    await sleep(700);
    const backLabel = await evalPage(
      `document.querySelector('.go-back')?.textContent?.trim() ?? ''`,
    );
    check('the button says where it goes', /back to sky/i.test(backLabel), backLabel);
    await evalPage(`document.querySelector('.go-back')?.click()`);
    await sleep(700);
    check(
      'and goes there, rather than out to the landing page',
      (await evalPage(`!!document.querySelector('.app .sky-view')`)) === true,
    );

    console.log('\nask a question in the guide:');
    await evalPage(
      `[...document.querySelectorAll('.rail__item')].find(b => b.textContent.trim().startsWith('Explore'))?.click()`,
    );
    await sleep(700);
    await evalPage(`document.querySelectorAll('.chat__suggestions .pill')[0]?.click()`);
    // Same reasoning as the explanation above: wait for the answer, not a guess
    // at how long the model that produced it takes.
    const chat = await until(async () => {
      const raw = await evalPage(`
        JSON.stringify([...document.querySelectorAll('.bubble')].map(b => b.textContent.trim().slice(0, 220)))
      `);
      const found = JSON.parse(raw);
      return found.length >= 2 && found[1] ? raw : null;
    }, 90_000);
    const bubbles = chat ? JSON.parse(chat) : [];
    check('guide answered', bubbles.length >= 2, `${bubbles.length} bubbles`);
    for (const b of bubbles) console.log(`  · ${b}`);
    await shot('08-guide-answer');

    console.log("\nread tonight's strip:");
    await evalPage(
      `[...document.querySelectorAll('.rail__item')].find(b => b.textContent.trim().startsWith('Tonight'))?.click()`,
    );
    await sleep(900);
    /*
     * Every moment label, with the row it was placed on and the box it ended up
     * occupying. Measured off the page rather than recomputed here, so this is
     * checking what was laid out instead of running a second copy of the same
     * arithmetic and agreeing with itself.
     */
    const strip = await evalPage(`
      JSON.stringify([...document.querySelectorAll('.strip__moment')].map((m) => {
        const label = m.querySelector('.strip__moment-label');
        const box = label.getBoundingClientRect();
        return {
          name: label.textContent.trim(),
          row: parseInt(label.style.top, 10) || 0,
          left: box.left,
          right: box.right,
        };
      }))
    `);
    const marks = JSON.parse(strip);
    check("the strip named tonight's moments", marks.length > 0, `${marks.length} moments`);

    // Two labels are allowed to sit at the same time, and two are allowed to
    // share a row. What they are not allowed to do is both, which is what the
    // strip did every night: sunrise follows the sky brightening by about
    // twenty minutes, and twenty minutes is thirty pixels here.
    const collisions = [];
    for (let i = 0; i < marks.length; i++) {
      for (let j = i + 1; j < marks.length; j++) {
        const a = marks[i];
        const b = marks[j];
        if (a.row !== b.row) continue;
        if (a.left < b.right && b.left < a.right) collisions.push(`${a.name} / ${b.name}`);
      }
    }
    check(
      'no two moment labels are printed over each other',
      collisions.length === 0,
      collisions.join(', '),
    );
    for (const m of marks) console.log(`  row ${m.row / 13}  ${m.name}`);
    await shot('10-tonight-strip');

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
