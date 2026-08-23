<div align="center">

# Borrowed Sky

**A zero-install sky companion that tells anyone, anywhere, what is overhead right now, and explains it like a patient guide, not a data dump.**

[![IBM watsonx.ai](https://img.shields.io/badge/IBM-watsonx.ai-0f62fe?style=for-the-badge&logo=ibm&logoColor=white)](https://www.ibm.com/products/watsonx-ai)
[![IBM Granite](https://img.shields.io/badge/IBM-Granite-0043ce?style=for-the-badge&logo=ibm&logoColor=white)](https://www.ibm.com/granite)
[![Built with IBM Bob](https://img.shields.io/badge/Built%20with-IBM%20Bob-002d9c?style=for-the-badge&logo=ibm&logoColor=white)](https://bob.ibm.com/)

![TypeScript](https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React%2018-20232a?style=flat-square&logo=react)
![Vite](https://img.shields.io/badge/Vite%206-646cff?style=flat-square&logo=vite&logoColor=white)
![No install](https://img.shields.io/badge/install-none-2e7d32?style=flat-square)
![No account](https://img.shields.io/badge/account-none-2e7d32?style=flat-square)
![Checks](https://img.shields.io/badge/verification-17%20suites-2e7d32?style=flat-square)

### [Open the live app](https://borrowed-sky.vercel.app/)

No install, no account, no sign-in. It asks for your location and shows you your own sky.

*Built for the AI Builders Challenge, Space Exploration theme.*

</div>

---

Open it in a browser. Point your phone up. It names what you are looking at, computed for the exact spot you are standing on and the exact minute it is.

Two links worth having open: the [live app](https://borrowed-sky.vercel.app/), and the same app [held at a moonlit night](https://borrowed-sky.vercel.app/?at=2026-09-27T19:40:51Z), where the fitted sky model has something to do.

No install. No account. No telescope. No prior knowledge.

### Contents

| | |
|---|---|
| [The problem](#the-problem) | who this is actually for |
| [What it does](#what-it-does) | the six things it is |
| [IBM technology in this project](#ibm-technology-in-this-project) | Granite, watsonx.ai, Bob, at a glance |
| [Nothing is fabricated](#the-core-principle-nothing-is-fabricated) | the rule that shaped every decision |
| [The AI layer](#the-ai-layer-ibm-granite-on-watsonxai) | what Granite does and is forbidden from doing |
| [The sky model](#machine-learning-a-sky-model-fitted-to-170000-human-observations) | ML fitted to 170,000 human observations |
| [Built with IBM Bob](#built-with-ibm-bob) | agentic development, failures included |
| [Verification](#verification) | how the astronomy is proved |
| [Running it](#running-it) | five minutes, no credentials needed |
| [Privacy and security](#privacy-and-security) | what leaves your device, and what does not |
| [Honest limitations](#honest-limitations) | what it deliberately does not do |

Deeper detail lives beside the code: [running and deploying](docs/RUNNING.md) · [verification](docs/VERIFICATION.md) · [design notes](docs/DESIGN-NOTES.md) · [engineering log](docs/ENGINEERING-LOG.md)

---

## The problem

About a third of the world cannot see the Milky Way from where they live. But the harder problem is not light pollution; it is that even under a perfect sky, most people have no idea what they are looking at, or that anything is happening at all.

The tools that solve this assume you are already an enthusiast. They want an app install, a capable device, and a user who already knows the name of the thing they are trying to find. That excludes exactly the people for whom a first look at the sky would matter most: kids in township schools, refugee camps, rural and low-resource communities.

**Borrowed Sky is built for someone who has never used an astronomy tool, has no telescope, and does not know what a magnitude is.** No install. No account. No prior knowledge. It works on a cheap phone over a slow connection, and it tells you not just what is up there but *where to look* and *when to go outside*.

---

## What it does

**Live sky map.** A stylized star map that rotates as you turn, drawn from a real star catalogue, with the Milky Way lying where our galaxy actually lies and the afterglow sitting on the bearing the Sun actually set on. Tap anything to find out what it is. Where the compass is unavailable or refused, it becomes a drag-to-look map, clearly labelled as such and, never silently pretending to track.

**A compass repeater.** A brass-framed heading strip under the sky, ruled at a fixed scale of its own so it stays readable however far the map is zoomed. It is also the proof that tracking is live: when the compass is driving, the card turns.

**Tonight's sky.** A horizontal timeline of what actually becomes visible over the coming hours: planet windows, moonrise, and visible station passes. The twilight band behind it is a plot of the real Sun altitude, so the darkness you see on the strip is the darkness that is coming.

**A guide you can ask.** "What's that bright one?" gets answered from the actual computed sky, with an *Explain like I'm 10* setting that changes the language rather than the facts.

**A sky journal.** Everything you have found, plotted on a planisphere that slowly fills in. Stored on your device: no account, nothing uploaded.

**Night vision.** A red-only mode across the entire interface, including the sky canvas. A bright screen costs you roughly twenty minutes of dark adaptation, which matters when the whole point is to go outside and look up.

---

## IBM technology in this project

| What | Where it is used | Why it is there |
|---|---|---|
| **IBM Granite** (`granite-3-3-8b-instruct`) on **watsonx.ai** | Every explanation, every answer in the guide | Understands an untrained question and chooses what is worth saying. It is given a finished JSON description of the sky and forbidden from adding to it. |
| **IBM Granite Embeddings** (`granite-embedding-30m`, 384-d) | Retrieval over the project's own reference corpus | Lets the guide cite where an explanation came from instead of asserting it |
| **IBM Bob** | The grounding guard, and two attempts at the sky model | Agentic development on real briefs, with the failures recorded rather than tidied away |
| **watsonx.ai tool calling** | The guide's access to the live sky | Granite may call functions that answer out of the browser's own astronomy engine, so a request for a position is computed rather than recalled |

Granite carries the language. It never carries the correctness: every number it speaks has already been computed in the browser, and a guard checks each answer against that data before it is shown.

---

## The core principle: nothing is fabricated

The hard rule of the build, and it shaped every technical decision. **There is no mock data anywhere, including during development.** No placeholder sky. If a source is unavailable the app states the failure rather than filling the gap with a guess.

| what | where it comes from |
|---|---|
| 5,070 star positions and colours | HYG Database v4.1, J2000 astrometry; colours derived from each star's B-V index, not picked by hand |
| The Milky Way | the real galactic frame from the IAU pole, so the band lies where the galaxy actually is |
| The horizon afterglow | the Sun's computed azimuth and altitude, so it points where the Sun actually set |
| Sun, Moon, planets | astronomy-engine, apparent positions with aberration and refraction |
| Satellite passes | SGP4 on live Celestrak elements, searched numerically rather than looked up |
| Explanations | a corpus built from NASA's public-domain science writing, retrieved by embedding and cited by source |
| Granite | receives a finished description of the sky and adds nothing to it |

**Three things are not computed, and each is fenced.** Place names are looked up, so the coordinate is rounded to ~1km before it leaves and nothing is invented when it fails. The foreground hills are drawn, so they are clipped strictly below the true horizon and can never sit in front of a real object. And the guide's explanations come from the corpus rather than memory, so retrieval refuses rather than degrading when it cannot match.

Why each of those is fenced the way it is: **[docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md)**

### Visible is not the same as "above the horizon"

A satellite overhead is invisible in Earth's shadow; a planet is invisible in a bright sky. A pass counts as *visible* only when the satellite is sunlit **and** the observer's sky is dark **and** it clears 10°. The same question about stars is what [the sky model](#machine-learning-a-sky-model-fitted-to-170000-human-observations) answers.


### Verification

The astronomy is checked against sources independent of the code, not against itself.

```bash
npm run verify      # 14 checks: astronomy, tools, retrieval, the sky model
npm run verify:ui   # 5 headless-Chrome passes over the real app
```

| check | measured against | result |
|---|---|---|
| Coordinate frames | astronomy-engine's own independent path | agree to **0.01 arcseconds** |
| Galactic frame | published position of Sagittarius A\* | **0.1 arcseconds** |
| Satellites | ISS period, orbital speed, sunlit fraction | derived independently of the code |
| Timeline | Svalbard in midsummer, where the answer is "no darkness tonight" | four latitudes |
| The sky model | held-out observations it never saw | **8.3%** better than a constant |
| The guide, with watsonx failing | six ways it can fail, including hanging | answers from the computed sky every time |

What each check covers and why several of them exist: **[docs/VERIFICATION.md](docs/VERIFICATION.md)**


## Architecture

Positions are computed in the browser from geolocation and the current time, turned into a structured object list, and only then handed to the AI layer. Device orientation selects which part of that computed sky is drawn. Two serverless functions exist only to hold keys and to proxy services that send no CORS header.

<details>
<summary>Project layout</summary>

```
Browser
├── public/data/           Star + constellation catalogues (static, cacheable)
├── src/lib/astro/
│   ├── frames.ts          Coordinate frames; collapses the whole transform
│   │                      chain into one 4×3 matrix per frame
│   ├── starfield.ts       Catalogue loading into typed arrays
│   ├── solar.ts           Sun/Moon/planet ephemeris
│   ├── satellites.ts      TLE parsing, SGP4, eclipse test, pass search
│   ├── milkyway.ts        Galactic frame; places the band on the real sky
│   └── events.ts          Tonight's visibility windows
├── src/lib/ai.ts          Context builder + deterministic fallback narrator
└── src/components/        Sky canvas, timeline, guide, journal

Server (serverless functions)
├── api/tle.ts             Celestrak proxy, Celestrak sends no CORS header,
│                          so a browser cannot reach it directly
└── api/ask.ts             watsonx.ai proxy, keeps the API key off the client
```

</details>

**Why the sky map is fast.** Placing 5,000 stars the obvious way is too slow on the cheap hardware this is meant for, so the whole chain from J2000 to screen collapses into a single 4x3 matrix rebuilt once per frame: twelve multiplies per star and no trigonometry. Stars batch into colour buckets, so the renderer issues one fill per bucket rather than one per star. Stereographic projection maps every circle on the sphere to a circle in the plane, so the horizon and each layer beneath it is solved analytically instead of walked point by point.

---

## The AI layer: IBM Granite on watsonx.ai

Narration runs on **IBM watsonx.ai** with **IBM Granite**. `api/ask.ts` tries `ibm/granite-3-3-8b-instruct` and walks a short list of Granite models if a project's region or plan does not offer it.

**Granite does language, never astronomy.** Every position, time, magnitude and phase is computed in the browser first; only a finished JSON description of that sky reaches the model. The system prompt enforces the division:

> The JSON block you are given is the ONLY authoritative description of this observer's sky. Never state a position, altitude, direction, time, distance or brightness that is not present in that JSON. If you are asked something the JSON does not answer, say plainly that you cannot see it in tonight's data. Never guess.

That leaves it the part no template covers: working out which object "that bright one" means, choosing which two of a dozen objects matter to someone with no telescope, saying *I can't see that in tonight's data* rather than reaching into training data, and switching between *Explain like I'm 10* and *Standard* without changing a number.

**When Granite is unavailable the app does not go quiet and does not guess.** A deterministic narrator assembles sentences from the same computed values, and the interface says which of the two spoke on every answer. Six failure modes are tested, including the endpoint hanging, and all six still answer from the computed sky.

`npm run verify:granite` is a real call, not a mock: IAM exchange, model listing, then one grounded request against a live sky. Each stage fails with its own message, because a bad key, a wrong region and an unavailable model look identical from the app and need different fixes.

---

## Machine learning: a sky model fitted to 170,000 human observations

Granite is the language layer. This is the part that learned something.

The app decides what is visible from four hand-written thresholds keyed on the Sun. Those are right about the biggest thing that happens to a sky and silent about the next two: **the Moon**, which washes out faint stars while it is up, and **light pollution**, which is the entire difference between a city and a field.

[Globe at Night](https://globeatnight.org/) has an answer. Since 2006 about 170,000 people have stood outside, looked up, and reported which of eight star charts matched what they could actually see. Real eyes, real skies, real places. `scripts/build-skymodel.mjs` fits an ordinary least-squares model to 121,998 of those observations and holds out the most recent 21,530 chronologically.

What it learned, in chart steps:

| term | effect |
|---|---|
| a full Moon overhead | **0.794** steps of sky lost |
| each step of local dark-sky median | **0.737** |
| each kilometre of elevation | **0.141** |

Held-out error of **1.4977** against **1.6327** for predicting the average every time: **8.3% better**, on the same scale with nothing converted.

**In the app** it is worth up to about 0.7 magnitudes. Faint stars that a moonless sky would give you fade from the chart as the Moon rises, and a city sky is drawn thinner than a field. The guide names the number it is applying and what it was fitted to.

### The design decision that made it work

It returns **a correction, never an answer**: a number of magnitudes to add to a limit the caller already has. It was fitted only on observations with the Sun below -18 degrees and is applied only there. Above that it returns exactly zero, so the code that runs in daylight is identical to the code that ran before the model existed.

That is why daylight cannot regress: not because a test forbids it, but because the model has no way to reach it. Two earlier versions replaced the thresholds outright and both ended up listing Sirius as visible at noon.

### How it is checked

`scripts/verify/skyquality.check.ts` asserts the guarantee directly: for every brightness from magnitude -5 to +7, at seven Sun altitudes above -18 degrees, asking with the model must return an identical answer to asking without it.

`scripts/verify/skymodel.mjs` is the one no unit test could be. It drives the real app in headless Chrome and holds everything fixed except the model itself, blocking `skymodel.json` at the network layer for the control run. Same night, same Moon, same stars overhead: **4,332 points of light with the model against 4,434 without.** The difference is the model, and it can be nothing else.

---

## Built with IBM Bob

Three pieces of this project were handed to [IBM Bob](https://bob.ibm.com/) as written briefs, with the agent planning, writing, testing and iterating on its own.

**The grounding guard** is Bob's end to end: the check that compares each of Granite's answers against the JSON it was given and refuses to show one making a claim the computed sky does not support. Bob read the surrounding code, restated the constraints most likely to be missed, and made two calls that were better than the brief. It excluded the timestamp from the pool of numbers it scans, because digits scraped out of an ISO date give false claims accidental cover. And it wrote in a comment that the check pools every value regardless of what it measures, so `magnitude 47` passes if something happens to sit at 47 degrees altitude. That weakness is real, and the code now says so rather than reading as though the check were tighter than it is.

**The sky visibility model** took three attempts, two of them Bob's, and the reason is worth more than the feature. Bob was asked to replace four hand-written brightness thresholds with a model fitted to Globe at Night citizen-science observations. It built exactly that, twice, correctly to the brief, and both versions had to be reverted for the same underlying reason: applied to daylight, they claimed first-magnitude stars were visible at noon.

Chasing that produced the finding this project is proudest of. **The Globe at Night export has its timezone offsets applied backwards.** A US observer's 20:04 local is filed as 14:04 UT the same date, when an eight o'clock evening observation at UTC-6 is 02:04 UT the following day. Derive a Sun altitude from the published UT columns and **53.1%** of naked-eye star chart observations land in daylight, which cannot happen. Derive it from the local clock and the longitude instead and that falls to **7.7%**. Half the training set had been wrong by twelve hours, so the Sun coefficient was fitted through noise and came out near zero. Anyone fitting anything to that dataset needs to know this.

The third attempt was written by hand and ships. What changed was not the arithmetic but the shape: it produces a *correction* rather than an answer, so it has nothing to say about daylight and cannot break it. That is described under [the sky model](#machine-learning-a-sky-model-fitted-to-170000-human-observations) above.

Across all three tasks Bob wrote clean, well-commented, correctly structured code and was reliably wrong in one direction: a fallback that hides a disabled check reads as robustness and behaves as a silent hole. Every correction came from asking what happens when this fails, not from reading the code as written.

**The full record**, including the honest held-out numbers whichever way they fell and the two reverts in detail, is in [`docs/ENGINEERING-LOG.md`](docs/ENGINEERING-LOG.md).

## Running it

Works with no credentials. The astronomy is computed in your browser; the guide falls back to its deterministic narrator. Adding watsonx credentials swaps in IBM Granite and changes nothing else.

```bash
npm install
npm run catalog     # star + constellation data into public/data
npm run dev         # http://localhost:5173
```

Full setup, watsonx credentials and Vercel deployment: **[docs/RUNNING.md](docs/RUNNING.md)**

---


## Addressing the Space Exploration theme

The challenge asks for tools that translate complex space data into clear insights, and for space education and public engagement.

Borrowed Sky takes three genuinely complex data sources (a star catalogue in J2000 equatorial coordinates, a planetary ephemeris, and SGP4 orbital elements) and turns them into a sentence a ten-year-old can act on: *go outside at 7:42, look low in the west, that moving point is a space station with people aboard it.*

The translation is the product. And it is aimed at people who are currently on the wrong side of the line: no telescope, no app store, no background knowledge, possibly a borrowed phone. Hence the name.

---

## Privacy and security

The app asks for one thing about you, and the design question was how little of it can leave.

- **Your position never leaves your device at full precision.** It is rounded to two decimal places, a little over a kilometre, at the one boundary where anything is sent. That is the difference between naming the town you are in and naming your street.
- **The sky is computed where you are standing.** Positions, rise and set times, satellite passes and the star field are all worked out in your browser. Even the AI's lookups run there: the endpoint relays the model's request back to the page, the page answers it out of astronomy-engine, and the result goes back. No server ever works out a position about you.
- **One request carries anything personal**, and it is a rounded coordinate sent to OpenStreetMap and Open-Meteo to put a name and a timezone on the place. The landing page says so in a sentence before you are asked for anything.
- **Location arrives only through the browser's own permission prompt**, and is kept in `localStorage` on your device. Never a cookie, never a URL.
- **The watsonx key is server-side only.** It is not in the client bundle, not in any `VITE_`-prefixed variable, and `.env` is not in the repository.
- **The endpoints that spend something refuse before they spend it.** `/api/ask`, `/api/embed` and `/api/place` check an origin allowlist and a per-address rate limit ahead of the IAM exchange, so a request that will not be served costs nothing.

What that is not: authentication. This is an app you open in a browser without an account, and a secret shipped to a browser is not a secret. The origin allowlist stops another site putting this app's AI behind its own page; it does not stop a caller that is not a browser, and [`scripts/verify/guard.check.ts`](scripts/verify/guard.check.ts) asserts that hole deliberately so a green tick cannot be read as a stronger claim than the code makes. The rate limit lives in one instance's memory, so on a serverless host the real ceiling is a multiple of the stated one.

The honest summary is that this was treated as a privacy problem rather than a security one. The interesting work was minimising what leaves the device at all, not adding a login.

## Honest limitations

- **The browser compass drifts.** It is less accurate than a native app's, and on some Android browsers it is not north-referenced at all. The app detects this, says so, and offers a manual correction rather than pretending to a precision it does not have. Where Chromium exposes `AbsoluteOrientationSensor` it is preferred, since a reading from that is north-referenced by definition rather than by hope; iOS uses `webkitCompassHeading` for the same reason.
- **Manual mode is a mode, not a breakage.** If orientation is unavailable for any reason, the sky is yours to drag and every position in it is still computed for your exact place and time. The compass only ever decides *which part* of that sky you are shown.
- **The compass needs https.** Not a limitation the app can fix: no browser hands the motion sensors to an insecure origin. The app distinguishes that case from genuinely absent hardware so the message is actionable.
- **An AR camera overlay is deliberately not implemented.** Locking labels onto a live camera image demands sensor precision the browser cannot reliably deliver. The stylized map is the product; a flaky AR mode would have undermined the thing that works.
- **Star positions are geometric.** Atmospheric refraction is applied to the Sun, Moon and planets but not to the 5,000 catalogue stars, where it would cost a per-star trig call for a shift under 0.6° that only matters within a degree or two of the horizon.
- **Times display in the device's timezone.** Correct for the ordinary case of standing where you are; if you type in coordinates on the far side of the world, the app tells you the times are still shown in your own timezone.
- **Passes are predicted for the ISS and Tiangong.** A 24-hour pass search over every bright satellite would be too slow on a low-end phone; other tracked satellites still appear live on the map when they are overhead.

---

## Credits and licences

Star astrometry from HYG v4.1, constellation figures from d3-celestial, ephemeris from astronomy-engine, SGP4 from satellite.js, orbital elements from Celestrak, place names from Nominatim, timezones from Open-Meteo, narration from IBM Granite on watsonx.ai. Planet and Moon portraits are public-domain spacecraft photographs, never drawings.

<details>
<summary>Every source, with its licence</summary>

- [HYG Database v4.1](https://github.com/astronexus/HYG-Database), star astrometry, CC BY-SA 4.0
- [d3-celestial](https://github.com/ofrohn/d3-celestial), constellation figures, BSD-3-Clause
- [astronomy-engine](https://github.com/cosinekitty/astronomy), ephemeris, MIT
- [satellite.js](https://github.com/shashwatak/satellite-js), SGP4, MIT
- [Celestrak](https://celestrak.org/), orbital elements, free and keyless
- [Nominatim](https://nominatim.openstreetmap.org/) on OpenStreetMap data, place names, ODbL, free and keyless
- [Open-Meteo](https://open-meteo.com/), the IANA timezone at a coordinate, CC BY 4.0, free and keyless
- [IBM Granite](https://www.ibm.com/granite) on [watsonx.ai](https://www.ibm.com/products/watsonx-ai), narration, Apache 2.0 model family
- The Sun, the planets and the Moon are photographs, not drawings. Every portrait in the
  object column, the dossier and the guide panel is a spacecraft image, cut out
  of its frame by `scripts/fetch-bodies.mjs` and stored with its provenance in
  `public/bodies/credits.json`. All are public domain; the script refuses to
  ship anything that is not, because cropping a share-alike image would put a
  licence condition on this repository that nobody reading the code would find.
  <details>
  <summary>Every portrait, with its source and licence</summary>

  - Sun — [SDO 20240810 000000 4096 HMIIC (HMI).jpg](https://commons.wikimedia.org/wiki/File:SDO_20240810_000000_4096_HMIIC_(HMI).jpg), NASA/SDO and the AIA, EVE and HMI science teams. Public domain. HMI's continuum intensitygram, which is the photosphere in visible light; the extreme ultraviolet channels SDO is better known for are false colour by necessity, and on a page that promises nothing is invented those would have been the wrong picture.
  - Mercury — [Mercury in color - Prockter07-edit1.jpg](https://commons.wikimedia.org/wiki/File:Mercury_in_color_-_Prockter07-edit1.jpg), National Aeronautics and Space Administration / Johns Hopkins University Applied Physics Laboratory / Carnegie Institution of Washington. Public domain.
  - Venus — [Venus globe.jpg](https://commons.wikimedia.org/wiki/File:Venus_globe.jpg), NASA/JPL. Public domain.
  - Moon — [Moon nearside LRO.jpg](https://commons.wikimedia.org/wiki/File:Moon_nearside_LRO.jpg), NASA/GSFC/Arizona State University. Public domain.
  - Mars — [Mars Valles Marineris.jpeg](https://commons.wikimedia.org/wiki/File:Mars_Valles_Marineris.jpeg), NASA / USGS (PIA04304). Public domain.
  - Jupiter — [Jupiter and its shrunken Great Red Spot.jpg](https://commons.wikimedia.org/wiki/File:Jupiter_and_its_shrunken_Great_Red_Spot.jpg), NASA, ESA, and A. Simon (Goddard Space Flight Center). Public domain.
  - Saturn — [Saturn (planet) large.jpg](https://commons.wikimedia.org/wiki/File:Saturn_(planet)_large.jpg), Voyager 2. Public domain.
  - Uranus — [Uranus2.jpg](https://commons.wikimedia.org/wiki/File:Uranus2.jpg), NASA/JPL-Caltech. Public domain.
  - Neptune — [Neptune Full.jpg](https://commons.wikimedia.org/wiki/File:Neptune_Full.jpg), NASA. Public domain.

  </details>

  Stars and satellites are deliberately *not* photographed. A star has no disc
  you could resolve from the ground, and a satellite overhead is a moving point
  of light; both get a drawn point in a sighting ring, which is what they are.

  The Sun is photographed on the sky chart and drawn on the landing page. On the
  chart it is an object being pointed at, like the planets beside it. On the
  landing page nothing is being pointed at anything and the Sun is the light the
  scene is lit by, where a photograph of a disc pasted into a gradient reads as a
  sticker rather than as a source.

- The Royal Observatory on the landing page is derived from [*Flamsteed House, Royal Observatory, Greenwich, London*](https://commons.wikimedia.org/wiki/File:Flamsteed_House,_Royal_Observatory,_Greenwich,_London,_20260719_0921_4494.jpg) by Jakub Hałun, CC BY 4.0, via Wikimedia Commons. The sky is cut out of it column by column and the remainder pushed towards a silhouette, so the photograph contributes a building and never a sky
- Typefaces: Cormorant Garamond, Unbounded and Share Tech Mono (Google Fonts)

</details>
