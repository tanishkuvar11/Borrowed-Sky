# Engineering log: what was built with IBM Bob, and what went wrong

This is the long version, kept out of the README because it is a development
record rather than a description of the project. It is here because the useful
part of an agentic-development story is not that an agent wrote some code; it is
where the agent was wrong, how that was caught, and what the failure taught.

Three tasks were handed to [IBM Bob](https://bob.ibm.com/). One shipped as
written. One shipped after correction. One failed twice and was rebuilt outside Bob,
and the reason it failed turned out to be a bug in a published scientific
dataset rather than anything about the agent.

For the summary that appears in the README, see
[Built with IBM Bob](../README.md#built-with-ibm-bob).

---

## The three tasks

One piece of this project is owned end to end by [IBM Bob](https://bob.ibm.com/): **the grounding guard**, the check that compares each of Granite's answers against the JSON it was given and refuses to show one that makes a claim the computed sky does not support.

It was chosen deliberately. Every other data path here is verified by something that shares no code with the thing it verifies, which is why the coordinate transforms and the orbital propagation can be trusted rather than merely believed. The narration path is the exception: the model is told not to invent, and nothing checks that it obeyed. Closing that gap is the most valuable single piece of work left in the repository, and it is also cleanly separable, which is what makes it a fair test of a coding agent rather than a demonstration arranged to succeed.

The brief handed to Bob was written before any of the work started: the module signature, the three classes of claim to check, the tolerance rule, the retry behaviour, eight test cases, and the constraint that its tests compute a real sky rather than fabricating one.

### How it went (BOB-TASK: the grounding guard)

Bob planned before it wrote, and the plan was good. It read the files the brief pointed at, restated the three constraints most likely to be missed, and proposed a structure close to the one that shipped. Two things it decided on its own were better than the brief: excluding `observedAt` from the number pool, because scanning digits out of an ISO timestamp injects 2026, 08, 18 and gives false claims accidental cover, and stating in a comment that the number check pools every value regardless of what it measures, so `magnitude 47` passes if some object happens to sit at 47 degrees altitude. That weakness is real and the code now says so rather than reading as though the check were tighter than it is.

Three things were caught and fixed, and they are worth recording because two of them were the same mistake.

**A `require()` in an ES module.** The first version loaded the star names through a dynamic `require`, which is not defined under the ESM compilation this repo uses. It failed, the surrounding `catch` swallowed it, and the star list was silently empty. The test that should have caught it passed, because an empty list flags nothing. Bob found this one itself.

**The tolerance test was altitude dependent.** The brief asked for a case proving that a rounded value still passes. Rounding to the nearest 5 degrees does not clear a 5 percent window at low altitude: at 13 degrees, 5 percent is 0.65, and a 2.5 degree rounding error fails. Bob spotted that the test would pass or fail depending on where the Moon happened to be that evening, and rounded to the nearest whole degree instead, which sits inside the 0.5 degree absolute floor at any altitude.

**The star check disabled itself in production.** This was the serious one, and it was the same failure as the first: read the catalogue from disk, wrap it in a `catch`, carry on with an empty list. It worked locally and every test passed. On Vercel it would not have, because `public/` is uploaded as static assets and is not on a serverless function's filesystem, so the check that catches invented star names would have reported success on every answer. Running `checkGrounding` in a directory with no `public/` returns `ok: true` for "look for Betelgeuse". The fix was to stop reading and start generating: `scripts/build-catalog.mjs` now emits `api/_lib/star-names.ts` alongside the catalogues, `grounding.ts` imports it statically, and the swallowing `catch` is gone, so an absent list is now a loud startup failure rather than a quiet no-op.

The pattern across all three is one thing: a fallback that hides a disabled check reads as robustness and behaves as a silent hole. Bob wrote clean, well commented, correctly structured code and was reliably wrong in that one direction. Every correction came from asking what happens when this fails, not from reading the code as written.

### How it went (BOB-TASK-3 and BOB-TASK-4: the sky visibility model)

Two more tasks were given to Bob, and both are recorded here because the first one failed in a way worth understanding, and the second one fixed it honestly.

**BOB-TASK-3: the first attempt.** The brief asked Bob to replace the four hand-written Sun-altitude buckets in `limitingMagnitude` with a model fitted to Globe at Night citizen-science observations: 170,000 people standing outside since 2006 reporting which star chart matched what they could see. Bob built it correctly. The model learned a Moon term and a light pollution term, neither of which the buckets had, and on held-out data it reported 47.6% improvement over the heuristic. That number was wrong, because the comparison used an invented chart-to-magnitude mapping that put the heuristic's night-time answer at chart 5.9 when the observed mean was 3.8. Measured honestly, the improvement was eight per cent. That is real. The model was still reverted.

The reason it was reverted was not the scale error. It was that the fitted Sun term came out at 0.156 chart steps across the entire ninety degrees, so the model put the midday sky and the midnight sky within a twentieth of a step of each other. Applied in the app it reported a limiting magnitude of 4.72 with the Sun forty-five degrees above the horizon, which would have listed several hundred stars as visible at noon. The diagnosis at the time was observer self-selection: people only go outside when it is dark. That was wrong.

**The actual cause: broken timestamps.** The Globe at Night dataset publishes UTDate and UTTime columns, but the timezone offset has been applied in the wrong direction for a large fraction of rows. A US observer at UTC-6 whose local observation time was 20:04 appears as 14:04 UT on the same date, when the correct value is 02:04 UT the next day. Measured across all clear-sky observations with a chart reading, **53.1% of rows derived a Sun altitude placing the observation in daylight** when the published UT columns were used. Using LocalDate and LocalTime shifted by longitude/15 hours (solar time rather than civil time) dropped that fraction to **7.7%**. Half the training set had a Sun altitude that was wrong by about twelve hours, and a coefficient fitted through that noise came out near zero.

**BOB-TASK-4: the second attempt.** The brief described the timestamp bug in full and asked Bob to rebuild the model from LocalDate and LocalTime, compare it against two honest baselines, and clear three gates: beat both baselines, a Sun term worth at least 1.5 chart steps, and daylight predicting a bright sky.

With the timestamps fixed the daylight fraction fell from 53.1% to 4.0% and the model beat both baselines by about five per cent, held-out RMSE 1.547 against 1.634 for a constant and 1.630 for the calibrated heuristic. Gate 1 passed. Gates 2 and 3 did not, and Bob reported that plainly rather than moving the thresholds, which is the right behaviour and worth saying.

The brief specified a hybrid for exactly that outcome: keep the four hand-written numbers for the Sun across the whole range, and let the model correct only below -18 degrees where the observations actually are. Bob built the hybrid, the suite went green, and it was reverted too.

Two things were wrong with it. The four numbers were not kept: routing them through the chart scale moved daylight from magnitude -3.5 to +1.0, which lists Sirius, Vega, Arcturus and thirteen other first-magnitude stars as visible at noon. The Globe at Night scale only spans night skies, so daylight has no place on it and mapping it there floors at magnitude 1. And the model correction, the entire point of the hybrid, was never wired in: `solar.ts` imported the scale conversion and nothing called `predictVisibilitySync`, so the fitted light pollution and Moon terms were dead code. The net effect of the task was a regression plus an unused model.

So the feature failed twice, for two unrelated reasons: a dataset whose published timestamps have the sign of the offset inverted, and a conversion that quietly redefined daylight.

### What finally shipped, and the one change that made it work

The third attempt was written outside Bob, and it differs from the two before it in one respect. Both earlier versions promised in prose that they would not touch daylight, and both broke it anyway. This one cannot break it, because it never produces a limiting magnitude at all.

`src/lib/astro/skyquality.ts` returns a **difference in magnitudes** to add to a limit somebody else decided. The four hand-written numbers in `limitingMagnitude` are untouched, no scale conversion exists anywhere in the path, and above -18 degrees the function returns exactly zero, so the code that runs in daylight is byte-identical to the code that ran before the model existed. The Globe at Night scale describes night skies, so the model is only ever asked about night skies.

That reframing is also what makes the arithmetic honest. A difference needs only the spacing of the chart scale, about half a magnitude per step, which is the single assumed number in the module. An absolute value would need to know where the scale starts, and the scale does not reach daylight to start anywhere.

The fit lives in `scripts/build-skymodel.mjs`: ordinary least squares on 121,998 training observations, held out chronologically on the last 21,530, and restricted before fitting to rows with the Sun below -18 degrees so extrapolation into twilight is not merely discouraged but impossible. The light pollution grid is built from training rows only. What it learned, in chart steps:

| term | effect |
|---|---|
| a full Moon overhead | 0.794 steps darker |
| each step of local dark-sky median | 0.737 |
| each kilometre of elevation | 0.141 |

Held-out RMSE 1.4977 against 1.6327 for a constant, an improvement of 8.3%. Both of those numbers are on the chart scale with nothing converted.

In the app it is worth up to about 0.7 magnitudes: a full Moon overhead takes away a star of magnitude 5.2 that a moonless sky from the same place would have shown you, and a city gets a shorter list than a field. A place with no observations nearby reports `localised: false` and applies no light pollution term rather than borrowing the global average, and if `skymodel.json` fails to load the correction is zero and the app is what it always was.

`scripts/verify/skyquality.check.ts` is written against the failures rather than the feature. Its first cases assert that Sirius is not visible at noon, and that for every brightness from magnitude -5 to +7 at seven Sun altitudes above -18, asking with the model gives an identical answer to asking without it. That case is what both earlier versions would have gone red on.

### What survives regardless

The dataset finding is worth more than the feature. The Globe at Night export files a US observer's 20:04 local as 14:04 UT on the same date, when an eight o'clock evening observation at UTC-6 is 02:04 UT the following day. Derive a Sun altitude from those columns and 53.1% of naked-eye star chart observations land in daylight, which cannot happen; derive it from the local clock and the longitude and it falls to 7.7%. Anyone fitting anything to that dataset needs to know this.

---
