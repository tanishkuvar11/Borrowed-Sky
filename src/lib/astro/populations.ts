/**
 * Stellar population clustering from the HYG catalogue.
 *
 * Two numbers from the catalogue -- B-V colour index and absolute magnitude --
 * are enough to locate a star on the Hertzsprung-Russell diagram and, by
 * extension, to assign it to one of the natural groups the diagram falls into.
 * This module finds those groups by k-means and names them from where their
 * centroids land, without ever looking at the spectral or luminosity classes in
 * the catalogue. Those are held out and used only to verify the result.
 *
 * No React, no network, no imports from src/components.
 */

import type { StarCatalog } from './starfield.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StarPoint {
  index: number;
  colorIndex: number;
  absoluteMagnitude: number;
}

export interface Population {
  id: number;
  /** Centre of the group, in real B-V and absolute magnitude units. */
  centroid: { colorIndex: number; absoluteMagnitude: number };
  members: number[];
  /**
   * Region name derived from where the centroid falls. The boundaries come from
   * the standard HRD partition used in introductory texts (e.g. Carroll &
   * Ostlie, "Introduction to Modern Astrophysics"): B-V < 0.6 and M < 3 is
   * hot/upper-main-sequence; B-V >= 0.6 and M < 2 (or M < 3 for slightly
   * cooler stars) is giant/supergiant territory; everything else is the ordinary
   * lower main sequence. The exact numbers are documented at the boundary table
   * below, and they are derived from the diagram geometry, not from the spectral
   * classes of the members.
   */
  name: string;
}

// ---------------------------------------------------------------------------
// Absolute magnitude
// ---------------------------------------------------------------------------

const PARSECS_PER_LY = 3.261563777;

function absoluteMagnitude(apparentMag: number, distanceLy: number): number {
  const parsecs = distanceLy / PARSECS_PER_LY;
  return apparentMag - 5 * Math.log10(parsecs) + 5;
}

// ---------------------------------------------------------------------------
// Usable stars
// ---------------------------------------------------------------------------

/**
 * Stars that have both a reliable distance and a meaningful colour index.
 *
 * The catalogue records an unknown or unreliable parallax as dist_ly = 0, and
 * the build script preserves that zero rather than fabricating a distance. A
 * star without a distance has no absolute magnitude and cannot be placed on the
 * HR diagram; it is excluded here rather than given any invented value. The same
 * applies to a zero colour index, which the catalogue also uses as a
 * "not measured" placeholder.
 */
