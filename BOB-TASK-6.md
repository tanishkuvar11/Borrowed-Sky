# Brief for IBM Bob: open the app at a chosen moment, and say so

Everything this app shows is computed for right now. That is the right default and it makes one thing awkward: there is no way to show somebody a sky that is not the current one. Demonstrating the Moon washing out faint stars means waiting for a night with a Moon in it, and explaining a satellite pass means waiting for the pass.

This task adds a way to open the app at a stated moment, and, just as importantly, to make sure nobody can mistake that for now.

---

## What already exists

- **`src/hooks/useSkyData.ts`** holds the clock. Line 56 is `const [now, setNow] = useState(() => new Date())` and the effect at line 120 replaces it every `POSITION_REFRESH_MS`. **Everything downstream hangs off that one value**: positions, the timeline, satellite passes, the conditions the sky model reads. Change it and the whole app moves together, which is what makes this task small.
- **`src/components/Diagnostics.tsx`** is the pattern for a URL-triggered mode. `diagnosticsRequested()` reads `new URLSearchParams(window.location.search).has('diag')`, and nothing in the app has to be modified to be observed. Follow that shape.
- **`src/components/SettingsSheet.tsx`** shows the house register for controls and their `provenance` copy.

---

## What to build

### 1. Reading the moment

A helper alongside the `diagnosticsRequested` pattern, in its own small module under `src/lib/`:

```ts
/** The instant the URL asks for, or null for the ordinary live clock. */
export function requestedInstant(): Date | null;
```

It reads `?at=` from the query string and accepts an ISO 8601 instant, for example `?at=2026-09-27T19:40:51Z`.

**It must return null, not throw and not guess, for anything it cannot read.** An unparseable value, an empty value, a date outside a sane range, or no parameter at all all mean the same thing: run the live clock. A demo link with a typo in it must degrade to the ordinary app rather than to a blank screen or to 1970.

### 2. Freezing the clock

In `useSkyData`, initialise `now` from `requestedInstant()` when it returns something, and **do not start the interval in that case**. The whole app then computes for that instant and holds there.

Read the parameter **once**, at mount. Do not re-read it on every tick.

### 3. Saying so, which is the part that matters

This app's stated principle is that nothing is fabricated. An app showing a sky from three weeks hence, with no indication, while a person stands outside looking at a different one, breaks that principle more thoroughly than any wrong number would.

So a frozen clock must be visible and escapable:

- A **persistent marker** while the mode is active. Not a toast that fades. Somewhere it stays legible, in the register the rest of the interface uses.
- It must **name the moment being shown**, in the observer's own timezone, in the same format the app uses for times elsewhere.
- It must offer **one action back to the live sky**, which clears the parameter and resumes the interval without a full reload if that is straightforward, and with one if it is not.

Wording is yours. It should read as an instrument being held at a setting, not as an error and not as a warning. Do not use the words "demo", "debug" or "test": this is a feature a curious person may reasonably use to look at a meteor shower next week.

### 4. What it must not do

- **No effect whatsoever when `?at=` is absent.** The live path must be byte-identical to today's.
- **It must not be persisted.** No `localStorage`, no carrying across a reload of a clean URL. The parameter is the whole state, so a link is shareable and a plain visit is always live.
- **It must not touch the location.** Where the observer is stays exactly as it was.

---

## The bar

**Gate 1: absent means unchanged.** With no parameter, the clock ticks as it does today and nothing new renders.

**Gate 2: present means frozen, everywhere.** With `?at=` set, the sky, the timeline, the conditions and the sky model's correction all compute for that instant, and the clock does not advance.

**Gate 3: it is impossible to miss.** The marker is present and names the moment. A screenshot of the app in this mode must be self-evidently not-now to somebody who did not type the URL.

**Gate 4: bad input is harmless.** `?at=`, `?at=tomorrow`, `?at=99999999999999` and `?at=2026-13-45T99:99Z` all fall back to the live clock with the ordinary interface.

---

## Checking it

Add `scripts/verify/instant.check.ts` for the parser, in the style of the existing checks in `scripts/verify/`. Plain assertions, no test framework. Cover the accepted form, each of the four bad inputs above, and the absent case.

Then extend `scripts/verify/skymodel.mjs`. It currently freezes the clock by overwriting `window.Date` before the app boots, which works but is a blunt instrument. **Add one run that uses `?at=` instead of the Date override, and assert it lands on the same point count as the equivalent overridden run.** Two routes to the same instant should produce the same sky, and if they do not, one of them is wrong.

Do not remove the Date override from the other runs.

---

## Acceptance

- `npm run typecheck` clean.
- `npm run verify` passes end to end, including your new `instant.check.ts` added to the `verify:astro` chain in `package.json`.
- `npm run verify:ui` passes, including the extended `skymodel.mjs` and its new equality assertion.
- With no `?at=` parameter the app is unchanged in behaviour and appearance.

## House style

Read two or three files in `src/lib/` and two checks in `scripts/verify/` first. Comments explain *why* a decision was made, especially where the obvious approach was rejected, and they are prose rather than labels. **There are no em dashes anywhere in this repository. Keep it that way.**

---

## After

Report what you changed, the wording you chose for the marker and why, and the two point counts from the new equality assertion. If the two routes to the same instant did not agree, say so and say by how much rather than loosening the assertion.
