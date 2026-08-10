# Borrowed Sky

**A zero-install sky companion that tells anyone, anywhere, what is overhead right now — and explains it like a patient guide, not a data dump.**

Open it in a browser. Point your phone up. It names what you are looking at, computed for the exact spot you are standing on and the exact minute it is.

Built for the AI Builders Challenge, Space Exploration theme.

---

## The problem

About a third of the world cannot see the Milky Way from where they live. But the harder problem is not light pollution — it is that even under a perfect sky, most people have no idea what they are looking at, or that anything is happening at all.

The tools that solve this assume you are already an enthusiast. They want an app install, a capable device, and a user who already knows the name of the thing they are trying to find. That excludes exactly the people for whom a first look at the sky would matter most: kids in township schools, refugee camps, rural and low-resource communities.

**Borrowed Sky is built for someone who has never used an astronomy tool, has no telescope, and does not know what a magnitude is.** No install. No account. No prior knowledge. It works on a cheap phone over a slow connection, and it tells you not just what is up there but *where to look* and *when to go outside*.

---

## What it does

**Live sky map.** A stylized star map that rotates as you turn, drawn from a real star catalogue. Tap anything to find out what it is. Where the compass is unavailable or refused, it becomes a drag-to-look map — clearly labelled as such, never silently pretending to track.

**Tonight's sky.** A horizontal timeline of what actually becomes visible over the coming hours: planet windows, moonrise, and visible station passes. The twilight band behind it is a plot of the real Sun altitude, so the darkness you see on the strip is the darkness that is coming.

**A guide you can ask.** "What's that bright one?" gets answered from the actual computed sky, with an *Explain like I'm 10* setting that changes the language rather than the facts.

**A sky journal.** Everything you have found, plotted on a planisphere that slowly fills in. Stored on your device — no account, nothing uploaded.

**Night vision.** A red-only mode across the entire interface, including the sky canvas. A bright screen costs you roughly twenty minutes of dark adaptation, which matters when the whole point is to go outside and look up.

---

## The core principle: nothing is fabricated

This was the hard rule of the build, and it shaped every technical decision.

**Every number in this app is computed from real astronomical data.** There is no mock data anywhere, including during development. There is no placeholder sky. If a data source is unavailable, the app says so and shows a stated failure state — it never fills the gap with a guess.

Concretely:

