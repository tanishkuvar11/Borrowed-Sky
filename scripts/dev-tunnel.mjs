/**
 * The dev server behind a real certificate, so a phone can use its location.
 *
 * `npm run dev:https` is enough for the compass: iOS will hand over the motion
 * sensors on a self-signed origin once you tap through the warning. Geolocation
 * is gated harder. WebKit treats an origin reached through a certificate
 * exception as untrustworthy for that particular permission and declines to
 * even show the prompt, which looks exactly like a denial you cannot undo,
 * because there is no prompt to answer and no setting that re-enables it.
 *
 * The fix is a certificate the phone already trusts. A quick tunnel provides
 * one without an account: it terminates TLS on a *.trycloudflare.com hostname
 * and forwards to the local dev server, so HMR keeps working and the phone gets
 * a fully trusted origin. Deploying fixes it too, but costs you live reload.
 *
 * The tunnel URL changes every run; that is the trade for needing no account.
 */

import { spawn } from 'node:child_process';

// Validated rather than trusted: it is interpolated into a shell command below,
// and a port is a number or it is nothing.
const PORT = process.env.PORT || '5173';
if (!/^\d{1,5}$/.test(PORT)) {
  console.error(`  PORT must be a number, got ${JSON.stringify(PORT)}`);
  process.exit(1);
}

/** Matches the hostname cloudflared prints once the tunnel is established. */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

const children = [];
let shuttingDown = false;

function stopAll() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
}

process.on('SIGINT', () => {
  stopAll();
  process.exit(0);
});
process.on('SIGTERM', () => {
  stopAll();
  process.exit(0);
});

// -- The dev server ---------------------------------------------------------
// Plain http on purpose: the tunnel terminates TLS, so a self-signed
// certificate here would only add a hop that cloudflared has to be told to
// trust.

const { createServer } = await import('vite');
const server = await createServer({ server: { port: Number(PORT) } });
await server.listen();
server.printUrls();

// -- The tunnel -------------------------------------------------------------

console.log('\n  Starting the tunnel. First run downloads cloudflared, which takes a moment…\n');

// One command string rather than an args array: npx is a .cmd shim on Windows,
// which node will not spawn without a shell, and passing args alongside
// shell:true is deprecated (DEP0190). PORT is checked above, and nothing else
// here comes from outside this file.
const tunnel = spawn(`npx -y cloudflared tunnel --url http://localhost:${PORT}`, {
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
children.push(tunnel);

let announced = false;

/**
 * cloudflared writes its progress to stderr, banner and all. Rather than
 * relaying the whole thing, watch for the hostname and say the one thing that
 * matters; keep the rest available if it never arrives.
 */
function watch(chunk) {
  const text = chunk.toString();
  const found = text.match(URL_PATTERN);
  if (found && !announced) {
    announced = true;
    const url = found[0];
    console.log(`\n  ${'─'.repeat(58)}`);
    console.log(`  Open this on your phone:  ${url}`);
    console.log(`  ${'─'.repeat(58)}`);
    console.log('\n  Trusted certificate, so no warning to tap through, and this');
    console.log('  is the origin where "Use my location" will actually prompt.');
    console.log('  Hot reload works through it. The URL is new on every run.\n');
    return;
  }
  if (!announced && /err|fail|fatal/i.test(text)) process.stderr.write(text);
}

tunnel.stdout.on('data', watch);
tunnel.stderr.on('data', watch);

tunnel.on('error', (err) => {
  console.error(`\n  Could not start cloudflared: ${err.message}`);
  console.error('  The dev server is still up; only the tunnel failed.\n');
});

tunnel.on('exit', (code) => {
  if (!shuttingDown && code !== 0) {
    console.error(`\n  cloudflared exited with code ${code}. The dev server is still running.\n`);
  }
});
