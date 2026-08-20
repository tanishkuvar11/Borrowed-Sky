/**
 * Boot.
 *
 * Nothing is shown until what would be shown is finished.
 *
 * The app used to mount the moment the bundle arrived, which meant the first
 * thing on screen was a real page with the contents missing: a starless sky
 * under a headline set in whatever face the system had lying around, and then,
 * a second later, thirteen thousand stars and the actual typography arriving on
 * top of it. Every one of those pops is the page correcting itself in public.
 * The page is an argument that this is a computed sky rather than a picture of
 * one, and watching it assemble out of placeholders undermines that before a
 * word of it has been read.
 *
 * So the two things that arrive late are waited for here, before the first
 * render: the star catalogue, and the fonts. Both are things whose absence is
 * visible; neither is something the page can honestly draw around.
 *
 * The cost is a longer wait on a dark screen, which is the trade that was
 * asked for. The screen is at least the right dark from the first frame, because
 * index.html paints the background itself rather than waiting for a stylesheet.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { loadConstellations, loadStarCatalog } from './lib/astro/starfield';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

/**
 * The longest anybody waits at a dark screen, whatever is or is not ready.
 *
 * A gate with no ceiling is a white screen of death the first time a CDN is
 * slow or a catalogue 404s in a bad deploy. The page degrades perfectly well
 * without either of these: the sky renders empty and the fonts fall back. What
 * it must never do is fail to appear, so the wait gives up and shows what it
 * has.
 */
const CEILING_MS = 6000;

function ceiling<T>(work: Promise<T>): Promise<T | null> {
  return Promise.race([
    work.catch(() => null),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), CEILING_MS)),
  ]);
}

/**
 * Fonts count as content here.
 *
 * They are requested with `display=swap`, which is the right setting to keep
 * if this wait ever times out, but it is also precisely the behaviour being
 * waited out: swap means paint in a fallback now and reflow when the real face
 * lands. `document.fonts.ready` settles once the faces the page actually uses
 * have resolved one way or the other.
 */
function fontsReady(): Promise<unknown> {
  return document.fonts?.ready ?? Promise.resolve();
}

async function boot(root: HTMLElement) {
  await ceiling(
    Promise.all([
      // Started here rather than in the components, so the request is already in
      // flight while React is still being handed its root. Both loaders hold on
      // to their promise, so the components get these for free.
      loadStarCatalog(),
      loadConstellations(),
      fontsReady(),
    ]),
  );

  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );

  /*
   * Told after the tree exists, not before. The class lifts the curtain that
   * index.html holds over the page, and a frame is allowed to pass first so
   * that what is uncovered is a painted page rather than an empty root that is
   * about to become one.
   */
  requestAnimationFrame(() => {
    requestAnimationFrame(() => document.documentElement.classList.add('is-ready'));
  });
}

boot(container);