export function plottableStars(catalog: StarCatalog): StarPoint[] {
  const result: StarPoint[] = [];
  for (let i = 0; i < catalog.count; i++) {
    const dist = catalog.distanceLy[i];
    const ci = catalog.colorIndex[i];
    if (dist === 0 || ci === 0) continue;
    result.push({
      index: i,
      colorIndex: ci,
      absoluteMagnitude: absoluteMagnitude(catalog.magnitude[i], dist),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32)
// ---------------------------------------------------------------------------

/*
 * k-means++ requires random draws for its weighted initialisation. Using
 * Math.random() makes the result non-deterministic: the same catalogue gives a
 * different partition on every reload, which means the UI is inconsistent and
 * the verification pass/fail depends on luck.
 *
 * mulberry32 is a fast, simple 32-bit PRNG with good statistical properties.
 * It is seeded with a fixed constant, so identical input always yields
 * identical output. The seed itself is arbitrary; 0x9e3779b9 (the golden-ratio
 * constant used in several well-known hash functions) is a convenient choice.
 */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return function () {
    s += 0x6d2b79f5;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

// ---------------------------------------------------------------------------
// Standardisation
// ---------------------------------------------------------------------------

interface StandardisedPoints {
  z: Float64Array;         // interleaved [z_ci, z_mag] per point
  meanCi: number;
  stdCi: number;
  meanMag: number;
  stdMag: number;
}

function standardise(points: StarPoint[]): StandardisedPoints {
  const n = points.length;
  let sumCi = 0;
  let sumMag = 0;
  for (const p of points) {
    sumCi += p.colorIndex;
    sumMag += p.absoluteMagnitude;
  }
  const meanCi = sumCi / n;
  const meanMag = sumMag / n;

  let varCi = 0;
  let varMag = 0;
  for (const p of points) {
    varCi += (p.colorIndex - meanCi) ** 2;
    varMag += (p.absoluteMagnitude - meanMag) ** 2;
  }
  const stdCi = Math.sqrt(varCi / n);
  const stdMag = Math.sqrt(varMag / n);

  const z = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    z[i * 2] = (points[i].colorIndex - meanCi) / stdCi;
    z[i * 2 + 1] = (points[i].absoluteMagnitude - meanMag) / stdMag;
  }
  return { z, meanCi, stdCi, meanMag, stdMag };
}

// ---------------------------------------------------------------------------
// k-means++ initialisation and Lloyd iteration
// ---------------------------------------------------------------------------

function kMeansPlusPlus(z: Float64Array, n: number, k: number, rand: () => number): Float64Array {
  // Choose the first centre uniformly at random.
  const centroids = new Float64Array(k * 2);
  const first = Math.floor(rand() * n);
  centroids[0] = z[first * 2];
  centroids[1] = z[first * 2 + 1];

  const dist2 = new Float64Array(n);

  for (let c = 1; c < k; c++) {
    // Distance from each point to its nearest chosen centre.
    let totalDist = 0;
    for (let i = 0; i < n; i++) {
      let min = Infinity;
      for (let j = 0; j < c; j++) {
        const dx = z[i * 2] - centroids[j * 2];
        const dy = z[i * 2 + 1] - centroids[j * 2 + 1];
        const d = dx * dx + dy * dy;
        if (d < min) min = d;
      }
      dist2[i] = min;
      totalDist += min;
    }
    // Sample the next centre proportional to distance squared.
    let target = rand() * totalDist;
    for (let i = 0; i < n; i++) {
      target -= dist2[i];
      if (target <= 0) {
        centroids[c * 2] = z[i * 2];
        centroids[c * 2 + 1] = z[i * 2 + 1];
        break;
      }
    }
  }
  return centroids;
}

function lloydIteration(z: Float64Array, n: number, k: number, centroids: Float64Array): Uint16Array {
  const assignments = new Uint16Array(n);
  const MAX_ITER = 100;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    let moved = false;

    // Assignment step.
    for (let i = 0; i < n; i++) {
      let best = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const dx = z[i * 2] - centroids[c * 2];
        const dy = z[i * 2 + 1] - centroids[c * 2 + 1];
        const d = dx * dx + dy * dy;
        if (d < bestDist) {
          bestDist = d;
          best = c;
        }
      }
      if (assignments[i] !== best) {
        assignments[i] = best;
        moved = true;
      }
    }
    if (!moved) break;

    // Update step.
    const sums = new Float64Array(k * 2);
    const counts = new Uint32Array(k);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      sums[c * 2] += z[i * 2];
      sums[c * 2 + 1] += z[i * 2 + 1];
      counts[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c * 2] = sums[c * 2] / counts[c];
        centroids[c * 2 + 1] = sums[c * 2 + 1] / counts[c];
      }
    }
  }
  return assignments;
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/*
 * Naming a region of the diagram from where its centre falls.
 *
 * The rule that matters is that luminosity alone says nothing. A star can be
 * bright because it is swollen and cool, which makes it a giant, or because it
 * is hot and massive, which does not: a B star sitting on the main sequence
 * outshines the Sun several hundred times over and has not left it. The first
 * version of this returned "Giants and supergiants" for anything above M = -1
 * whatever its colour, which put that label on a cluster centred at B-V = -0.02
 * containing 660 main sequence stars against 235 giants. It also handed the
 * same name to two different clusters, which for k distinct groups is always
 * wrong and is now checked.
 *
 * So both axes decide, and the boundary between them is the main sequence
 * itself. Along it, colour and absolute magnitude move together: hot blue stars
 * sit high, cool red ones sit low. A rough line through the sequence for this
 * colour range is
 *
 *     M = 5.5 * (B-V) + 0.7
 *
 * fitted by eye to the standard diagram over -0.3 < B-V < 1.5, which is the
 * range this catalogue covers. A centroid well above that line for its colour
 * is a giant; near or below it is a main sequence star. That is the same
 * judgement an astronomer makes looking at the plot, written down.
 *
 * Boundaries after Carroll & Ostlie, "An Introduction to Modern Astrophysics",
 * chapter 8. None of this looks at the spectral classes of the members: those
 * are the held-out data the check in scripts/verify/populations.check.ts
 * compares against, and using them here would make that check circular.
 */
