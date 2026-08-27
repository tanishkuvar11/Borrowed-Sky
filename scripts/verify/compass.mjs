#!/usr/bin/env node
/**
 * The compass paths, which are the hardest part of the app to test by hand
 * because reaching them needs a real phone on a real https origin.
 *
 * Two cases, both previously broken:
 *
 *   1. Insecure origin. A phone opening the dev server by LAN address gets no
 *      sensor at all, silently. The app must name the connection as the cause
 *      rather than blame the hardware.
 *
 *   2. iOS permission grant. Safari exposes requestPermission and withholds
 *      readings until it resolves 'granted'. The hook must then actually
 *      subscribe, the failure mode this guards is a permanent
 *      "waiting for the compass" after the user has already said yes.
 *
 * Run against `npm run dev`:  node scripts/verify/compass.mjs
 * Override the port with APP_PORT if the dev server moved.
 */

import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PORT_APP = process.env.APP_PORT || '5173';
const OUT = 'scripts/verify/shots';
const PORT = 9336;
const SITE = { latitude: -26.2041, longitude: 28.0473, elevation: 1753, source: 'gps' };

/** A routable LAN address for this machine: what a phone would actually type. */
function lanAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

/**
 * Having a LAN address is not the same as being able to reach the dev server on
 * it: a host firewall can allow the loopback bind and still drop inbound
 * connections to the interface. Chrome would then report a blank page, and the
 * checks below would fail for a reason that has nothing to do with the compass.
 * Probe first so an unreachable origin is reported as an unrun case rather than
 * a false failure.
 */
async function reachable(url) {
  try {
    const stop = AbortSignal.timeout(3000);
    await fetch(url, { signal: stop });
    return true;
  } catch {
    return false;
  }
}

const profile = join(tmpdir(), `bs-chrome-c-${Date.now()}`);
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
let skipped = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

/**
 * Turns the page into an iPhone as far as this hook can tell: a gated
 * requestPermission, and a compass that reports a true heading through the
 * WebKit-only property rather than through `absolute`.
 */
