/**
 * What a person sees when the AI is not there.
 *
 * Every other check in this repository exercises the guide against a watsonx
 * endpoint that works. The interesting question for anybody opening the
 * deployed app is the opposite one: the project is out of quota, the key is
 * wrong, the service is briefly down, or the request simply never comes back.
 * The app's stated behaviour is that it answers anyway, from the deterministic
 * narrator, and says which of the two spoke. Until this file, nothing tested
 * that claim, so the one path most likely to be exercised in front of a
 * stranger was the only one never exercised here.
 *
 * Each case fakes one refusal at the network layer, asks a real question, and
 * insists on three things: an answer appeared, it carries values computed from
 * this observer's own sky rather than a canned apology, and the interface does
 * not claim Granite said it.
 *
 * The last case fakes no refusal at all. It holds the request open and never
 * answers, which is what a stalled connection and an overloaded upstream both
 * look like from the browser. That case found a real defect: there was no
 * deadline on the request, so the guide waited for as long as the page was
 * open. See the deadline in askGuide in src/lib/ai.ts.
 *
 * Run: node scripts/verify/degrade.mjs
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const APP = process.env.APP_URL || 'http://localhost:5173';
const PORT = 9351;

/** Greenwich, so the computed sky is the one the rest of the suite talks about. */
const SITE = { latitude: 51.4779, longitude: -0.0015, elevation: 47, source: 'gps' };

/**
 * The refusals api/ask.ts can make, plus the two it cannot.
 *
 * `hold` is not an error the endpoint returns. It is the absence of one: the
 * request is paused and never fulfilled. `block` is the network failing
 * outright rather than the service answering.
 */
