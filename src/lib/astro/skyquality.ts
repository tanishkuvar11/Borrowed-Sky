/**
 * How much darker or brighter tonight's sky is than a typical dark one.
 *
 * The app decides what is visible from four hand-written magnitudes keyed on
 * the Sun. Those four are right about the biggest thing that happens to a sky
 * and say nothing about the next two: the Moon, which takes stars away while it
 * is up, and light pollution, which is the whole difference between a city and
 * a field.
 *
 * This supplies those two, from a model fitted to Globe at Night observations.
 * See scripts/build-skymodel.mjs for the fit and for the dataset bug that made
 * two earlier attempts at this fail.
 *
 * WHAT IT IS CAREFUL ABOUT, AND WHY
 *
 * It is a correction, never an answer. It returns a number of magnitudes to add
 * to a limit somebody else decided, and the caller keeps its own value when
 * this returns zero. Two earlier versions of this feature replaced the four
 * numbers outright and both broke daylight, once by claiming magnitude 4.72
 * with the Sun forty five degrees up. Nothing here can do that, because nothing
 * here produces a limit.
 *
 * It only speaks about astronomical night. The model was fitted on observations
 * with the Sun below -18 degrees and is applied only there, so it is never
 * asked about a sky it has not seen. Outside that window this returns zero and
 * the app behaves exactly as it did before the model existed.
 *
 * It says when it does not know. A place with no nearby observations gets zero
 * and `localised: false`, rather than a confident number derived from the
 * global average of somewhere else.
 */

export interface SkyQuality {
  /** Magnitudes to add to the caller's own limit. Negative takes stars away. */
  adjustment: number;
  /** False when no observations near this place, so only the Moon term applied. */
  localised: boolean;
}

const NOTHING: SkyQuality = { adjustment: 0, localised: false };

interface SkyModel {
  nightSunAltitude: number;
  gridDeg: number;
  searchDeg: number;
  globalDarkMedian: number;
  moonCoef: number;
  lpCoef: number;
  elevCoef: number;
  grid: Record<string, number>;
}

/**
 * How many magnitudes one Globe at Night chart step is worth.
 *
 * The charts are about half a magnitude apart. This is the one number here
 * that is assumed rather than fitted, and it is the reason the model produces a
 * difference instead of an absolute limit: a difference needs only the spacing
 * of the scale, where an absolute value would need to know where the scale
 * starts, and the scale does not reach daylight at all.
 *
 * Being wrong about it scales the correction rather than moving it, and the
 * clamp below bounds how far that can go.
 */
const MAGNITUDES_PER_CHART_STEP = 0.5;

/**
 * The most this may move the limit, in magnitudes, in either direction.
 *
 * A city sky and a mountain sky are genuinely more than a magnitude apart, so
 * the cap is not tight. It is here so that a bad grid cell, an extreme
 * coefficient or a wrong assumption above cannot push the app outside the range
 * it has always worked in.
 */
const MAX_ADJUSTMENT = 1.5;

let cached: Promise<SkyModel | null> | null = null;

/** Loaded once, lazily. A missing file is a silent zero, not an exception. */
export function loadSkyModel(): Promise<SkyModel | null> {
  if (!cached) {
    cached = fetch('data/skymodel.json')
      .then((res) => (res.ok ? (res.json() as Promise<SkyModel>) : null))
      .catch(() => null);
  }
  return cached;
}

let ready: SkyModel | null = null;
void loadSkyModel().then((model) => {
  ready = model;
});

/** The measured dark-sky median near a place, or null if nobody has reported one. */
function nearestMedian(model: SkyModel, latitude: number, longitude: number): number | null {
  const by = Math.floor(latitude / model.gridDeg);
  const bx = Math.floor(longitude / model.gridDeg);
  const reach = Math.ceil(model.searchDeg / model.gridDeg);

  for (let ring = 0; ring <= reach; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const hit = model.grid[`${by + dy},${bx + dx}`];
        if (hit !== undefined) return hit;
      }
    }
  }
  return null;
}

export interface SkyQualityInput {
  sunAltitudeDegrees: number;
  moonAltitudeDegrees: number;
  moonIlluminatedFraction: number;
  latitude: number;
  longitude: number;
  elevationMetres: number;
}

/**
 * Synchronous, and zero until the model has loaded.
 *
 * The sky view redraws every frame and cannot wait on a fetch. The file is
 * small and arrives in the first moments; until it does the app shows the
 * uncorrected limit, which is the same limit it showed for its whole life
 * before this existed. That is the right thing to be wrong with.
 */
export function skyQuality(input: SkyQualityInput): SkyQuality {
  const model = ready;
  if (!model) return NOTHING;

  // The one guard that matters. Outside astronomical night the model has seen
  // nothing and says nothing.
  if (input.sunAltitudeDegrees >= model.nightSunAltitude) return NOTHING;

  const moonTerm =
    input.moonAltitudeDegrees > 0
      ? input.moonIlluminatedFraction * Math.sin((input.moonAltitudeDegrees * Math.PI) / 180)
      : 0;

  const local = nearestMedian(model, input.latitude, input.longitude);
  const lightPollution = local === null ? 0 : local - model.globalDarkMedian;

  const steps =
    model.moonCoef * moonTerm +
    model.lpCoef * lightPollution +
    model.elevCoef * (input.elevationMetres / 1000);

  const magnitudes = steps * MAGNITUDES_PER_CHART_STEP;
  const clamped = Math.max(-MAX_ADJUSTMENT, Math.min(MAX_ADJUSTMENT, magnitudes));

  return { adjustment: clamped, localised: local !== null };
}

/** Exported for scripts/verify/skyquality.check.ts. */
export const _internals = { MAGNITUDES_PER_CHART_STEP, MAX_ADJUSTMENT, nearestMedian };

/** Test seam: lets the check drive the model without a network. */
export function _setModelForTesting(model: SkyModel | null): void {
  ready = model;
}
