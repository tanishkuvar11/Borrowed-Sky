# Brief for IBM Bob: stellar populations

This is a self-contained slice of Borrowed Sky, specified to be built in [IBM Bob](https://bob.ibm.com/). Open the repository in Bob and give it this file.

Nothing else in the app depends on this landing. If it is not built, Borrowed Sky works exactly as it does today. If it is built, the app gains the one thing it currently has no way to say: not where a star is, but what kind of star it is, worked out from the catalogue rather than looked up in it.

---

## The problem to solve

Tap a star in Borrowed Sky and the dossier tells you where it is, how bright it looks, how far away it is, and its spectral class. Every one of those is a measurement about that single star, read out of the catalogue and printed.

What it cannot tell you is where that star sits among the others. Betelgeuse and Sirius are both bright points of light; one is a dying supergiant a thousand times the Sun's diameter and the other is an ordinary main sequence star eight light years away. The catalogue contains everything needed to make that distinction and the app never makes it.

This is also the one place in the project where machine learning is the honest tool rather than a worse substitute for arithmetic. Everywhere else, the answer is computable: a position comes from an ephemeris, a rise time from a numerical search, and a model that approximated either would be strictly worse than the calculation. "Which natural groups do these five thousand stars fall into" is not that kind of question. Nobody hands you the answer; it is a structure in the data, and finding structure in unlabelled data is what clustering is for.

**Build the clustering, and prove it found something real.**

---

## The astronomy, briefly

Plot stars with colour on one axis and intrinsic brightness on the other and they do not scatter evenly. They fall into a few dense regions. That plot is the Hertzsprung–Russell diagram, it is a century old, and the regions are the stages of stellar life: a long diagonal band of ordinary hydrogen-burning stars, a clump of cool luminous giants above it, and a scattering of rare supergiants above that.

The point of this task is that **the clustering must not be told any of that.** It gets two numbers per star and finds the groups itself. The check then compares what it found against the luminosity classes in the catalogue, which are never an input. If the groups it found line up with the classes it was never shown, the structure is real.

Two numbers, both derivable from what the catalogue already ships:

- **Colour index (B–V).** Field `colorIndex` in `public/data/stars.json`. Negative is hot and blue, positive is cool and red.
- **Absolute magnitude.** How bright the star would look from a standard distance, which is the only way to compare intrinsic brightness. From the apparent magnitude `m` and the distance in light years:

  ```
  parsecs = lightYears / 3.261563777
  M = m - 5 * log10(parsecs) + 5
  ```

  Lower is brighter, as with every magnitude in this app.

---

## What to build

### 1. Colour index on the runtime catalogue

`src/lib/astro/starfield.ts` parses `stars.json` into typed arrays. It keeps a `colorBucket` for the renderer, which is B–V quantised to twelve steps, and throws the real value away. Twelve steps is far too coarse to cluster on.

Add `colorIndex: Float32Array` to `StarCatalog`, parsed from field index 3, alongside the existing arrays. Do not change `colorBucket`; the renderer uses it and it is correct for what it does.

### 2. `src/lib/astro/populations.ts`

A pure module. No React, no network, no imports from `src/components`. It takes a `StarCatalog` and returns groups.

```ts
export interface StarPoint {
  index: number;        // into the catalogue arrays
  colorIndex: number;   // B-V
  absoluteMagnitude: number;
}

export interface Population {
  id: number;
  /** Centre of the group, in the same two units as the points. */
  centroid: { colorIndex: number; absoluteMagnitude: number };
  members: number[];    // catalogue indices
  /** What this region of the diagram is called. See the note on naming below. */
  name: string;
}

/** Every star with both a colour and a trustworthy distance. */
export function plottableStars(catalog: StarCatalog): StarPoint[];

/** k-means over the two features. Deterministic: same input, same output. */
export function findPopulations(points: StarPoint[], k?: number): Population[];

/** The population one star belongs to, or null if it cannot be placed. */
export function populationOf(
  populations: Population[],
  index: number,
): Population | null;
```

Requirements, in order of how badly getting them wrong would matter:

**Exclude, never impute.** HYG records an unreliable parallax as a placeholder distance, and `build-catalog.mjs` already turns those into `0`. A star with `dist_ly === 0` has no absolute magnitude and must be left out of the clustering entirely. Do not substitute a mean, a median, or a guess. This repository has one rule above all others and it is that no number on screen was invented; a star excluded from a plot is honest and a star given a fabricated distance is not. The same applies to a missing or zero colour index.

There are about 4,887 usable stars of the 5,070 in the catalogue. If your count is far from that, something is being included that should not be.

**Standardise before clustering.** B–V spans roughly −0.3 to 2.0 and absolute magnitude spans roughly −8 to +15. Euclidean distance over raw values is almost entirely a distance in magnitude, and the colour axis may as well not exist. Subtract the mean and divide by the standard deviation of each feature first, and remember to convert centroids back to real units before returning them.

**Be deterministic.** `Math.random()` for the initial centroids means the app shows a different answer on every reload and the check passes and fails at random. Use a seeded initialisation and document the choice: k-means++ driven by a small fixed-seed PRNG is the obvious one, and evenly spaced quantiles of the data would also do. Whatever you pick, running it twice on the same catalogue must give identical output.

**Default to k = 3, and let the caller override it.** Three is what the naked-eye sky supports. This is a magnitude-limited sample: it contains the intrinsically bright things from far away and only the nearby ordinary ones, so the beautiful continuous main sequence of a textbook diagram is mostly missing and asking for eight groups will invent boundaries inside noise.

**Naming.** A cluster is a set of points; calling it "red giants" is an interpretation and it must be one the code can defend. Derive each name from where its centroid falls, using a small documented table of boundaries in the two features, and put the source of those boundaries in a comment. Do not name a cluster by looking at the spectral classes of its members: those are the held-out data and using them here would make the check in section 4 circular and worthless.

### 3. Show it in the dossier

`src/components/ObjectSheet.tsx` already renders a `Spectrum` reading for stars. Add one more, only for stars and only when the star could be placed, naming the population and how it compares to the Sun on the two axes.

Compute the populations once and reuse them. This runs over roughly five thousand points and must not run on every render or every clock tick; `useMemo` keyed on the catalogue is enough, and the catalogue is loaded once for the life of the page.

If a star has no usable distance, show nothing rather than a placeholder. About one star in thirty is in that position and the honest thing is silence.

### 4. `scripts/verify/populations.check.ts`

Follow the shape of the checks already in that directory: no test framework, plain assertions, `console.log` a line per case, exit non-zero on failure, and end with `PASS` or `FAIL`. Add it to the `verify:astro` chain in `package.json`.

**This is the most important file in the task**, and the reason is worth understanding. A clustering algorithm always returns clusters. Give it noise and it will partition the noise, confidently, and every internal measure of quality will look fine. The only way to know whether it found something real is to check it against information it never saw.

It never sees the spectral class. Luminosity classes are in the `spect` field: the roman numeral after the spectral type, where `V` is a main sequence star, `III` is a giant, and `I`, `Ia`, `Ib` are supergiants. `K5III` is a giant, `M2Ib` a supergiant, `A0Vvar` a main sequence star with a note attached. Parse the numeral out; expect roughly 2,150 `III`, 1,547 `V`, 570 `IV` and about 190 supergiants across the catalogue.

Cases that must pass:

| # | Case | Expected |
|---|---|---|
| 1 | `plottableStars` on the real catalogue | around 4,887 points, none with a zero distance or a zero colour |
| 2 | Absolute magnitude of a known star | From this catalogue's distances: Sirius +1.45, Betelgeuse −5.47, Vega +0.61, each within 0.1 |
| 3 | Running `findPopulations` twice on the same input | byte-identical output |

On case 2: those are the values this catalogue's own distances give, not the ones in a reference book. Betelgeuse is published at about −5.85 because its parallax is genuinely uncertain and different sources pick different distances; HYG's figure puts it at −5.47. Assert against what the shipped data implies, or the case fails for a reason that has nothing to do with the code under test.
| 4 | Cluster sizes | no cluster holds fewer than 5% of the points; a k-means that has collapsed usually shows up here first |
| 5 | The coolest, most luminous cluster | majority of its members with a luminosity class are `III`, `II` or supergiants, not `V` |
| 6 | The cluster whose centroid is faintest | a substantially higher proportion of `V` than the giant cluster has |
| 7 | Overall agreement | across all stars carrying a luminosity class, the majority class of each star's own cluster matches its actual class for **more than 60%** of them |
| 8 | The same clustering on shuffled labels | agreement collapses to near chance, roughly a third |

Case 8 is the one that makes the rest mean anything. Shuffle the luminosity classes between stars at random, keep the clusters exactly as they are, and measure agreement again. If it stays high, the metric is measuring the shape of the class distribution rather than any correspondence, and case 7 was never evidence of anything. Sixty per cent against a third is a real signal; sixty per cent against fifty-eight is not, and only running both tells you which you have.

Print the confusion between cluster and luminosity class as a small table, so somebody reading the output can see the structure rather than take a percentage on trust.

---

## Acceptance

- `npm run typecheck` clean.
- `npx tsx scripts/verify/populations.check.ts` prints `PASS`.
- `npm run verify` still passes end to end, including `catalog.check.ts`, which guards the spectral classes this task depends on.
- `src/lib/astro/populations.ts` imports nothing from `src/components` and makes no network calls.
- The clustering runs once per page, not once per render.
- No star is given a distance, a colour or a classification it does not have in the catalogue.

## House style

Read a few existing files first, particularly `src/lib/astro/` and one or two checks in `scripts/verify/`. Comments in this repository explain *why* a decision was made, especially where the obvious approach was rejected, and they are written in prose rather than as labels. There are no em dashes anywhere in the repository; keep it that way. Prefer a named function over a clever expression.

One piece of context that is worth having. The spectral classes this task validates against were wrong until very recently: the catalogue builder trimmed them to three characters, which turned `K2III` into `K2I` and quietly reclassified three quarters of the sky. It survived because the truncation produced another valid classification rather than obvious rubbish, so it read as data. That is the failure mode this whole task is arranged against, and it is why case 8 exists.

---

## After Bob

Record what happened for the write-up, honestly: which parts Bob planned, wrote, or corrected, what it got wrong first, and what needed human judgement. The README section on Bob already does this for the grounding guard, and the account there is useful precisely because it says where Bob was wrong. A truthful account of a real collaboration is worth more than a claim of autonomy.
