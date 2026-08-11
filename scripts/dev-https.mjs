/**
 * The dev server over https, so a phone can actually use its compass.
 *
 * iOS and Android both refuse to hand the motion sensors to an insecure origin,
 * and they refuse silently: the events simply never fire, which is
 * indistinguishable from a device with no compass at all. `npm run dev` over a
 * LAN address is therefore enough to open the app on a phone but not enough to
 * test the sky view following it.
 *
 * A node launcher rather than an inline env var in package.json, because
 * `VAR=1 vite` is not valid on Windows shells.
 */

process.env.BORROWED_SKY_HTTPS = '1';

const { createServer } = await import('vite');

const server = await createServer();
await server.listen();

server.printUrls();
console.log(
  '\n  The certificate is self-signed, so the first visit warns you.' +
    '\n  On iPhone: Show Details → visit this website → Visit.' +
    '\n  Then open the sky view and tap "Turn on compass tracking".\n',
);
