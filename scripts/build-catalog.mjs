#!/usr/bin/env node
/**
 * Builds the compact star + constellation catalogues that Borrowed Sky ships.
 *
 * Sources (both free, no key, redistributable with attribution):
 *   - HYG Database v4.1 (astronexus/HYG-Database), CC BY-SA 4.0.
 *     Real astrometry: J2000 right ascension, declination, visual magnitude,
 *     colour index and spectral class.
 *   - d3-celestial constellation figure lines (ofrohn/d3-celestial), BSD-3-Clause.
 *
 * Nothing here is invented. The script only filters, rounds and re-packs.
 * Run with `npm run catalog`. Output lands in src/data/.
 */

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CACHE = join(ROOT, '.catalog-cache');
// Written to public/ so the catalogues ship as separately-cacheable static
// assets rather than being inlined into the JS bundle. On a slow connection the
// interface appears first and the star data streams in behind it.
const OUT = join(ROOT, 'public', 'data');

const HYG_URL =
  'https://raw.githubusercontent.com/astronexus/HYG-Database/main/hyg/CURRENT/hygdata_v41.csv';
const LINES_URL =
  'https://raw.githubusercontent.com/ofrohn/d3-celestial/master/data/constellations.lines.json';

/** Faintest star we ship. 6.0 is roughly the naked-eye limit in a dark sky. */
const MAG_LIMIT = 6.0;

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Downloads `url` to `dest` unless it is already cached. */
async function fetchCached(url, dest) {
  if (await exists(dest)) {
    console.log(`  cached  ${dest}`);
    return;
  }
  console.log(`  fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`  saved   ${dest} (${buf.length.toLocaleString()} bytes)`);
}

/** Splits one CSV line, honouring double-quoted fields. */
function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = false;
      } else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

const round = (n, places) => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

// ---------------------------------------------------------------------------
// reference data (IAU standard: stable, not derived from the sources above)
// ---------------------------------------------------------------------------

const GREEK = {
  Alp: 'α', Bet: 'β', Gam: 'γ', Del: 'δ', Eps: 'ε', Zet: 'ζ', Eta: 'η',
  The: 'θ', Iot: 'ι', Kap: 'κ', Lam: 'λ', Mu: 'μ', Nu: 'ν', Xi: 'ξ',
  Omi: 'ο', Pi: 'π', Rho: 'ρ', Sig: 'σ', Tau: 'τ', Ups: 'υ', Phi: 'φ',
  Chi: 'χ', Psi: 'ψ', Ome: 'ω',
};

const CONSTELLATION_NAMES = {
  And: 'Andromeda', Ant: 'Antlia', Aps: 'Apus', Aqr: 'Aquarius', Aql: 'Aquila',
  Ara: 'Ara', Ari: 'Aries', Aur: 'Auriga', Boo: 'Boötes', Cae: 'Caelum',
  Cam: 'Camelopardalis', Cnc: 'Cancer', CVn: 'Canes Venatici', CMa: 'Canis Major',
  CMi: 'Canis Minor', Cap: 'Capricornus', Car: 'Carina', Cas: 'Cassiopeia',
  Cen: 'Centaurus', Cep: 'Cepheus', Cet: 'Cetus', Cha: 'Chamaeleon', Cir: 'Circinus',
  Col: 'Columba', Com: 'Coma Berenices', CrA: 'Corona Australis', CrB: 'Corona Borealis',
  Crv: 'Corvus', Crt: 'Crater', Cru: 'Crux', Cyg: 'Cygnus', Del: 'Delphinus',
  Dor: 'Dorado', Dra: 'Draco', Equ: 'Equuleus', Eri: 'Eridanus', For: 'Fornax',
  Gem: 'Gemini', Gru: 'Grus', Her: 'Hercules', Hor: 'Horologium', Hya: 'Hydra',
  Hyi: 'Hydrus', Ind: 'Indus', Lac: 'Lacerta', Leo: 'Leo', LMi: 'Leo Minor',
  Lep: 'Lepus', Lib: 'Libra', Lup: 'Lupus', Lyn: 'Lynx', Lyr: 'Lyra',
  Men: 'Mensa', Mic: 'Microscopium', Mon: 'Monoceros', Mus: 'Musca', Nor: 'Norma',
  Oct: 'Octans', Oph: 'Ophiuchus', Ori: 'Orion', Pav: 'Pavo', Peg: 'Pegasus',
  Per: 'Perseus', Phe: 'Phoenix', Pic: 'Pictor', Psc: 'Pisces', PsA: 'Piscis Austrinus',
  Pup: 'Puppis', Pyx: 'Pyxis', Ret: 'Reticulum', Sge: 'Sagitta', Sgr: 'Sagittarius',
  Sco: 'Scorpius', Scl: 'Sculptor', Sct: 'Scutum', Ser: 'Serpens', Sex: 'Sextans',
  Tau: 'Taurus', Tel: 'Telescopium', Tri: 'Triangulum', TrA: 'Triangulum Australe',
  Tuc: 'Tucana', UMa: 'Ursa Major', UMi: 'Ursa Minor', Vel: 'Vela', Vir: 'Virgo',
  Vol: 'Volans', Vul: 'Vulpecula',
};

// ---------------------------------------------------------------------------
// stars
// ---------------------------------------------------------------------------

async function buildStars() {
  const csv = await readFile(join(CACHE, 'hygdata_v41.csv'), 'utf8');
  const lines = csv.split('\n');
  const header = splitCsvLine(lines[0]).map((h) => h.replace(/"/g, ''));

  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`HYG column "${name}" missing: catalogue format changed`);
    return i;
  };
  const iId = col('id');
  const iHip = col('hip');
  const iProper = col('proper');
  const iRa = col('ra');
  const iDec = col('dec');
  const iMag = col('mag');
  const iSpect = col('spect');
  const iCi = col('ci');
  const iBayer = col('bayer');
  const iFlam = col('flam');
  const iCon = col('con');
  const iDist = col('dist');

  const stars = [];
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw || raw.length < 10) continue;
    const f = splitCsvLine(raw);

    // id 0 is the Sun; it is computed live, not drawn from the catalogue.
    if (f[iId] === '0') continue;

    const mag = Number.parseFloat(f[iMag]);
    if (!Number.isFinite(mag) || mag > MAG_LIMIT) continue;

    const ra = Number.parseFloat(f[iRa]); // hours, J2000
    const dec = Number.parseFloat(f[iDec]); // degrees, J2000
    if (!Number.isFinite(ra) || !Number.isFinite(dec)) continue;

    const ci = Number.parseFloat(f[iCi]);
    const con = f[iCon] || '';
    const proper = (f[iProper] || '').trim();

    // Bayer designation, e.g. "Alp" + "And" -> "α And". HYG occasionally
    // appends a component digit ("Alp1"), which we preserve as a superscript-ish suffix.
    let bayer = '';
    const bRaw = (f[iBayer] || '').trim();
    if (bRaw && con) {
      const m = bRaw.match(/^([A-Za-z]+)(\d*)$/);
      const greek = m && GREEK[m[1]];
      if (greek) bayer = `${greek}${m[2] || ''} ${con}`;
    }
    if (!bayer && f[iFlam] && con) bayer = `${f[iFlam]} ${con}`;

    // HYG stores distance in parsecs and uses 100000 as its "no reliable
    // parallax" sentinel. Those become 0, meaning unknown, rather than a
    // fabricated distance.
    const distPc = Number.parseFloat(f[iDist]);
    const distLy =
      Number.isFinite(distPc) && distPc > 0 && distPc < 99999 ? distPc * 3.261563777 : 0;

    stars.push([
      round(ra, 4),
      round(dec, 4),
      round(mag, 2),
      Number.isFinite(ci) ? round(ci, 2) : 0,
      proper,
      bayer,
      con,
      f[iHip] ? Number.parseInt(f[iHip], 10) : 0,
      (f[iSpect] || '').trim().slice(0, 3),
      round(distLy, 1),
    ]);
  }

  // Brightest first: the renderer draws in order and can stop early.
  stars.sort((a, b) => a[2] - b[2]);

  const named = stars.filter((s) => s[4]).length;
  const payload = {
    _source: 'HYG Database v4.1 (astronexus/HYG-Database), CC BY-SA 4.0',
    _note: 'Real astrometry. Positions are J2000 mean equator and equinox.',
    epoch: 'J2000',
    magLimit: MAG_LIMIT,
    count: stars.length,
    fields: [
      'ra_hours', 'dec_deg', 'mag', 'colorIndex', 'proper',
      'bayer', 'con', 'hip', 'spect', 'dist_ly',
    ],
    stars,
  };

  await writeFile(join(OUT, 'stars.json'), JSON.stringify(payload));
  console.log(`  stars.json      ${stars.length} stars (${named} with proper names), mag <= ${MAG_LIMIT}`);
}

// ---------------------------------------------------------------------------
// constellation figures
// ---------------------------------------------------------------------------

async function buildConstellations() {
  const geo = JSON.parse(await readFile(join(CACHE, 'constellations.lines.json'), 'utf8'));
  const out = [];

  for (const feature of geo.features) {
    const id = feature.id;
    const coords =
      feature.geometry.type === 'MultiLineString'
        ? feature.geometry.coordinates
        : [feature.geometry.coordinates];

    // Flatten each polyline to [ra1, dec1, ra2, dec2, ...] in RA hours / Dec degrees.
    const lines = [];
    // Vector mean, so the label centroid survives the RA=0h wrap.
    let cx = 0;
    let cy = 0;
    let cz = 0;
    let n = 0;

    for (const line of coords) {
      const flat = [];
      for (const [raDeg, decDeg] of line) {
        const raHours = (((raDeg % 360) + 360) % 360) / 15;
        flat.push(round(raHours, 4), round(decDeg, 4));

        const raRad = (raHours / 12) * Math.PI;
        const decRad = (decDeg * Math.PI) / 180;
        cx += Math.cos(decRad) * Math.cos(raRad);
        cy += Math.cos(decRad) * Math.sin(raRad);
        cz += Math.sin(decRad);
        n++;
      }
      if (flat.length >= 4) lines.push(flat);
    }
    if (!lines.length || !n) continue;

    const centroidRa = (((Math.atan2(cy, cx) * 12) / Math.PI) + 24) % 24;
    const centroidDec = (Math.atan2(cz, Math.hypot(cx, cy)) * 180) / Math.PI;

    out.push({
      id,
      name: CONSTELLATION_NAMES[id] || id,
      centroid: [round(centroidRa, 3), round(centroidDec, 3)],
      lines,
    });
  }

  out.sort((a, b) => a.id.localeCompare(b.id));

  const payload = {
    _source: 'd3-celestial constellation figures (ofrohn/d3-celestial), BSD-3-Clause',
    epoch: 'J2000',
    count: out.length,
    constellations: out,
  };

  await writeFile(join(OUT, 'constellations.json'), JSON.stringify(payload));
  console.log(`  constellations.json  ${out.length} figures`);
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('Borrowed Sky: catalogue build');
  await mkdir(OUT, { recursive: true });
  await mkdir(CACHE, { recursive: true });

  console.log('\nsources:');
  await fetchCached(HYG_URL, join(CACHE, 'hygdata_v41.csv'));
  await fetchCached(LINES_URL, join(CACHE, 'constellations.lines.json'));

  console.log('\noutput:');
  await buildStars();
  await buildConstellations();
  console.log('\ndone.');
}

main().catch((err) => {
  console.error('\ncatalogue build failed:', err.message);
  process.exit(1);
});
