# Brief for IBM Bob: the visibility model, again, with the clocks fixed

This is a second attempt at `BOB-TASK-3.md`. Read this file instead of that one; where they disagree, this one is right.

The first attempt was built correctly to a brief that did not know something important about the data. The model was reverted. The reason it failed has since been found, it was not a mistake in the code, and it is written down below so this attempt starts from it.

---

## What happened last time, and why it is worth doing again

The model was fitted to Globe at Night observations and reported beating the old heuristic by 47.6% on held-out data. Two things were wrong.

**The comparison was unfair.** The heuristic predicts a magnitude and the model predicts a chart number, and the two were compared by converting the heuristic with `1 + (mag - 1) * 6/5.5`, an invented mapping that put its night-time answer at chart 5.9 where the observed mean is 3.8. Most of the 47.6% was that offset.

Measured honestly, on the same held-out rows:

| predictor | held-out RMSE |
|---|---|
| a constant, the training mean | 1.646 |
| the four heuristic buckets, calibrated to training data | 1.676 |
| the fitted model | 1.518 |

A real improvement of about eight per cent. **Those are the numbers to beat.**

**And the model had no idea daylight existed.** Its fitted Sun term spanned 0.156 chart steps across the entire ninety degrees, so it placed the midday sky and the midnight sky within a twentieth of a step of each other. Wired into the app it reported a limiting magnitude of 4.72 with the Sun forty five degrees above the horizon, which would have listed several hundred stars as visible at noon.

That was explained at the time as observers self-selecting for darkness. That explanation was wrong.

---

## The actual cause: the timestamps are broken

**Do not use the `UTDate` and `UTTime` columns.** In this dataset the timezone offset has been applied in the wrong direction for a large fraction of rows. A US observer's 20:04 local appears as 14:04 UT on the same date, when an eight o'clock evening observation at UTC-6 is 02:04 UT the following day.

Measured across all 170,721 clear-sky observations with a chart reading:

| sun altitude derived from | observations that come out in daylight |
|---|---|
| the filed `UTDate` + `UTTime` | **53.1%** |
| `LocalDate` + `LocalTime`, corrected by longitude | **7.7%** |

Fifty three per cent of naked-eye star chart observations cannot have happened in daylight. Half the training set had a sun altitude that was wrong by about twelve hours, and a coefficient fitted through that noise came out at nearly zero. The Sun term was not weak. It was destroyed before fitting.

**Use `LocalDate` and `LocalTime`, and recover the instant from the longitude:**

```
UT ≈ localWallClock - longitude / 15 hours
```

This is solar time rather than civil time, so it is off by up to about half an hour where a country's timezone does not match its meridian, and further in places that keep a deliberately skewed zone. That is a known and acceptable error here: it is minutes against the twelve hours the current columns are out by, and the residual 7.7% above is what it looks like.

Drop rows where either field is missing or unparseable rather than falling back to the broken columns.

---

## What to build

Rebuild what `BOB-TASK-3.md` described, with three changes.

### 1. The timestamps, as above

This is the whole hypothesis of this attempt. Everything else follows from whether it holds.

### 2. Honest baselines, computed in the build and printed

No invented scale conversions. Compare the model against two things measured on the same held-out rows, both on the chart scale:

- **A constant**, the mean chart number of the training set.
- **The heuristic's four buckets, calibrated**, meaning each of the four Sun-altitude bands from `limitingMagnitude` in `src/lib/ai.ts` gets the mean chart number of the training observations that fall inside it. This gives the four hand-written numbers the same fair scaling the model gets, and it is the honest form of "does this beat what is already there".

Print all three, and note that last time the calibrated buckets came out at 3.69, 4.01, 4.02, 3.96, which is nearly flat. **If they are still flat after the timestamp fix, say so loudly**: it would mean the Sun genuinely carries little signal in this data even when the clocks are right, and that is a finding worth more than a model.

### 3. Split by observation date, as before

Chronological, last 15% held out. Build the light pollution grid from training rows only. That part was done correctly last time and should not change.

---

## The bar

Three gates. Failing any of them means the model does not ship.

**Gate 1: it beats the honest baselines.** Held-out RMSE below both 1.646 and 1.676, by a margin worth having.

**Gate 2: the Sun term is physically real.** The prediction at astronomical night must be at least **1.5 chart steps** darker than the prediction with the Sun on the horizon, all else equal. The previous model managed 0.156. If the fix worked this should now be comfortable; if it is not, the fix did not work.

**Gate 3: daylight is not claimed to be dark.** With the Sun above the horizon the model must predict at or near the bright extreme of the scale. Assert this directly with the Sun at +45 degrees. **The previous attempt shipped a model that failed this and the whole suite stayed green**, because the only Sun case asked that the curve be smooth and monotonic, which a flat line satisfies perfectly. Write the case that would have caught it.

---

## If gate 2 or 3 still fails

Then the data cannot speak about twilight and daylight, and the honest thing is a hybrid rather than a replacement. Build that instead:

- The four hand-written numbers keep the Sun, across the whole range. They are crude and they are right about the thing that matters most.
- The model corrects them for the Moon and for light pollution **only when the Sun is below -18 degrees**, which is the region the observations actually cover.
- Outside that region the correction is zero and the app behaves exactly as it does today.

A hybrid that improves genuine darkness and provably changes nothing in daylight is a real result and should ship. Say plainly in the code that it is a hybrid and why.

---

## Acceptance

- `npm run typecheck` clean.
- `npx tsx scripts/verify/visibility.check.ts` prints `PASS`, including all three gates.
- `npm run verify` passes end to end.
- `src/lib/astro/visibility.ts` imports nothing from `src/components` and makes no network calls at runtime.
- The `_note` in `public/data/skymodel.json` records that the model is trained on local-time-derived instants and why.
- No observation is invented and no light pollution figure is guessed for a place with no data.

## House style

Read a few existing files first, particularly `src/lib/astro/` and two or three checks in `scripts/verify/`. Comments explain *why* a decision was made, especially where the obvious approach was rejected, and they are prose rather than labels. There are no em dashes anywhere in the repository; keep it that way.

---

## After Bob

Record what happened honestly, including the held-out numbers whichever way they fall. The README's Bob section is useful precisely because it says where Bob was wrong, and this task is now also a record of a dataset whose published timestamps are unreliable, which is worth writing down for whoever uses it next.