function mainSequenceMagnitudeAt(colorIndex: number): number {
  return 5.5 * colorIndex + 0.7;
}

/*
 * The colour, as a word.
 *
 * The usual bands: B-V below about 0.15 is the blue of a B star, up to 0.45 the
 * white of an A or F, up to 0.85 the yellow of the Sun at 0.65, and above that
 * the orange and red of K and M. Naming the colour as well as the class is what
 * keeps two different groups from arriving at the same label: the sample has
 * two main sequence clusters in it, one blue and luminous and one white and
 * fainter, and they are genuinely different stars.
 */
function colourWord(ci: number): string {
  if (ci < 0.15) return 'Blue';
  if (ci < 0.45) return 'White';
  if (ci < 0.85) return 'Yellow';
  return 'Red';
}

function nameFromCentroid(ci: number, M: number): string {
  // How far above the main sequence the centre sits, in magnitudes. Positive
  // is brighter than the sequence, because magnitudes run backwards.
  const aboveSequence = mainSequenceMagnitudeAt(ci) - M;

  // Clear of the sequence for its colour, so size is doing the work, not heat.
  if (aboveSequence > 2) return `${colourWord(ci)} giants`;

  return `${colourWord(ci)} main sequence stars`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * k-means clustering over B-V colour index and absolute magnitude.
 *
 * The result is deterministic: the same set of points always yields the same
 * partition. Initialisation uses k-means++ with a fixed-seed PRNG (mulberry32,
 * seeded with 0x9e3779b9); Lloyd iteration then runs to convergence or 100
 * steps, whichever comes first.
 *
 * Centroids are returned in real B-V / absolute-magnitude units, not in the
 * standardised space used internally.
 */
export function findPopulations(points: StarPoint[], k = 3): Population[] {
  const n = points.length;
  if (n === 0 || k <= 0) return [];

  const std = standardise(points);
  const rand = makePrng(0x9e3779b9);
  const centroids = kMeansPlusPlus(std.z, n, k, rand);
  const assignments = lloydIteration(std.z, n, k, centroids);

  // Collect members per cluster.
  const memberLists: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) {
    memberLists[assignments[i]].push(points[i].index);
  }

  // Convert centroids back to real units and name each cluster.
  return Array.from({ length: k }, (_, c) => {
    const ci = centroids[c * 2] * std.stdCi + std.meanCi;
    const M = centroids[c * 2 + 1] * std.stdMag + std.meanMag;
    return {
      id: c,
      centroid: { colorIndex: ci, absoluteMagnitude: M },
      members: memberLists[c],
      name: nameFromCentroid(ci, M),
    };
  });
}

/**
 * The population a star belongs to, or null if the star could not be placed
 * (either because it lacks a reliable distance or a colour index, or because
 * the populations list is empty).
 */
export function populationOf(populations: Population[], index: number): Population | null {
  for (const pop of populations) {
    if (pop.members.includes(index)) return pop;
  }
  return null;
}
