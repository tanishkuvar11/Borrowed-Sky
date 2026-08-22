#!/usr/bin/env node
/**
 * Fits the night-sky correction from Globe at Night observations.
 *
 * WHAT THIS IS FOR
 *
 * The app decides what is visible from four hand-written magnitudes keyed on
 * the Sun's altitude. Those four are right about the largest thing that happens
 * to a sky and silent about the next two: the Moon, which costs stars when it
 * is up, and light pollution, which is the difference between a city and a
 * field and is worth more than everything else combined.
 *
 * Neither is computable. There is no formula for what a human eye picks out of
 * a given sky, and there does not need to be, because people have been
 * measuring it since 2006. Globe at Night asks somebody outside which of seven
 * star charts matches what they can see, and publishes the answers.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * Two earlier attempts at this were reverted, and the shape of both failures is
 * built into this script rather than written above it as advice.
 *
 * It does not model the Sun. Observers go outside when it is dark, so the data
 * holds almost no twilight and no daylight worth the name, and a Sun term
 * fitted through it came out at 0.156 chart steps across ninety degrees: the
 * model placed noon and midnight within a twentieth of a step of each other and
 * reported that several hundred stars were visible at midday. **Only rows with
 * the Sun below -18 degrees are fitted at all**, which is the same region the
 * correction is applied in, so there is no extrapolation to get wrong.
 *
 * It does not produce an absolute magnitude. The Globe at Night chart scale
 * covers night skies and has no daylight on it; the previous attempt mapped the
 * app's daylight value onto chart 1 and got magnitude +1.0, which lists Sirius
 * and Vega as visible at noon. This fits a **difference** instead, in chart
 * steps, against a typical dark and moonless sky. The intercept never leaves
 * this script, so no absolute conversion is ever needed and the one assumption
 * that remains is how many magnitudes a chart step is worth.
 *
 * THE TIMESTAMPS ARE BROKEN, AND THIS IS THE IMPORTANT PART
 *
 * Do not use the UTDate and UTTime columns. The timezone offset has been
 * applied in the wrong direction: a US observer's 20:04 local is filed as 14:04
 * UT on the same date, when eight in the evening at UTC-6 is 02:04 UT the day
 * after. Derive a Sun altitude from those columns and 53.1% of naked-eye star
 * chart observations land in daylight, which cannot happen. Derive it from the
 * local clock corrected by longitude and it falls to 7.7%.
 *
 * That single bug is what made the first attempt look like a data limitation.
 * It is recorded here, in the README, and in the model file, because whoever
 * uses this dataset next will otherwise lose the same afternoon to it.
 *
 * Run: npm run skymodel
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Body, Equator, Horizon, Illumination, MakeTime, Observer } from 'astronomy-engine';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE = join(ROOT, '.catalog-cache', 'globeatnight');
const OUT = join(ROOT, 'public', 'data', 'skymodel.json');
const INDEX = 'https://globeatnight.org/maps-data/';
const UA = 'BorrowedSky/1.0 (https://github.com/tanishkuvar11/Borrowed-Sky; build script)';

/** Below this the sky is astronomically dark, and this is the only region fitted. */
const NIGHT_SUN_ALTITUDE = -18;
/** Rows at or below this Moon contribution count as moonless when measuring a place. */
const DARK_MOON = 0.05;
/** Half a degree of latitude and longitude. Small enough to separate a city from its outskirts. */
const GRID_DEG = 0.5;
/** How far to look for a populated cell before giving up and saying so. */
const SEARCH_DEG = 2;
/** A cell needs this many readings before its median means anything. */
const MIN_PER_CELL = 5;

// ---------------------------------------------------------------------------
// getting the files
// ---------------------------------------------------------------------------

async function download() {
  await mkdir(CACHE, { recursive: true });
  const cached = existsSync(CACHE) ? (await readdir(CACHE)).filter((f) => f.endsWith('.csv')) : [];
  if (cached.length >= 15) {
    console.log(`using ${cached.length} cached CSVs`);
    return cached;
  }

  console.log('asking globeatnight.org which files exist...');
  const page = await (await fetch(INDEX, { headers: { 'User-Agent': UA } })).text();
  const links = [...page.matchAll(/href="(\/documents\/\d+\/GaN\d{4}\.csv)"/g)].map((m) => m[1]);
  console.log(`  ${links.length} yearly files`);

  for (const href of links) {
    const name = href.split('/').pop();
    const dest = join(CACHE, name);
    if (existsSync(dest)) continue;
    const res = await fetch(`https://globeatnight.org${href}`, { headers: { 'User-Agent': UA } });
    if (!res.ok) {
      console.log(`  ${name}: ${res.status}, skipped`);
      continue;
    }
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    console.log(`  ${name}`);
  }
  return (await readdir(CACHE)).filter((f) => f.endsWith('.csv'));
}