const IOS_SHIM = `
  window.__granted = false;
  DeviceOrientationEvent.requestPermission = async () => {
    window.__granted = true;
    return 'granted';
  };
  window.__emit = (heading, beta, gamma) => {
    const e = new DeviceOrientationEvent('deviceorientation', {
      alpha: 360 - heading, beta, gamma, absolute: false,
    });
    Object.defineProperty(e, 'webkitCompassHeading', { value: heading });
    Object.defineProperty(e, 'webkitCompassAccuracy', { value: 12 });
    if (!window.__granted) return false;   // Safari delivers nothing before the grant
    window.dispatchEvent(e);
    return true;
  };
`;


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

    /** Opens the compass dialog behind the header rose and reads it back. */
    const openRose = async () => {
      await evalPage(`(() => {
        // The app may have opened this itself, in which case the rose is
        // behind a scrim and clicking it would close what we came to read.
        if (document.querySelector('.dialog__panel')) return true;
        const rose = document.querySelector('.rose:not(.rose--plain)');
        if (!rose) throw new Error('no compass rose in header');
        rose.click();
        return true;
      })()`);
      await sleep(350);
    };
    const closeDialog = async () => {
      await evalPage(`document.querySelector('.dialog__close')?.click()`);
      await sleep(250);
    };
    const dialogText = () =>
      evalPage(`document.querySelector('.dialog__panel')?.innerText ?? '(no dialog)'`);

    /** The header rose's own state class: the at-a-glance indicator. */
    const roseState = () =>
      evalPage(
        `[...(document.querySelector('.rose:not(.rose--plain)')?.classList ?? [])]
           .find(c => c.startsWith('rose--')) ?? '(none)'`,
      );

    /** The sentence the sky itself offers about its aim, if it is offering one. */
    const prompt = () =>
      evalPage(`document.querySelector('.compass-prompt')?.innerText.trim() ?? '(none)'`);

    /** The same state, in the word printed under the rose. */
    const tagWord = () =>
      evalPage(`document.querySelector('.compass-tag__state')?.innerText.trim() ?? '(none)'`);

    const enterApp = enterAppWith(evalPage, sleep);

    const seedSite = () =>
      evalPage(
        `localStorage.setItem('borrowed-sky:site', ${JSON.stringify(JSON.stringify(SITE))})`,
      );

    /**
     * Waits until the header rose has actually rendered.
     *
     * A fixed sleep after reload is a guess about how long the app takes to
     * paint, and the guess is wrong exactly when the machine is busy; this
     * suite runs three headless Chromes in sequence, so the last one starts
     * slowest and was intermittently asserting against a page that had not
     * mounted yet. Polling for the element turns a timing race into a wait.
     */
    // Generous, because the first run after a source change also pays for Vite
    // transforming the module graph, and this suite's third browser starts
    // while two others are still shutting down. A wait costs nothing when the
    // page is quick; a ceiling that is too low costs a false failure.
    const waitForRose = async (expected, timeout = 45000) => {
      const until = Date.now() + timeout;
      let seen = '(none)';
      while (Date.now() < until) {
        seen = await roseState();
        if (seen === expected) return seen;
        await sleep(250);
      }
      return seen;
    };

    // -- Case 1: opened by LAN address, the way a phone reaches the dev server --

    const lan = lanAddress();
    const lanUrl = lan ? `http://${lan}:${PORT_APP}/` : null;
    if (!lan) {
      console.log('\n  SKIPPED insecure-origin case: no non-internal IPv4 interface to pose as a phone');
    } else if (!(await reachable(lanUrl))) {
      skipped += 1;
      console.log(`\n  SKIPPED insecure-origin case: ${lanUrl} is not reachable from this machine.`);
      console.log('    The dev server is bound to it, so this is a host firewall dropping inbound');
      console.log(`    connections to ${process.execPath}. Allow that binary, or run this suite`);
      console.log('    from a machine where the LAN interface accepts connections.');
    } else {
      console.log(`\nInsecure origin  http://${lan}:${PORT_APP}`);
      await call('Page.navigate', { url: `http://${lan}:${PORT_APP}/` });
      await sleep(1500);
      await seedSite();
      await call('Page.reload');
      await enterApp();
      await sleep(1500);
      await waitForRose('rose--blocked');

      const secure = await evalPage('window.isSecureContext');
      check('origin is genuinely insecure', secure === false, `isSecureContext=${secure}`);
      check('header rose shows blocked', (await roseState()) === 'rose--blocked', await roseState());
      check(
        'and says so in a word, not only in a colour',
        (await tagWord()).toLowerCase() === 'manual',
        await tagWord(),
      );

      await openRose();
      const text = await dialogText();
      check(
        'names the connection, not the hardware',
        /https/i.test(text) && !/no compass/i.test(text),
        JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 120)),
      );
      check(
        'calls manual mode a mode, not a failure',
        /manual mode is a full mode/i.test(text),
      );
      await shot('compass-insecure');
      await closeDialog();
    }

    // -- Case 2: iOS on a secure origin, permission asked for and granted --

    console.log(`\niOS permission flow  http://localhost:${PORT_APP}`);
    const { identifier } = await call('Page.addScriptToEvaluateOnNewDocument', {
      source: IOS_SHIM,
    });
    await call('Page.navigate', { url: `http://localhost:${PORT_APP}/` });
    await sleep(1500);
    await seedSite();
    await call('Page.reload');
    await enterApp();
    await sleep(1500);
    await waitForRose('rose--ask');

    check('secure origin', (await evalPage('window.isSecureContext')) === true);

    check('header rose invites a tap', (await roseState()) === 'rose--ask', await roseState());
    check(
      'the sky names the compass and offers a way to turn it on',
      /compass/i.test(await prompt()) && /tap/i.test(await prompt()),
      await prompt(),
    );
    check(
      'and says so in a word, not only in a colour',
      (await tagWord()).toLowerCase() === 'off',
      await tagWord(),
    );

    /*
     * The offer arrives without being asked for.
     *
     * Tracking is the default everywhere, and on Android it simply happens: the
     * listener attaches and the first reading makes it live. Safari will not
     * hand a web page the motion sensors without a tap, so on iOS the app opens
     * this sheet itself the moment there is a sky to point at, rather than
     * leaving the one thing worth holding a phone up for behind a button
     * somebody has to go and find.
     */
    check(
      'the compass offer opens by itself where a tap is the only thing missing',
      /compass tracking/i.test(await dialogText()),
      (await dialogText()).slice(0, 52).replace(/\s+/g, ' '),
    );

    await openRose();
    const before = await dialogText();
    check(
      'offers the permission button, does not listen yet',
      /compass tracking/i.test(before),
      JSON.stringify(before.replace(/\s+/g, ' ').slice(0, 80)),
    );

    // Readings before the grant must be ignored, the way Safari ignores them.
    check('withholds readings before the grant', (await evalPage('window.__emit(90, 45, 0)')) === false);
    await shot('compass-needs-permission');

    await evalPage(
      `[...document.querySelectorAll('button')].find(b => /compass tracking/i.test(b.textContent)).click()`,
    );
    await sleep(400);
    check('requestPermission was called', (await evalPage('window.__granted')) === true);

    // A phone streams these continuously once granted; a handful is plenty for
    // the low-pass filter to settle onto the heading.
    for (let i = 0; i < 12; i++) {
      await evalPage('window.__emit(90, 45, 0)');
      await sleep(60);
    }
    await sleep(600);

    const after = await dialogText();
    check(
      'subscribes after the grant and goes live',
      /follow my phone|following your phone/i.test(after),
      JSON.stringify(after.replace(/\s+/g, ' ').slice(0, 80)),
    );
    check(
      'does not sit on "waiting" after the user said yes',
      !/waiting for the/i.test(after),
    );
    check(
      'treats webkitCompassHeading as north-referenced',
      !/no true-north reference/i.test(after),
    );

    // Facing east with the phone tilted back, the heading readout should agree.
    const shownHeading = Number(/(\d+)°/.exec(after)?.[1] ?? NaN);
    check(
      'reads out the heading it was given',
      Math.abs(shownHeading - 90) <= 2,
      `${shownHeading}° for a 90° compass heading`,
    );

    await closeDialog();
    check('header rose shows live tracking', (await roseState()) === 'rose--live');
    check(
      'and the sky stops offering to do anything about it',
      (await prompt()) === '(none)',
      await prompt(),
    );
    check(
      'and says so in a word, not only in a colour',
      (await tagWord()).toLowerCase() === 'live',
      await tagWord(),
    );
    await shot('compass-active');

    /*
     * A tablet held in landscape.
     *
     * Orientation events describe the device, not the page, so a rotated
     * screen has to be corrected for. A phone hides this: it is used upright,
     * so the correction is usually zero and being wrong about it costs
     * nothing. A tablet lives in landscape, and there it is a ninety degree
     * error in the heading.
     *
     * Beta near 180 is the device leaning right back, camera at the zenith,
     * which is the whole use of this app. Near
     * the zenith the look direction has almost no horizontal part left, so the
     * heading leans on the screen's own up axis instead, and that axis is
     * exactly the thing screen rotation moves.
     *
     * So: point it up, read the heading, rotate the screen, read it again. The
     * two must differ by ninety degrees. If they agree, the app is not reading
     * the rotation at all, which is the bug this exists for.
     */
    const POINTS = {
      N: 0, NNE: 22.5, NE: 45, ENE: 67.5,
      E: 90, ESE: 112.5, SE: 135, SSE: 157.5,
      S: 180, SSW: 202.5, SW: 225, WSW: 247.5,
      W: 270, WNW: 292.5, NW: 315, NNW: 337.5,
    };

    /*
     * Read the dial, not the dialog.
     *
     * The dialog prints the compass heading of the device, which is a fact
     * about the hardware and is the same whichever way the page is turned. The
     * dial prints the bearing the chart is actually drawn to, which is the
     * thing a rotated screen has to move and the thing somebody standing
     * outside is looking at. Measuring the first would have called this fixed
     * while the sky stayed ninety degrees out.
     */
    const headingPointedUp = async () => {
      for (let i = 0; i < 14; i++) {
        await evalPage('window.__emit(90, 180, 0)');
        await sleep(60);
      }
      await sleep(700);
      const point = await evalPage(
        `document.querySelector('.horizon__point')?.innerText.trim() ?? ''`,
      );
      return POINTS[point.toUpperCase()];
    };

    /*
     * Both ends are pinned, including the one that looks like a default.
     *
     * Headless Chrome reports its own screen.orientation, and it says
     * landscape even while a portrait viewport is being emulated. Leaving the
     * upright case to whatever the host happened to report made the baseline
     * move when the correction below changed, which is a test measuring the
     * machine it runs on rather than the code it is checking.
     */
    const setScreenAngle = (angle, type) =>
      evalPage(
        `(() => {
          Object.defineProperty(screen, 'orientation', {
            value: { angle: ${angle}, type: '${type}' },
            configurable: true,
          });
          return screen.orientation.angle;
        })()`,
      );

    await setScreenAngle(0, 'portrait-primary');
    const upright = await headingPointedUp();
    await setScreenAngle(90, 'landscape-primary');
    const rotated = await headingPointedUp();

    const turned = (((rotated - upright) % 360) + 360) % 360;
    /*
     * A quarter turn, in whichever direction.
     *
     * That the rotation is read at all is the thing this can prove on a
     * desktop, and it is the thing that was broken: without it the heading did
     * not move by so much as a degree. Which way round it should turn is a
     * question about a physical tablet, and asserting a sign from here would
     * be inventing a fact rather than checking one. If somebody finds the sky
     * mirrored on a real device, the fault is the sign in
     * screenUpInDeviceFrame and this case will not catch it.
     */
    check(
      'a rotated screen turns the heading by a quarter turn',
      Math.abs(turned - 90) <= 12 || Math.abs(turned - 270) <= 12,
      `${upright}\u00b0 upright, ${rotated}\u00b0 rotated, a difference of ${turned}\u00b0`,
    );

    /*
     * And the same, on a browser with no screen.orientation at all.
     *
     * Safari came to that interface late, and iPadOS is where its absence
     * matters. The legacy value it does expose counts the other way round, so
     * this fails if the fallback forgets to negate it: the heading would come
     * out ninety degrees wrong in the opposite direction and look like a fix.
     */
    await evalPage(
      `(() => {
        Object.defineProperty(screen, 'orientation', { value: undefined, configurable: true });
        Object.defineProperty(window, 'orientation', { value: -90, configurable: true });
        return true;
      })()`,
    );
    const legacy = await headingPointedUp();
    check(
      'and the legacy iOS value is read, with its sign put right',
      Math.abs((((legacy - rotated) % 360) + 360) % 360) <= 4 ||
        Math.abs((((rotated - legacy) % 360) + 360) % 360) <= 4,
      `${legacy}\u00b0 from window.orientation against ${rotated}\u00b0 from screen.orientation`,
    );

    await call('Page.removeScriptToEvaluateOnNewDocument', { identifier });

    const errs = await evalPage(`JSON.stringify(window.__pageErrors || [])`);
    check('no page errors', errs === '[]', errs);
  } finally {
    chrome.kill();
  }

  console.log('');
  if (failures.length) {
    console.error(`FAIL  ${failures.length} check(s): ${failures.join(', ')}`);
    process.exitCode = 1;
  } else if (skipped) {
    // Not a pass. Everything that ran was correct, but a case did not run, and
    // saying "PASS" here would claim coverage this run did not actually have.
    console.log(`PARTIAL  every check that ran passed, but ${skipped} case(s) could not run`);
  } else {
    console.log('PASS  compass paths behave correctly on both origins');
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