const CASES = [
  {
    name: 'watsonx out of quota',
    mode: 'fulfil',
    status: 502,
    body: { error: 'ai_unavailable' },
  },
  {
    name: 'no credentials on this deployment',
    mode: 'fulfil',
    status: 503,
    body: { error: 'ai_unconfigured' },
  },
  {
    name: 'throttled',
    mode: 'fulfil',
    status: 429,
    body: { error: 'rate_limited', message: 'Too many questions in a minute.' },
  },
  {
    name: 'the answer failed the grounding guard',
    mode: 'fulfil',
    status: 502,
    body: { error: 'ai_ungrounded', unsupported: ['magnitude 47'] },
  },
  { name: 'endpoint unreachable', mode: 'block' },
  { name: 'endpoint accepts the request and never answers', mode: 'hold', patience: 40000 },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let nextId = 1;

function rpc(socket, method, params = {}, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(method + ': ' + msg.error.message));
      else resolve(msg.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}

const b64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');

/**
 * The newest answer in the transcript, with the line under it that says who
 * spoke. Read from the page rather than inferred, because the whole point of
 * this check is what a person actually sees.
 */
const READ_LAST = [
  '(() => {',
  '  // bubble--thinking is the spinner and carries the same class, so it is excluded.',
  '  const bubbles = [...document.querySelectorAll(".bubble--guide:not(.bubble--thinking)")];',
  '  const last = bubbles[bubbles.length - 1];',
  '  if (!last) return JSON.stringify({ text: null, provenance: null, count: bubbles.length });',
  '  const t = last.querySelector(".bubble__text");',
  '  const p = last.querySelector(".provenance");',
  '  return JSON.stringify({',
  '    text: t ? t.innerText : null,',
  '    provenance: p ? p.innerText : null,',
  '    count: bubbles.length,',
  '  });',
  '})()',
].join('\n');

async function main() {
  const profile = join(tmpdir(), 'bs-degrade-' + Date.now());
  const failures = [];
  const check = (label, ok, detail = '') => {
    console.log('  ' + (ok ? 'ok  ' : 'FAIL') + '  ' + label + (detail ? ': ' + detail : ''));
    if (!ok) failures.push(label);
  };

  const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=430,932', '--hide-scrollbars', '--no-first-run', '--disable-gpu',
  ], { stdio: 'ignore' });

  try {
    let wsUrl = null;
    for (let i = 0; i < 40 && !wsUrl; i++) {
      await sleep(250);
      try { wsUrl = (await (await fetch('http://127.0.0.1:' + PORT + '/json/version')).json()).webSocketDebuggerUrl; } catch {}
    }
    if (!wsUrl) throw new Error('Chrome did not expose a debugging endpoint');

    const browser = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      browser.addEventListener('open', res, { once: true });
      browser.addEventListener('error', () => rej(new Error('socket failed')), { once: true });
    });

    for (const testCase of CASES) {
      const { targetId } = await rpc(browser, 'Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await rpc(browser, 'Target.attachToTarget', { targetId, flatten: true });
      const page = {
        send: (d) => browser.send(d),
        addEventListener: (...a) => browser.addEventListener(...a),
        removeEventListener: (...a) => browser.removeEventListener(...a),
      };
      const call = (m, p) => rpc(page, m, p, sessionId);
      const evalPage = (expression) =>
        rpc(page, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
          .then((r) => {
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
            return r.result.value;
          });

      await call('Page.enable');
      await call('Runtime.enable');
      await call('Emulation.setDeviceMetricsOverride', {
        width: 430, height: 932, deviceScaleFactor: 1, mobile: true,
      });

      // Uncaught page errors, collected for the whole case.
      const consoleErrors = [];
      let held = 0;
      const onMessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch { return; }
        if (msg.sessionId !== sessionId) return;

        if (msg.method === 'Runtime.exceptionThrown') {
          const d = msg.params?.exceptionDetails;
          consoleErrors.push(d?.exception?.description || d?.text || 'unknown');
        }

        if (msg.method === 'Fetch.requestPaused') {
          const { requestId, request } = msg.params;
          if (!request.url.includes('/api/ask')) {
            void rpc(page, 'Fetch.continueRequest', { requestId }, sessionId).catch(() => {});
            return;
          }
          if (testCase.mode === 'fulfil') {
            void rpc(page, 'Fetch.fulfillRequest', {
              requestId,
              responseCode: testCase.status,
              responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
              body: b64(testCase.body),
            }, sessionId).catch(() => {});
          } else if (testCase.mode === 'hold') {
            // Deliberately never fulfilled. This is the case with no answer.
            held += 1;
          } else {
            void rpc(page, 'Fetch.failRequest', { requestId, errorReason: 'Failed' }, sessionId).catch(() => {});
          }
        }
      };
      browser.addEventListener('message', onMessage);

      if (testCase.mode === 'block') {
        await call('Network.enable');
        await call('Network.setBlockedURLs', { urls: ['*/api/ask*'] });
      }
      await call('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });

      await call('Page.addScriptToEvaluateOnNewDocument', {
        source: 'try { localStorage.setItem("borrowed-sky:site", ' + JSON.stringify(JSON.stringify(SITE)) + '); } catch (e) {}',
      });

      await call('Page.navigate', { url: APP });
      await sleep(6000);

      let entered = false;
      for (let i = 0; i < 60 && !entered; i++) {
        entered = await evalPage('!!document.querySelector(".app")');
        if (!entered) {
          await evalPage('document.querySelector(".overture__panel--close .button--primary")?.click()');
          await sleep(250);
        }
      }
      if (!entered) throw new Error('never got past the landing page');

      await evalPage('(() => { const b = [...document.querySelectorAll(".rail__item")].find(x => x.textContent.trim().startsWith("Explore")); if (b) b.click(); return true; })()');
      await sleep(2000);

      console.log('\n' + testCase.name);

      // Ask, the way a person does: type into the composer and submit.
      const asked = await evalPage([
        '(() => {',
        '  const input = document.querySelector(".composer__input");',
        '  const form = input && input.closest("form");',
        '  if (!input || !form) return false;',
        '  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;',
        '  setter.call(input, "What is the brightest thing up right now?");',
        '  input.dispatchEvent(new Event("input", { bubbles: true }));',
        '  form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));',
        '  return true;',
        '})()',
      ].join('\n'));
      check('the question could be asked at all', asked === true);

      /*
       * Wait for an answer rather than for a fixed interval. The held case is
       * meant to take as long as the client's deadline, and the others should
       * be quick; polling lets both be measured rather than assumed.
       */
      const patience = testCase.patience || 15000;
      const started = Date.now();
      let seen = null;
      while (Date.now() - started < patience) {
        const raw = await evalPage(READ_LAST);
        const parsed = JSON.parse(raw);
        if (parsed.text && parsed.provenance) { seen = parsed; break; }
        await sleep(500);
      }
      const waited = ((Date.now() - started) / 1000).toFixed(1);

      if (!seen) {
        check('an answer appeared', false, 'nothing after ' + waited + 's');
      } else {
        check('an answer appeared', true, 'after ' + waited + 's');
        console.log('        said: ' + seen.text.slice(0, 96).replace(/\s+/g, ' ') + '...');
        console.log('        under it: ' + seen.provenance);

        /*
         * Grounded, not canned. The fallback narrates from the same computed
         * sky, so its text has to carry something only that sky could supply.
         * A digit is the cheapest such thing that cannot be written into a
         * static apology by accident.
         */
        check('and it carries computed values rather than an apology', /\d/.test(seen.text));

        // The rule the whole app rests on: never claim Granite spoke when it did not.
        check(
          'and it does not claim Granite answered',
          !/granite/i.test(seen.provenance),
          seen.provenance,
        );
      }

      if (testCase.mode === 'hold') {
        check('the request really was left hanging', held > 0, held + ' held');
      }

      check('no uncaught errors on the page', consoleErrors.length === 0, consoleErrors.slice(0, 2).join(' | '));

      browser.removeEventListener('message', onMessage);
      await rpc(browser, 'Target.closeTarget', { targetId });
    }

    console.log('');
    if (failures.length) {
      console.error('FAIL  ' + failures.length + ' case(s): ' + [...new Set(failures)].join(', '));
      process.exitCode = 1;
    } else {
      console.log('PASS  the guide answers from the computed sky whatever watsonx does, and says so');
    }
  } finally {
    chrome.kill();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