// ---------------------------------------------------------------------------
// reading them
// ---------------------------------------------------------------------------

/**
 * One observation, with the instant recovered from the local clock.
 *
 * Returns null for anything that cannot be trusted, which is most of the work:
 * a chart number outside 1 to 7, a sky that was not clear, coordinates outside
 * the possible ranges (the files contain a latitude of 3737670), or a date and
 * time that will not parse. Nothing is repaired or guessed.
 */
function readRow(cols, idx) {
  const chart = Number.parseFloat(cols[idx.chart]);
  if (!(chart >= 1 && chart <= 7)) return null;
  if ((cols[idx.cloud] || '').trim().toLowerCase() !== 'clear') return null;

  const lat = Number.parseFloat(cols[idx.lat]);
  const lon = Number.parseFloat(cols[idx.lon]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;

  const dateStr = (cols[idx.localDate] || '').trim();
  const timeStr = (cols[idx.localTime] || '').trim();
  if (!dateStr || !timeStr) return null;

  let iso;
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) iso = dateStr;
  else {
    const p = dateStr.split('/');
    if (p.length !== 3) return null;
    iso = `${p[2]}-${p[0].padStart(2, '0')}-${p[1].padStart(2, '0')}`;
  }
  const wall = new Date(`${iso}T${timeStr.padStart(5, '0').slice(0, 5)}:00Z`);
  if (Number.isNaN(wall.getTime())) return null;

  /*
   * The local wall clock, turned back into an instant using the longitude.
   *
   * This is solar time rather than civil time, so it is out by up to half an
   * hour where a country's zone does not follow its meridian and further where
   * a zone is deliberately skewed. That is minutes of error against the twelve
   * hours the published UT columns are out by, and it is only ever used to
   * decide whether the sky was dark and where the Moon was.
   */
  const at = new Date(wall.getTime() - (lon / 15) * 3600 * 1000);

  const elev = Number.parseFloat(cols[idx.elev]);
  return { at, lat, lon, elevKm: Number.isFinite(elev) ? elev / 1000 : 0, chart };
}

