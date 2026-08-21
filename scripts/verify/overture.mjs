#!/usr/bin/env node
/**
 * Captures the scrolling overture at intervals through its travel.
 *
 * The page's whole claim is that the sky changes because it is being computed,
 * not because something is fading in, so the useful evidence is a series of
 * frames plus the instant each one is rendering. This scrolls in steps, shoots
 * each stop, and reads the slate back so the pictures can be checked against
 * the clock that produced them.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP_URL || 'http://localhost:5173';
const OUT = 'scripts/verify/shots';
const PORT = 9342;
/**
 * Sampled where each caption is at full strength rather than at the boundaries
 * of its slice: the boundaries are precisely where a caption has faded out, so
 * shooting there produces a set of frames with no words in any of them.
 */
const STOPS = [0, 0.24, 0.48, 0.72, 0.92, 1];

const profile = join(tmpdir(), `bs-chrome-o-${Date.now()}`);
/** Johannesburg, the site the rest of the suite shoots from. */
const RETURNING = { latitude: -26.2041, longitude: 28.0473, elevation: 1753, source: 'gps' };

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
    };

    // No stored site, so the app opens on the overture rather than the sky.
    await call('Page.navigate', { url: APP });
    await sleep(1500);
    await evalPage(`localStorage.removeItem('borrowed-sky:site')`);
    await call('Page.reload');
    await sleep(9000);

    check('overture rendered', (await evalPage(`!!document.querySelector('.overture')`)) === true);
    check(
      'sky canvas mounted',
      (await evalPage(`!!document.querySelector('.overture__stage canvas')`)) === true,
    );

    const clocks = [];
    for (const [index, at] of STOPS.entries()) {
      // Offset from the top of the document, not from zero: anything mounted
      // above the overture (a pinned hero, say) shifts where its travel starts,
      // and scrolling to a bare fraction would land in that section instead.
      // Steered through Lenis where it is running: it owns the scroll position,
      // and window.scrollTo would move the document without it noticing, so
      // nothing downstream would update.
      await evalPage(`(() => {
        const el = document.querySelector('.overture');
        const top = el.getBoundingClientRect().top + window.scrollY;
        const travel = el.scrollHeight - window.innerHeight;
        const y = top + travel * ${at};
        if (window.__lenis) window.__lenis.scrollTo(y, { immediate: true });
        else window.scrollTo(0, y);
      })()`);
      // Two frames: one for the scroll listener, one for the canvas redraw.
      await sleep(600);
      const clock = await evalPage(
        `document.querySelector('.overture__clock')?.innerText.trim() ?? ''`,
      );
      clocks.push(clock);
      await shot(`20-overture-${index}`);
      console.log(`  stop ${at.toFixed(2)}  ${clock}`);
    }

    // The clock is the page's proof of work. If it never moved, the sky is not
    // being recomputed and the whole premise is decoration.
    check('clock advances with scroll', new Set(clocks).size > 1, clocks.join(' → '));
    check(
      'slate names the place at every stop',
      // The label is small-caps via text-transform, so innerText reports it
      // uppercased, so compare case-insensitively rather than against the styling.
      (await evalPage(
        `/greenwich/i.test(document.querySelector('.overture__slate')?.innerText ?? '')`,
      )) === true,
    );
    const firstVisit = await evalPage(
      `document.querySelector('.overture__panel--close')?.innerText ?? ''`,
    );
    check('closing plate offers the ask', /show me my sky/i.test(firstVisit));
    check('and the coordinates underneath it', /enter coordinates instead/i.test(firstVisit));
    check('it has no site to name yet', !/computed for/i.test(firstVisit));

    /*
     * And again as somebody coming back.
     *
     * The page is shown on every visit now, not only the first, so the case
     * that matters most is the one where the location question has already
     * been answered. Asking it a second time would be the app forgetting a
     * thing it has written down, so the plate has to offer the way in instead
     * and keep the question underneath for the day they have moved.
     */
    console.log('');
    console.log('returning visitor:');
    await evalPage(
      `localStorage.setItem('borrowed-sky:site', ${JSON.stringify(JSON.stringify(RETURNING))})`,
    );
    await call('Page.reload');
    await sleep(9000);

    check(
      'the landing page is shown to someone it already knows',
      (await evalPage(`!!document.querySelector('.overture')`)) === true,
    );
    const plate = await evalPage(
      `document.querySelector('.overture__panel--close')?.innerText ?? ''`,
    );
    check('the plate offers the way in', /show me my sky/i.test(plate));
    /*
     * The point of the whole arrangement: one person's phone and one person's
     * laptop are in different states, and they should not be reading different
     * words. What differs is what the button does, not what it says.
     */
    check(
      'it is worded exactly as it is to a stranger',
      /show me my sky/i.test(plate) && /enter coordinates instead/i.test(plate),
    );
    check(
      'it says which sky it means',
      /26\.20.*S/i.test(plate.replace(/\s+/g, ' ')),
      plate.replace(/\s+/g, ' ').slice(0, 120),
    );
    await shot('21-overture-returning');

    // And the coordinates are still one tap under it, for the day they moved.
    await evalPage(
      `Array.from(document.querySelectorAll('.overture__plate button')).find(b => /enter coordinates instead/i.test(b.innerText))?.click()`,
    );
    await sleep(400);
    check(
      'the coordinates are one tap underneath',
      (await evalPage(`document.querySelectorAll('.overture__plate .field__input').length`)) === 2,
    );

    // And the way in works.
    await call('Page.reload');
    await sleep(9000);
    await evalPage(
      `Array.from(document.querySelectorAll('.overture__plate button')).find(b => /show me my sky/i.test(b.innerText))?.click()`,
    );
    await sleep(2500);
    check(
      'the way in reaches the instrument',
      (await evalPage(`!!document.querySelector('.app .sky-view')`)) === true,
    );
    await shot('22-overture-entered');

    /*
     * And back out again, by a control that says what it does.
     *
     * There was no way back for a while: the landing page was the door in, and
     * the only route to it afterwards was clearing the stored location, which
     * is a destructive act wearing navigation's clothes. So the test is not
     * just that something returns here, but that the thing which returns here
     * is labelled, which is the whole of what was wrong with the last version
     * of this where the name in the header quietly did it.
     */
    console.log('');
    console.log('and back:');
    const homeLabel = await evalPage(
      `document.querySelector('.rail__emblem')?.innerText.trim() ?? ''`,
    );
    check('the way back is labelled', /home/i.test(homeLabel), homeLabel || '(no label)');

    await evalPage(`document.querySelector('.rail__emblem')?.click()`);
    await sleep(1200);
    check(
      'and it lands on the landing page',
      (await evalPage(`!!document.querySelector('.overture')`)) === true,
    );
    check(
      'without throwing the stored location away',
      (await evalPage(`!!localStorage.getItem('borrowed-sky:site')`)) === true,
    );

    const errs = await evalPage(`JSON.stringify(window.__pageErrors || [])`);
    check('no page errors', errs === '[]', errs);
  } finally {
    chrome.kill();
  }

  console.log('');
  if (failures.length) {
    console.error(`FAIL  ${failures.length} check(s): ${failures.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('PASS  the overture computes its sky as it scrolls');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