- **Star positions** come from the [HYG Database v4.1](https://github.com/astronexus/HYG-Database) — 5,070 real stars to magnitude 6.0, with J2000 astrometry, parallax distances, and spectral classes. Star colours are derived from each star's actual B–V colour index via Ballesteros' formula and a blackbody fit, not picked by hand.
- **Sun, Moon and planet positions** are computed with [astronomy-engine](https://github.com/cosinekitty/astronomy). Positions are apparent — equator of date, with aberration and atmospheric refraction — so they match what an observer actually sees.
- **Satellite positions** are propagated with SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)) from live orbital elements published by [Celestrak](https://celestrak.org/). No pass time is looked up or approximated; each one is searched for numerically from the elements.
- **The AI never computes anything.** It receives a finished, structured description of the sky and turns it into a sentence. It is explicitly instructed that the data it is given is the only source of truth and that it must refuse rather than guess.

### Visible is not the same as "above the horizon"

A satellite overhead is invisible if it is in Earth's shadow. A planet above the horizon is invisible if the sky is still bright. Getting this wrong means sending someone outside to look at nothing.

So the app models all three conditions and reports them separately: a pass is only *visible* when the satellite is sunlit **and** the observer's sky is dark **and** it clears 10° of altitude. Satellites currently in eclipse are drawn with a marker that says so.

### Verification

The astronomy is checked against sources independent of the code, not against itself:

```
npx tsx scripts/verify/frames.check.ts       # coordinate transforms
npx tsx scripts/verify/satellites.check.ts   # SGP4, eclipse test, pass search
npx tsx scripts/verify/events.check.ts       # timeline across four latitudes
```

- `frames.check.ts` cross-checks the fast matrix pipeline against astronomy-engine's own `DefineStar → Equator → Horizon` path — two routes sharing no code. They agree to **0.01 arcseconds** across five stars, four sites and three dates.
- `satellites.check.ts` validates propagation against physics derived independently: ISS altitude, orbital speed, period (92.8 min), and the fraction of each orbit spent in sunlight (~63%), plus invariants on every predicted pass.
- `events.check.ts` runs the timeline at Johannesburg, Delhi, the equator, and Svalbard in midsummer — where the Sun never sets and the correct answer is "there is no darkness tonight."

There are also two headless-Chrome integration passes (`screenshot.mjs`, `interact.mjs`) that drive the real app over the DevTools protocol and assert that tapping an object opens a panel with real readings, that explanations render, and that journal entries persist and plot.

---

## Architecture

```
Browser
├── public/data/           Star + constellation catalogues (static, cacheable)
├── src/lib/astro/
│   ├── frames.ts          Coordinate frames; collapses the whole transform
│   │                      chain into one 4×3 matrix per frame
│   ├── starfield.ts       Catalogue loading into typed arrays
│   ├── solar.ts           Sun/Moon/planet ephemeris
│   ├── satellites.ts      TLE parsing, SGP4, eclipse test, pass search
│   └── events.ts          Tonight's visibility windows
├── src/lib/ai.ts          Context builder + deterministic fallback narrator
└── src/components/        Sky canvas, timeline, guide, journal

Server (serverless functions)
├── api/tle.ts             Celestrak proxy — Celestrak sends no CORS header,
│                          so a browser cannot reach it directly
└── api/ask.ts             watsonx.ai proxy — keeps the API key off the client
```

**Data flow:** geolocation + current time → positions computed in the browser → structured object list → AI narration layer → device orientation selects which part of the computed sky is drawn.

### Why the sky map is fast

Placing 5,000 stars per animation frame the obvious way (convert each to alt/az, then to screen) is too slow on the cheap hardware this is meant for. Instead the whole chain — J2000 → horizontal → camera → screen — is collapsed into a single 4×3 matrix rebuilt once per frame. Per star that is twelve multiplies and no trigonometry. Stars are batched into twelve colour buckets so the renderer issues one fill per bucket instead of one per star.

The horizon is not traced point by point either. Stereographic projection maps every circle on the sphere to a circle in the plane, and the horizon is a great circle — so its screen image is solved for analytically and filled in one call.

---

## The AI layer

The narration runs on **IBM watsonx.ai** with **Granite** (`ibm/granite-3-3-8b-instruct` by default).

The system prompt's job is to stop the model from doing astronomy:

> The JSON block you are given is the ONLY authoritative description of this observer's sky. Never state a position, altitude, direction, time, distance or brightness that is not present in that JSON. If you are asked something the JSON does not answer, say plainly that you cannot see it in tonight's data. Never guess.

Two tones are offered — *Explain like I'm 10* and *Standard*. They change vocabulary and sentence length, never the underlying numbers.

**If watsonx is not configured or is unreachable, the app does not go quiet and does not start guessing.** It falls back to a deterministic narrator that assembles sentences from the very same computed values, and the interface states which of the two is speaking. That is why the app is fully functional with no credentials at all — the AI improves the prose, it is not load-bearing for correctness.

---

## Running it

```bash
npm install
npm run catalog   # downloads HYG + constellation data, builds public/data/
npm run dev       # http://localhost:5173 — also serves /api/* locally
```

`npm run dev` binds to all interfaces, so you can open it on a phone on the same network — which is the only way to test the compass.

The generated catalogues are committed, so `npm run catalog` is only needed to rebuild them from source.

**Optional — enable Granite narration:**

```bash
cp .env.example .env   # then fill in WATSONX_API_KEY and WATSONX_PROJECT_ID
```

**Deploy:** the repo is configured for Vercel (`vercel.json`); `api/*.ts` become serverless functions automatically. On a host with no serverless support the app still works — it will report that satellite passes and AI narration are unavailable rather than faking either.

---

## Addressing the Space Exploration theme

The challenge asks for tools that translate complex space data into clear insights, and for space education and public engagement.

Borrowed Sky takes three genuinely complex data sources — a star catalogue in J2000 equatorial coordinates, a planetary ephemeris, and SGP4 orbital elements — and turns them into a sentence a ten-year-old can act on: *go outside at 7:42, look low in the west, that moving point is a space station with people aboard it.*

The translation is the product. And it is aimed at people who are currently on the wrong side of the line: no telescope, no app store, no background knowledge, possibly a borrowed phone. Hence the name.

---

## Honest limitations

- **The browser compass drifts.** It is less accurate than a native app's, and on some Android browsers it is not north-referenced at all. The app detects this, says so, and offers a manual correction rather than pretending to a precision it does not have.
- **An AR camera overlay is deliberately not implemented.** Locking labels onto a live camera image demands sensor precision the browser cannot reliably deliver. The stylized map is the product; a flaky AR mode would have undermined the thing that works.
- **Star positions are geometric.** Atmospheric refraction is applied to the Sun, Moon and planets but not to the 5,000 catalogue stars, where it would cost a per-star trig call for a shift under 0.6° that only matters within a degree or two of the horizon.
- **Times display in the device's timezone.** Correct for the ordinary case of standing where you are; if you type in coordinates on the far side of the world, the app tells you the times are still shown in your own timezone.
- **Passes are predicted for the ISS and Tiangong.** A 24-hour pass search over every bright satellite would be too slow on a low-end phone; other tracked satellites still appear live on the map when they are overhead.

---

## Credits and licences

- [HYG Database v4.1](https://github.com/astronexus/HYG-Database) — star astrometry, CC BY-SA 4.0
- [d3-celestial](https://github.com/ofrohn/d3-celestial) — constellation figures, BSD-3-Clause
- [astronomy-engine](https://github.com/cosinekitty/astronomy) — ephemeris, MIT
- [satellite.js](https://github.com/shashwatak/satellite-js) — SGP4, MIT
- [Celestrak](https://celestrak.org/) — orbital elements, free and keyless
- Typefaces: Cabinet Grotesk (Fontshare), Newsreader and IBM Plex Mono (Google Fonts)