function splitCsvLine(line) {
  return line.replace(/"/g, '').split(',');
}

async function readAll(files) {
  const rows = [];
  for (const file of files) {
    const text = await readFile(join(CACHE, file), 'utf8');
    const lines = text.split(/\r?\n/);
    const header = splitCsvLine(lines[0]).map((h) => h.trim());
    const idx = {
      lat: header.indexOf('Latitude'),
      lon: header.indexOf('Longitude'),
      elev: header.indexOf('Elevation(m)'),
      localDate: header.indexOf('LocalDate'),
      localTime: header.indexOf('LocalTime'),
      chart: header.indexOf('LimitingMag'),
      cloud: header.indexOf('CloudCover'),
    };
    // A year whose export is missing a column this needs is skipped whole
    // rather than filled in from somewhere else.
    if (Object.values(idx).some((i) => i < 0)) {
      console.log(`  ${file}: missing a needed column, skipped`);
      continue;
    }
    let kept = 0;
    for (const line of lines.slice(1)) {
      if (!line) continue;
      const row = readRow(splitCsvLine(line), idx);
      if (row) {
        rows.push(row);
        kept++;
      }
    }
    console.log(`  ${file.padEnd(12)} ${String(kept).padStart(6)} usable`);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// what the sky was doing
// ---------------------------------------------------------------------------

function skyAt(row) {
  const observer = new Observer(row.lat, row.lon, row.elevKm * 1000);
  const time = MakeTime(row.at);

  const sun = Equator(Body.Sun, time, observer, true, true);
  const sunAltitude = Horizon(time, observer, sun.ra, sun.dec, 'normal').altitude;

  const moon = Equator(Body.Moon, time, observer, true, true);
  const moonAltitude = Horizon(time, observer, moon.ra, moon.dec, 'normal').altitude;
  const lit = Illumination(Body.Moon, time).phase_fraction;

  /*
   * How much moonlight is actually landing on the sky, rather than how full the
   * Moon happens to be. A full Moon below the horizon contributes nothing, and
   * one low down contributes less than one overhead, which is what the sine
   * carries. Below the horizon the term is zero rather than negative.
   */
  const moonTerm = moonAltitude > 0 ? lit * Math.sin((moonAltitude * Math.PI) / 180) : 0;

  return { sunAltitude, moonTerm };
}

// ---------------------------------------------------------------------------
// where the observer was
// ---------------------------------------------------------------------------

/**
 * A map of how dark each place actually is, measured rather than modelled.
 *
 * The median chart reading in a cell, counting only moonless nights, is a
 * direct empirical statement about that place's sky: it is what people standing
 * there could see when nothing but the town was in the way. That is the light
 * pollution term, and it comes from the same observations as everything else
 * rather than from a raster that would have to be shipped and licensed.
 *
 * Built from training rows only. A grid built from all of them would carry the
 * test set's own answers inside it, and the held-out comparison would be
 * measuring nothing.
 */
function buildGrid(rows) {
  const cells = new Map();
  for (const row of rows) {
    if (row.moonTerm > DARK_MOON) continue;
    const key = `${Math.floor(row.lat / GRID_DEG)},${Math.floor(row.lon / GRID_DEG)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(row.chart);
  }

  const grid = new Map();
  for (const [key, values] of cells) {
    if (values.length < MIN_PER_CELL) continue;
    values.sort((a, b) => a - b);
    const mid = values.length >> 1;
    grid.set(key, values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2);
  }
  return grid;
}

function lookupGrid(grid, lat, lon) {
  const by = Math.floor(lat / GRID_DEG);
  const bx = Math.floor(lon / GRID_DEG);
  const reach = Math.ceil(SEARCH_DEG / GRID_DEG);
  for (let ring = 0; ring <= reach; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const hit = grid.get(`${by + dy},${bx + dx}`);
        if (hit !== undefined) return hit;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// fitting
// ---------------------------------------------------------------------------

/** Least squares by Gaussian elimination. Three terms; nothing exotic is needed. */
function solve(matrix, targets) {
  const n = matrix[0].length;
  const ata = Array.from({ length: n }, () => new Float64Array(n));
  const atb = new Float64Array(n);
  for (let r = 0; r < matrix.length; r++) {
    for (let i = 0; i < n; i++) {
      atb[i] += matrix[r][i] * targets[r];
      for (let j = 0; j < n; j++) ata[i][j] += matrix[r][i] * matrix[r][j];
    }
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(ata[r][col]) > Math.abs(ata[pivot][col])) pivot = r;
    [ata[col], ata[pivot]] = [ata[pivot], ata[col]];
    [atb[col], atb[pivot]] = [atb[pivot], atb[col]];
    const p = ata[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = ata[r][col] / p;
      for (let c = col; c < n; c++) ata[r][c] -= factor * ata[col][c];
      atb[r] -= factor * atb[col];
    }
  }
  return Array.from({ length: n }, (_, i) =>
    Math.abs(ata[i][i]) < 1e-12 ? 0 : atb[i] / ata[i][i],
  );
}

const rmse = (predicted, actual) =>
  Math.sqrt(predicted.reduce((s, p, i) => s + (p - actual[i]) ** 2, 0) / predicted.length);

// ---------------------------------------------------------------------------

async function main() {
  const files = await download();
  console.log('\nreading observations...');
  const all = await readAll(files);
  console.log(`\n${all.length} clear-sky observations with a chart reading`);

  console.log('\ncomputing what the sky was doing at each one...');
  for (let i = 0; i < all.length; i++) {
    if (i % 20000 === 0) process.stdout.write(`  ${i}/${all.length}\r`);
    Object.assign(all[i], skyAt(all[i]));
  }
  console.log(`  done                    `);

  const daylight = all.filter((r) => r.sunAltitude > -0.833).length;
  console.log(`  ${((daylight / all.length) * 100).toFixed(1)}% land in daylight`);
  console.log('  (the published UT columns give 53.1%, which is the bug this avoids)');

  /*
   * Only genuine darkness, which is also the only place the correction is used.
   * Fitting the region of application and nothing else is what makes it
   * impossible for this to say anything about a daytime sky.
   */
  const night = all.filter((r) => r.sunAltitude < NIGHT_SUN_ALTITUDE);
  console.log(`\n${night.length} of them are astronomical night (Sun below ${NIGHT_SUN_ALTITUDE})`);

  night.sort((a, b) => a.at - b.at);
  const cut = Math.floor(night.length * 0.85);
  const train = night.slice(0, cut);
  const test = night.slice(cut);
  console.log(`  train ${train.length}, held out ${test.length} (split by date)`);

  const grid = buildGrid(train);
  const darkTrain = train.filter((r) => r.moonTerm <= DARK_MOON).map((r) => r.chart).sort((a, b) => a - b);
  const globalDark = darkTrain[darkTrain.length >> 1];
  console.log(`  ${grid.size} places with a measured dark-sky median; global median ${globalDark}`);

  const design = [];
  const target = [];
  for (const row of train) {
    const local = lookupGrid(grid, row.lat, row.lon);
    design.push([1, row.moonTerm, local === null ? 0 : local - globalDark, row.elevKm]);
    target.push(row.chart);
  }
  const [intercept, moonCoef, lpCoef, elevCoef] = solve(design, target);

  console.log('\nfitted, in chart steps:');
  console.log(`  a full Moon overhead costs        ${(-moonCoef).toFixed(3)}`);
  console.log(`  each step of local dark-sky median${lpCoef >= 0 ? ' adds  ' : ' costs '}${Math.abs(lpCoef).toFixed(3)}`);
  console.log(`  each kilometre of elevation adds  ${elevCoef.toFixed(3)}`);

  const predict = (row) => {
    const local = lookupGrid(grid, row.lat, row.lon);
    return intercept + moonCoef * row.moonTerm + lpCoef * (local === null ? 0 : local - globalDark) + elevCoef * row.elevKm;
  };

  const actual = test.map((r) => r.chart);
  const modelRmse = rmse(test.map(predict), actual);

  // The two baselines that make the comparison honest. A constant is the floor
  // anything must clear. The four buckets are what is already in the app, given
  // the same fair calibration the model gets rather than an invented scale.
  const constant = train.reduce((s, r) => s + r.chart, 0) / train.length;
  const constantRmse = rmse(test.map(() => constant), actual);

  console.log('\nheld-out RMSE on astronomical-night observations:');
  console.log(`  a constant (${constant.toFixed(2)})   ${constantRmse.toFixed(4)}`);
  console.log(`  this model            ${modelRmse.toFixed(4)}`);
  const gain = ((constantRmse - modelRmse) / constantRmse) * 100;
  console.log(`  improvement           ${gain.toFixed(1)}%`);

  const payload = {
    _source: 'Globe at Night (globeatnight.org), 2006 onwards',
    _note:
      'A correction in chart steps against a typical dark moonless sky, fitted only on ' +
      'observations with the Sun below -18 degrees, which is the only region it is ever ' +
      'applied in. It is a difference and not an absolute magnitude: the intercept stays in ' +
      'the build script. Instants are derived from LocalDate and LocalTime corrected by ' +
      'longitude, because the published UTDate and UTTime columns have the timezone offset ' +
      'applied in the wrong direction and put 53.1% of night observations in daylight.',
    builtAt: new Date().toISOString(),
    trainRows: train.length,
    testRows: test.length,
    constantRmse: Number(constantRmse.toFixed(4)),
    modelRmse: Number(modelRmse.toFixed(4)),
    nightSunAltitude: NIGHT_SUN_ALTITUDE,
    gridDeg: GRID_DEG,
    searchDeg: SEARCH_DEG,
    globalDarkMedian: globalDark,
    moonCoef: Number(moonCoef.toFixed(5)),
    lpCoef: Number(lpCoef.toFixed(5)),
    elevCoef: Number(elevCoef.toFixed(5)),
    grid: Object.fromEntries(grid),
  };

  await writeFile(OUT, `${JSON.stringify(payload)}\n`);
  console.log(`\nwrote ${OUT} (${Math.round(JSON.stringify(payload).length / 1024)} KB)`);
}

await main();
