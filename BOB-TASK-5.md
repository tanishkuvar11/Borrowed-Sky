# Brief for IBM Bob: let a person switch the sky model off and watch the difference

The app now carries a fitted model that decides how much of the sky a person can actually see tonight. It works, it is checked, and it is close to invisible: the only way to observe what it does is to run a headless-Chrome script that renders the same night twice.

This task puts that comparison in the app, as a control anybody can flip.

---

## What already exists

Read these first. Do not modify the first two.

- **`src/lib/astro/skyquality.ts`** is the model. `skyQuality(input)` returns `{ adjustment, localised }`, where `adjustment` is a number of magnitudes to add to a limit the caller already has. It returns exactly zero whenever the Sun is at or above -18 degrees. **Do not change this file.**
- **`src/lib/astro/solar.ts`** exposes `nakedEyeLimit(darkness, sky?)` and `skyQualityInput(site, conditions)`. The four hand-written thresholds live in `nakedEyeLimit` and are the whole answer when `sky` is absent. **Do not change the thresholds or the signatures.**
- **`src/components/SkyCanvas.tsx`** already computes the correction and applies it. Look at `eyeReach(site, conditions)`, `reachTier`, `tierAlpha`, and the `reach` argument threaded into `drawStarField`. When `reach` is `null`, the star field renders exactly as it did before the model existed. **This is the seam you need.**
- **`src/components/SettingsSheet.tsx`** has the pattern to copy: the Night vision control, a `pill` button with `aria-pressed`, an `engrave` label above it and a `provenance` paragraph under it explaining what it does.
- **`src/App.tsx`** lines 132 to 140 show how a setting is held in state, persisted to `localStorage` and passed down.

---

## What to build

A setting that turns the fitted correction off, so the chart draws every star the uncorrected limit would have drawn.

### 1. The state

In `src/App.tsx`, alongside `nightVision`:

```ts
const [skyModel, setSkyModel] = useState(
  () => localStorage.getItem('borrowed-sky:skymodel') !== 'off',
);
```

**Default on.** A person who never opens settings gets the corrected sky, which is the accurate one. Persist it the same way `nightVision` is persisted.

### 2. The wiring

Thread it to `SkyCanvas` as a prop. Inside, it must work by suppressing `reach`, not by any other route:

```ts
const reach = skyModel ? eyeReach(s.site, s.conditions) : null;
```

That single line is the whole mechanism, and it matters that it is that line. `reach === null` is already the code path the app takes outside astronomical night and when the model file fails to load, so switching the model off must land the renderer in a state it already reaches every day rather than in a new one.

**The scene cache key must include it.** Look at where the key is built, around the `moonIlluminatedFraction` line. A toggle that does not invalidate the cached scene will appear to do nothing until the clock moves, which will read as a broken control.

### 3. The control

In `SettingsSheet.tsx`, following the Night vision block exactly:

- `engrave` label: **Sky model**
- A `pill` button, `aria-pressed`, reading `Correction on` / `Correction off`
- A `provenance` paragraph underneath

The provenance line should say what the correction is and what turning it off does, in the register the rest of that sheet uses. Something close to: the chart normally allows for moonlight and local light pollution, fitted to 170,000 Globe at Night observations; switching it off draws every star the older thresholds would have shown.

Write it in your own words in the house register. Do not use the words "AI", "ML" or "machine learning" in the interface copy; the rest of the app describes what a thing does rather than what category it belongs to.

### 4. What it must not touch

The tools and the guide keep the correction regardless of this setting. `nakedEyeVisible` in `src/lib/astro/tools.ts` and the limit used in `src/lib/ai.ts` are answering questions about what a person can really see, and a display preference must not change a factual answer. **This setting governs the chart and nothing else.**

---

## The bar

Four gates. Failing any of them means it does not ship.

**Gate 1: off means genuinely off.** With the setting off, the rendered field must be identical to the field rendered when the model file is absent entirely. Not similar. Identical.

**Gate 2: on is the default and survives a reload.** Both states persist, and a first-time visitor gets the correction on.

**Gate 3: the toggle takes effect immediately.** No waiting for the next clock tick, no reload. This is the cache-key requirement above and it is the most likely thing to get wrong.

**Gate 4: nothing outside the chart changes.** The guide's "Your sky" row and the tools' visibility answers read the same with the setting on or off.

---

## Checking it

Extend `scripts/verify/skymodel.mjs` rather than writing a new script. It already launches headless Chrome, freezes the clock at a moonlit instant, seeds a site, and counts points of light in the rendered field; it also already has the control case, where `skymodel.json` is blocked at the network layer.

Add a fourth run: model file allowed to load, setting switched off. Seed the setting the same way the site is seeded, in the `Page.addScriptToEvaluateOnNewDocument` block, so it is in `localStorage` before the app boots.

Then assert **gate 1 numerically**: the point count for that run must equal the point count for the blocked-file run. Those two paths are meant to be the same path, so an approximate match is not good enough and an exact one is achievable.

Note the existing check waits for the canvas to stop resizing before measuring, and asserts that the two frames it compares had the same sample count. Keep both. They are there because an earlier version of that check compared frames of different sizes and reported two different answers for the same pair.

---

## Acceptance

- `npm run typecheck` clean.
- `npm run verify` passes end to end, all thirteen suites.
- `npm run verify:ui` passes, including your extended `skymodel.mjs` with the new run and the equality assertion.
- `src/lib/astro/skyquality.ts` and `src/lib/astro/solar.ts` are unmodified.
- The setting is absent from `src/lib/astro/tools.ts` and `src/lib/ai.ts`.

## House style

Read two or three files in `src/components/` and two checks in `scripts/verify/` before writing. Comments explain *why* a decision was made, especially where the obvious approach was rejected, and they are prose rather than labels. **There are no em dashes anywhere in this repository. Keep it that way.**

Interface copy is sentences, not labels, and never announces its own cleverness.

---

## After

Report what you changed and what the new assertion measured, including the two point counts and whether they came out exactly equal. If they did not, say so and say what the residual was rather than loosening the assertion to fit.
