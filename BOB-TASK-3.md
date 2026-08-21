# Brief for IBM Bob: what you can actually see

This is a self-contained slice of Borrowed Sky, specified to be built in [IBM Bob](https://bob.ibm.com/). Open the repository in Bob and give it this file.

Read the section headed **The bar** before writing anything. This task can legitimately end in the work being deleted, and knowing that in advance changes how it should be built.

---

## The problem to solve

Borrowed Sky draws a line between what is above the horizon and what a person can actually see. That line is currently drawn by this, in `src/lib/ai.ts`:

```ts
function limitingMagnitude(darkness: string): number {
  if (darkness === 'day') return -3.5;
  if (darkness === 'civil-twilight') return 1.5;
  if (darkness === 'nautical-twilight') return 3.5;
  return 5.5;
}
```

Four numbers, chosen by hand, keyed on the Sun's altitude and nothing else. The same four are repeated in `nakedEyeVisible` in `src/lib/astro/solar.ts`.

It is wrong in ways anybody standing outside would notice. It says the same thing under a full Moon as under a new one, and the Moon is the single largest thing that happens to a night sky. It says the same thing in the middle of a city as in a field, when that difference is worth three magnitudes and more stars than everything else combined. It is a step function, so the sky goes from magnitude 3.5 to 5.5 between one second and the next.

**Build the thing that replaces it, and prove it is better.**

---

## Why this is a model and not a formula

There is no closed form for what a human eye picks out of a given sky. It depends on the sky's brightness, on how dark-adapted the eye is, on scattered moonlight, on air transparency, and on where the object is relative to the horizon. Astronomy can compute every input; the step from those inputs to "you will see it" is empirical, and it has been measured hundreds of thousands of times by people standing outside doing exactly what this app is for.

This matters because the last task given to Bob was reverted, and it is worth knowing why. It clustered stars to work out which were giants, and the answer was already written in the catalogue: the `III` in `K5III` means giant. It was machine learning applied to a lookup. **Do not repeat that here.** If at any point the answer turns out to be computable or already recorded, say so and stop, because a model that approximates something exact is strictly worse than the exact thing.

The visibility question is not that. Nobody has written it down.

---

## The data

**Globe at Night**, a citizen science project which has been collecting exactly this observation since 2006: a person outside, a star chart, and which chart matched what they could see.

Per-year CSVs, no key, linked from `https://globeatnight.org/maps-data/`. The path pattern is `https://globeatnight.org/documents/<id>/GaN<year>.csv`; the ids are not sequential, so scrape the links from that page rather than guessing. 2023 alone has 23,414 rows and about 22,000 with a usable reading.

Columns: `ID, ObsType, Latitude, Longitude, Elevation(m), LocalDate, LocalTime, UTDate, UTTime, LimitingMag, SQMReading, SQMSerial, CloudCover, Constellation, SkyComment, LocationComment, Country`.

Four things about this data that will cost you time if you find them yourself:

**`LimitingMag` is not a magnitude.** It is the number of the star chart the observer matched, an ordinal 1 to 7 where 7 is darkest. `0` means nothing was visible and `-9999` means no reading. In 2023 the distribution is 0:3575, 1:3366, 2:4346, 3:3724, 4:2560, 5:1554, 6:859, 7:330, plus 1659 at -9999.

Converting a chart number to a magnitude needs Globe at Night's own published chart values, and they differ per constellation because each constellation has its own chart set. **Find and cite that table if it exists.** If it does not, do not invent a conversion: predict the chart number itself, treat it as a sky-darkness reading on a documented 1 to 7 scale, and say in the code that this is what it is. A stated ordinal is honest; a magnitude derived from a made-up mapping is exactly the kind of thing this repository exists to refuse.

**`CloudCover` is categorical**, with values `clear`, `1/4 of sky`, `1/2 of sky`, `over 1/2 of sky`, `undefined`, and a small amount of junk. Cloud is not something the app can know in advance for a user, so it is a **training filter, not a feature**: keep the clear observations and drop the rest, so the model learns what a clear sky gives.

**`SQMReading` is a real measurement** of sky brightness from a meter, present on a minority of rows. It is not available to the app at prediction time and must not be a feature. It is useful for sanity checking the fitted relationship.

**Schema drifts across years.** Older files have fewer columns and different headings. Read the header row of each file rather than assuming positions, and skip a file that does not have what you need rather than guessing at it.

---

## What to build

### 1. `scripts/build-skymodel.mjs`

Downloads the yearly CSVs, derives the features, fits the model, and writes coefficients to `public/data/skymodel.json`. Follow the shape of `scripts/build-corpus.mjs` and `scripts/build-catalog.mjs`: it runs once, prints what it did, and commits its output.

**Derive the physical features yourself.** The repository already depends on `astronomy-engine`, and each observation carries a latitude, a longitude and a UTC timestamp, which is everything needed to compute what the sky was actually doing at that moment:

- Sun altitude in degrees. The dominant term, and the only one the current heuristic uses.
- Moon altitude in degrees, and its illuminated fraction. Together these are the second largest effect and the one the app currently ignores entirely. A full Moon high in the sky costs two magnitudes or more; a new Moon costs nothing.
- Observer elevation, from the file.

This is the part that makes the task tractable: no external service is needed for any of it, and the values are computed by the same library the rest of the app uses, so a feature at training time and a feature at prediction time cannot drift apart.

**Light pollution is the hard one, and the honest options are limited.** It is the strongest predictor after the Moon and there is no way to compute it. Do not ship a guess. Pick one and document the choice:

- Derive a spatial term from Globe at Night itself. With hundreds of thousands of observations, the median reading near a coordinate under dark-Moon conditions is an empirical measure of how bright that place's sky is. This is self contained and uses data already downloaded, and its weakness is coverage: the observations cluster heavily in North America and Europe, and a user somewhere with no nearby readings must get a stated fallback rather than a confident wrong answer.
- Or a public domain nighttime lights raster, if you can find one that can be sampled per coordinate without shipping hundreds of megabytes.

Whichever you choose, the model must behave sensibly when the term is unavailable, and the app must be able to tell that it was unavailable.

**Keep the model small enough to ship as numbers.** This runs in a browser on a phone. A linear or additive model with a few interaction terms, or a small gradient boosted ensemble, is the right size; anything that needs a runtime library is not. `public/data/skymodel.json` should be coefficients, not a serialised framework.

### 2. `src/lib/astro/visibility.ts`

A pure module. No React, no network, no imports from `src/components`.

```ts
export interface SkyPrediction {
  /** The faintest thing visible, in magnitudes, or the chart number if that is what the model predicts. */
  limit: number;
  /** What the number means, so callers cannot mistake a chart number for a magnitude. */
  scale: 'magnitude' | 'globe-at-night-chart';
  /** False when the location has no light pollution term, so the answer is a general one. */
  localised: boolean;
}

export function predictVisibility(options: {
  sunAltitudeDegrees: number;
  moonAltitudeDegrees: number;
  moonIlluminatedFraction: number;
  latitude: number;
  longitude: number;
  elevationMetres: number;
}): SkyPrediction;
```

Load the coefficients the way `src/lib/corpus.ts` loads the corpus: once, lazily, and degrading to a stated failure rather than an exception if the file is missing.

### 3. Replace the four hand-written numbers

`limitingMagnitude` in `src/lib/ai.ts` and the same four values inside `nakedEyeVisible` in `src/lib/astro/solar.ts` both become calls into the new module. They are the same rule written twice and should not stay that way.

Where the interface currently says something is or is not visible, it can now say why: under this Moon, from this place. Keep that to a phrase. This app has enough panels.

### 4. `scripts/verify/visibility.check.ts`

Follow the existing checks: no test framework, plain assertions, a line per case, non-zero exit on failure, and added to the `verify:astro` chain in `package.json`.

Hold out a test set the fitting never sees. Split by **observation date**, not at random: adjacent rows in these files are often the same observer on the same night, and a random split puts near-duplicates on both sides and reports an accuracy the model does not have.

Cases:

| # | Case | Expected |
|---|---|---|
| 1 | Held-out error against the current four-number heuristic | **the model is better, by a margin worth having** |
| 2 | Full Moon high versus new Moon, all else equal | the prediction is at least a magnitude darker under the full Moon |
| 3 | Sun altitude swept from -30 to 0 degrees | the prediction changes smoothly and never goes backwards |
| 4 | A location with no nearby observations | `localised: false`, and a sane general answer rather than an extreme one |
| 5 | Coefficients are finite and bounded | no NaN, no infinity, predictions inside a physically sensible range |
| 6 | Two runs of the build on the same input | identical coefficients |

Print the held-out error of both the model and the heuristic side by side, so a reader sees the comparison rather than a claim.

---

## The bar

**Case 1 is the whole task.** If the model does not beat four hand-written numbers on held-out real observations, the model does not ship, and the right outcome is to delete it and leave the heuristic alone with a comment recording what was tried and what the numbers were.

That is a real possible result and not a failure of the work. The step function is crude but it is not stupid: Sun altitude genuinely is the dominant term, and a model that adds the Moon and the location should beat it comfortably. If it does not, that is worth knowing and worth writing down.

Report the comparison honestly whichever way it goes. An accurate account of a model that did not earn its place is more useful to this project than a model that quietly did not.

---

## Acceptance

- `npm run typecheck` clean.
- `npx tsx scripts/verify/visibility.check.ts` prints `PASS`, including case 1.
- `npm run verify` passes end to end.
- `src/lib/astro/visibility.ts` imports nothing from `src/components` and makes no network calls at runtime.
- No observation is invented, no magnitude is derived from a mapping that was not sourced, and no light pollution figure is guessed for a place with no data.
- The four hand-written magnitudes exist in one place or in none, not in two.

## House style

Read a few existing files first, particularly `src/lib/astro/` and two or three checks in `scripts/verify/`. Comments in this repository explain *why* a decision was made, especially where the obvious approach was rejected, and they are written in prose rather than as labels. There are no em dashes anywhere in the repository; keep it that way. Prefer a named function over a clever expression.

---

## After Bob

Record what happened for the write-up, honestly: what Bob planned, what it wrote, what it got wrong first, and what needed human judgement. Include the held-out numbers whether or not they were flattering. The README section on Bob is useful precisely because it says where Bob was wrong, and a task that was allowed to end in deletion is worth more as a record than one that was always going to ship.
