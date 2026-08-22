# Borrowed Sky

**A zero-install sky companion that tells anyone, anywhere, what is overhead right now, and explains it like a patient guide, not a data dump.**

Open it in a browser. Point your phone up. It names what you are looking at, computed for the exact spot you are standing on and the exact minute it is.

Built for the AI Builders Challenge, Space Exploration theme.

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

## The core principle: nothing is fabricated

This was the hard rule of the build, and it shaped every technical decision.

**Every number in this app is computed from real astronomical data.** There is no mock data anywhere, including during development. There is no placeholder sky. If a data source is unavailable, the app says so and shows a stated failure state; it never fills the gap with a guess.

Concretely:

- **Star positions** come from the [HYG Database v4.1](https://github.com/astronexus/HYG-Database), 5,070 real stars to magnitude 6.0, with J2000 astrometry, parallax distances, and spectral classes. Star colours are derived from each star's actual B–V colour index via Ballesteros' formula and a blackbody fit, not picked by hand.
- **The Milky Way** is placed by computing the real galactic frame from the IAU pole, so the band lies where our galaxy actually is, running the way it actually runs, with the bright bulge towards Sagittarius and the faint anticentre towards Auriga. It fades out as the sky brightens or the Moon rises, because that is what it does outdoors.
- **The afterglow** low on the horizon sits on the Sun's computed azimuth and is scaled by its computed altitude. Turn to face it and it stays put; it points at where the Sun actually went down.
- **Sun, Moon and planet positions** are computed with [astronomy-engine](https://github.com/cosinekitty/astronomy). Positions are apparent (equator of date, with aberration and atmospheric refraction) so they match what an observer actually sees.
- **Satellite positions** are propagated with SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)) from live orbital elements published by [Celestrak](https://celestrak.org/). No pass time is looked up or approximated; each one is searched for numerically from the elements.
- **The AI never computes anything.** It receives a finished, structured description of the sky and turns it into a sentence. It is explicitly instructed that the data it is given is the only source of truth and that it must refuse rather than guess.

### Explanations come from somewhere too

The guard stops the model stating a position it was not given. That covers where things are, and the people this app is for ask about both: *why is Mars red*, *what does magnitude mean*, *why does the Moon change shape*. Those were answered from memory, which is the one thing the rest of the project refuses to do. A recalled fact is unverifiable and usually right, and "usually right" is the standard this app exists to beat.

So there is a corpus. [`scripts/build-corpus.mjs`](scripts/build-corpus.mjs) reads NASA's own science writing, which is public domain, cuts it into passages, records the page and the date each one came from, and embeds it. When a question is asked, it is embedded too and compared against every passage in the browser; the closest few are sent with the question, and the model is told to explain from them and to name the source. The guide may say what a thing is, as long as somebody it can cite said it first.

Three things this gets right, and each of them is a way it could have gone wrong quietly:

- **The embedding model is recorded in the file.** Vectors from two different models compare perfectly well and mean nothing: the arithmetic runs, the numbers look reasonable, and the passages that come back are noise in the shape of an answer. If the corpus was built by a model other than the one embedding the question, retrieval returns nothing and says why. There is no degraded mode.
- **There is a floor, and it was measured.** Retrieval always returns something, because there is always a closest vector. [`corpus.check.ts`](scripts/verify/corpus.check.ts) asks six real questions and three deliberately unrelated ones: the real ones land between 0.76 and 0.89, and the best that "how do I poach an egg" managed was 0.54. The first draft of the threshold was 0.55, one hundredth above that, which is a coin toss wearing a rule's clothing. It is 0.65 now, in the middle of the gap, and the check fails if that gap ever closes.
- **Retrieved passages are evidence.** They join the pool the grounding guard tests against, so a number quoted out of a NASA passage is supported and one invented around it is not.

### The one thing that is looked up rather than computed

A place name cannot be derived from first principles. Everything above the horizon in this app comes out of astronomy-engine, SGP4 and the catalogues it ships, but "you are near Udupi, and the clocks there are on Asia/Kolkata" is a fact about people, and somebody had to write it down first.

So it is asked for, and this is the only request in the app that carries anything about the user. The two existing network paths do not: Celestrak is asked for orbital elements and knows nothing about who is asking, and watsonx is sent a sky that has already been computed. This one sends a coordinate.

Three things follow, and they are the whole of [`api/place.ts`](api/place.ts):

- **The coordinates are rounded to two decimal places before they leave.** That is a little over a kilometre, which is the difference between naming the town somebody is in and naming their street. The town is all that is being asked for.
- **Nothing is invented when it fails.** There is no "somewhere near" and no guessed country. The endpoint reports the failure and the plate goes on showing the coordinates it already had, which were computed and are true.
- **It stays a narrow pipe.** Two fixed upstreams and nothing passed through from the caller but a latitude and a longitude, so it cannot be used as a general proxy by anyone who finds it.

The landing page says all of this in one sentence before you are asked for anything.

### The one thing that is drawn rather than computed

The foreground (the hills and the water at the bottom of the frame) is invented. It is scenery, and the app fences it in accordingly: it is clipped strictly **below the true horizon**, the brass line, so it can never sit in front of a real object or imply a skyline that is not there. Everything above that line is computed; the foreground is the frame around it.

The distinction is deliberate rather than convenient. The Milky Way could easily have been painted on as a decorative smear and nobody would have checked; it is computed instead, and verified against published positions. The hills genuinely cannot be (nobody knows what is on your horizon) so rather than guess at a skyline, they are kept somewhere they cannot mislead, and named here.

### Visible is not the same as "above the horizon"

A satellite overhead is invisible if it is in Earth's shadow. A planet above the horizon is invisible if the sky is still bright. Getting this wrong means sending someone outside to look at nothing.

So the app models all three conditions and reports them separately: a pass is only *visible* when the satellite is sunlit **and** the observer's sky is dark **and** it clears 10° of altitude. Satellites currently in eclipse are drawn with a marker that says so.

### Verification

The astronomy is checked against sources independent of the code, not against itself:

```
npm run verify                               # typecheck + every check below
npx tsx scripts/verify/frames.check.ts       # coordinate transforms
npx tsx scripts/verify/satellites.check.ts   # SGP4, eclipse test, pass search
npx tsx scripts/verify/events.check.ts       # timeline across four latitudes
npx tsx scripts/verify/milkyway.check.ts     # galactic frame
npx tsx scripts/verify/grounding.check.ts    # the guard on Granite's answers
npx tsx scripts/verify/place.check.ts        # the clock-difference note
npx tsx scripts/verify/tools.check.ts        # the functions the model may call
npx tsx scripts/verify/corpus.check.ts       # what retrieval finds, and declines
npm run verify:granite                       # live call to watsonx, needs credentials
```

- `frames.check.ts` cross-checks the fast matrix pipeline against astronomy-engine's own `DefineStar → Equator → Horizon` path, two routes sharing no code. They agree to **0.01 arcseconds** across five stars, four sites and three dates.
- `satellites.check.ts` validates propagation against physics derived independently: ISS altitude, orbital speed, period (92.8 min), and the fraction of each orbit spent in sunlight (~63%), plus invariants on every predicted pass.
- `events.check.ts` runs the timeline at Johannesburg, Delhi, the equator, and Svalbard in midsummer, where the Sun never sets and the correct answer is "there is no darkness tonight."
- `place.check.ts` covers the one comparison the place lookup does to its own answer: whether the clocks on screen are the clocks where the observer is standing. It exists because the obvious version, comparing the two zone names, shipped and was wrong. Browsers still report legacy aliases, so a phone in India says `Asia/Calcutta` where the lookup returns `Asia/Kolkata`, and a person sitting at home was told their own clock disagreed with their own location. A wrong warning is worse than no warning, so the comparison is on the offsets the zones are actually set to, and the cases cover aliases, summer time, half-hour offsets and zones that do not resolve.
- `milkyway.check.ts` checks the galactic frame against published equatorial positions. Sagittarius A\* (the observational anchor for the galactic centre) lands **0.1 arcseconds** from its catalogue position, and the north celestial pole round-trips exactly, which catches a pole-angle error that testing the centre alone would miss.

There are also three headless-Chrome integration passes (`npm run verify:ui`) that drive the real app over the DevTools protocol. `screenshot.mjs` and `interact.mjs` assert that tapping an object opens a panel with real readings, that explanations render, and that journal entries persist and plot. `compass.mjs` covers the two orientation paths that otherwise need a physical phone on a real https origin: it loads the app by LAN address to confirm an insecure origin is reported as a connection problem, then shims Safari's gated `requestPermission` to confirm the hook actually subscribes once permission is granted and reads `webkitCompassHeading` as north-referenced.

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
│   ├── milkyway.ts        Galactic frame; places the band on the real sky
│   └── events.ts          Tonight's visibility windows
├── src/lib/ai.ts          Context builder + deterministic fallback narrator
└── src/components/        Sky canvas, timeline, guide, journal

Server (serverless functions)
├── api/tle.ts             Celestrak proxy, Celestrak sends no CORS header,
│                          so a browser cannot reach it directly
└── api/ask.ts             watsonx.ai proxy, keeps the API key off the client
```

**Data flow:** geolocation + current time → positions computed in the browser → structured object list → AI narration layer → device orientation selects which part of the computed sky is drawn.

### Why the sky map is fast

Placing 5,000 stars per animation frame the obvious way (convert each to alt/az, then to screen) is too slow on the cheap hardware this is meant for. Instead the whole chain (J2000 → horizontal → camera → screen) is collapsed into a single 4×3 matrix rebuilt once per frame. Per star that is twelve multiplies and no trigonometry. Stars are batched into twelve colour buckets so the renderer issues one fill per bucket instead of one per star.

The horizon is not traced point by point either. Stereographic projection maps every circle on the sphere to a circle in the plane, so *every* line of constant altitude (the horizon, and each layer of the foreground beneath it) is solved for analytically rather than walked. The galactic band is drawn by stamping one pre-rendered sprite hundreds of times instead of building hundreds of radial gradients, which is the difference between the band existing and not.

---

## The AI layer: IBM Granite on watsonx.ai

The narration runs on **IBM watsonx.ai** with **IBM Granite**. `api/ask.ts` tries `ibm/granite-3-3-8b-instruct` first and walks a short list of Granite models if a project's region or plan does not offer it, then remembers which one answered. `WATSONX_MODEL_ID` pins a specific one.

### What Granite is asked to do, and what it is forbidden from doing

Every position, time, magnitude, phase and distance is computed in the browser by astronomy-engine and SGP4 first. Only then is a finished JSON description of that sky handed to Granite. The division is absolute, and the system prompt exists to enforce it:

> The JSON block you are given is the ONLY authoritative description of this observer's sky. Never state a position, altitude, direction, time, distance or brightness that is not present in that JSON. If you are asked something the JSON does not answer, say plainly that you cannot see it in tonight's data. Never guess.

So Granite is doing language work, not astronomy. Concretely, it is doing the part of the job that no amount of template writing can cover:

- **Understanding an untrained question.** "What's that bright one?", "is the space station coming over?", "why does the Moon look like that tonight?" are all answered against the same JSON, and the model has to work out which of the objects in it the person means.
- **Choosing what is worth mentioning.** A clear night hands the model a dozen objects. Which two matter to someone standing outside with no telescope is a judgement, not a sort.
- **Saying "I can't see that in tonight's data"** when the question is about something the JSON does not contain, instead of reaching into training data for a plausible-sounding answer.
- **Two registers.** *Explain like I'm 10* and *Standard* change vocabulary and sentence length, never the underlying numbers.

### What happens when Granite is unavailable

**The app does not go quiet and does not start guessing.** It falls back to a deterministic narrator (`narrateLocally` in `src/lib/ai.ts`) that assembles sentences from the very same computed values, and the interface states which of the two is speaking on every answer. That is why the app is fully functional with no credentials at all: Granite carries the language, never the correctness.

The fallback is deliberately plainer than Granite, and it is honest about the difference. Ask the local narrator a free-form question and it answers with the sky summary plus a note that the AI guide was not reached, because a template cannot parse the question and pretending otherwise would be the fabrication this project is built to avoid.

### Checking it actually works

```
npm run verify:granite
```

This is a real call, not a mock. It exchanges the API key for an IAM token, lists the Granite models the project is genuinely offered, computes a live sky context for Greenwich with the same code the browser runs, sends one grounded request, and prints what Granite says. Each of the three stages fails with its own message, because a bad key, a wrong region and an unavailable model look identical from the app and need different fixes.

---

## Built with IBM Bob

One piece of this project is owned end to end by [IBM Bob](https://bob.ibm.com/): **the grounding guard**, the check that compares each of Granite's answers against the JSON it was given and refuses to show one that makes a claim the computed sky does not support.

It was chosen deliberately. Every other data path here is verified by something that shares no code with the thing it verifies, which is why the coordinate transforms and the orbital propagation can be trusted rather than merely believed. The narration path is the exception: the model is told not to invent, and nothing checks that it obeyed. Closing that gap is the most valuable single piece of work left in the repository, and it is also cleanly separable, which is what makes it a fair test of a coding agent rather than a demonstration arranged to succeed.

The brief handed to Bob is [`BOB-TASK.md`](BOB-TASK.md), written before any of the work started: the module signature, the three classes of claim to check, the tolerance rule, the retry behaviour, eight test cases, and the constraint that its tests compute a real sky rather than fabricating one.

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

So the feature failed three times, for three unrelated reasons: an unfair baseline hiding a broken Sun term, a dataset whose published timestamps have the sign of the offset inverted, and a conversion that quietly redefined daylight. The heuristic is still there, with the finding written above it.

What survives is the finding itself, which is worth more than the feature would have been. The Globe at Night export files a US observer's 20:04 local as 14:04 UT on the same date, when an eight o'clock evening observation at UTC-6 is 02:04 UT the following day. Derive a Sun altitude from those columns and 53.1% of naked-eye star chart observations land in daylight, which cannot happen; derive it from the local clock and the longitude and it falls to 7.7%. Anyone fitting anything to that dataset needs to know this, and it is recorded here because the code it was found in no longer exists.

---

## Running it

```bash
npm install
npm run catalog   # downloads HYG + constellation data, builds public/data/
npm run dev       # http://localhost:5173, which also serves /api/* locally
```

`npm run dev` binds to all interfaces, so you can open it on a phone on the same network.

**To test the compass you need https, not just a LAN address:**

```bash
npm run dev:https   # same server, self-signed certificate
```

Browsers refuse to release the motion sensors to an insecure origin, and they refuse silently: Safari keeps `DeviceOrientationEvent` on `window` but never fires a reading, Chrome deletes the interface. Over `http://192.168.x.x:5173` a phone with a perfectly good compass is indistinguishable from a phone with none, which is why the app checks `isSecureContext` first and names the connection as the cause rather than blaming the hardware.

The certificate is self-signed, so the first visit warns you. On iPhone: **Show Details → visit this website → Visit**. Then open the sky view and tap *Turn on compass tracking*. A deployed build over real https needs none of this.

**A tunnel is nicer than a self-signed certificate for phone testing:**

```bash
npm run dev:tunnel   # dev server behind a real certificate, no account needed
```

This runs the same dev server behind a Cloudflare quick tunnel, which terminates TLS on a `*.trycloudflare.com` hostname phones already trust. No warning to tap through, and hot reload works through it, so it is the better setup while building. The URL is new on every run; that is the trade for needing no account.

**If location is refused on a phone, suspect the OS before the page.** iOS can refuse on Safari's behalf, and when it does the Geolocation API reports `PERMISSION_DENIED` with no prompt ever shown, which is identical to a denial the user actually chose. The fix lives in Settings → Privacy & Security → Location Services, where both the master toggle and the **Safari Websites** entry have to allow it. The compass working while location does nothing is *not* evidence about the certificate: motion sensors and geolocation are gated separately, so a self-signed origin can serve one and not the other for unrelated reasons.

Because those two cases give the same error code, the gate reads `navigator.permissions` and shows the state it gets back. A state of `prompt` alongside a denial means the browser still intended to ask and something above it said no, which points at the OS rather than the site, and so the gate offers that advice instead of the per-site advice. Where Safari declines to answer the query the state reads `unknown` and the guidance stays general.

The generated catalogues are committed, so `npm run catalog` is only needed to rebuild them from source.

**Optional: enable Granite narration**

Two values are needed, from two different consoles. The free watsonx.ai plan covers this.

1. **A project ID.** Go to [dataplatform.cloud.ibm.com](https://dataplatform.cloud.ibm.com/wx/home?context=wx) and sign in with the IBM Cloud account. If watsonx.ai has never been provisioned it offers to do so; take the free plan and note **which region you pick**, because it has to match `WATSONX_URL` later. Then **Projects → New project → Create an empty project**, name it, and once it exists open its **Manage** tab. The **Project ID** is under **General → Details**; copy it.

   A new project has no runtime attached to it. Open **Manage → Services & integrations → Associate service** and associate the **watsonx.ai Runtime** (previously called Machine Learning) instance. Without this the credentials are valid and every request still fails, which is the confusing one.

2. **An API key.** Go to [cloud.ibm.com/iam/apikeys](https://cloud.ibm.com/iam/apikeys) → **Create**, name it, and copy the key. It is shown once and cannot be read back; if it is lost, delete it and make another.

```bash
cp .env.example .env      # then paste both values in
npm run verify:granite    # real call, tells you exactly what is wrong if anything is
```

If the project was created outside Dallas, set `WATSONX_URL` to that region's endpoint too; the list is in `.env.example`. A region mismatch reports the project as missing rather than as misplaced.

**Deploy:** the repo is configured for Vercel (`vercel.json`); `api/*.ts` become serverless functions automatically. On a host with no serverless support the app still works; it will report that satellite passes and AI narration are unavailable rather than faking either.

### Deploying with the AI switched on

The endpoints read their configuration per request, so a deployment that goes
up without credentials starts answering with Granite the moment the credentials
exist. Nothing needs rebuilding for that. Two things do need doing, and the
second is easy to miss because its failure is silent.

1. **Set the environment variables on the host**: `WATSONX_API_KEY`,
   `WATSONX_PROJECT_ID`, and `WATSONX_URL` for the region the project lives in.
   Leave `OLLAMA_MODEL` unset there. A local Granite is a development
   convenience; on a deployment it would mean a broken watsonx configuration
   quietly looked like a working one.

2. **Rebuild the corpus with the embedder the deployment will use**:

   ```
   npm run corpus
   ```

   The shipped vectors record which model produced them, and a question embedded
   by a different model cannot be compared against them. `retrieve()` checks
   this and declines rather than returning nonsense, which is the right
   behaviour and an invisible one: retrieval simply stops and the citations
   disappear. Run this with watsonx credentials present so the corpus is built
   by the same model that will embed the questions, and commit the result.

Everything that is not the AI works without any of it: the sky, the timeline,
the compass, the fun facts and the place lookup need no key. A deployment with
no credentials at all is a working app that says which narrator is speaking.

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
  - Sun — [SDO 20240810 000000 4096 HMIIC (HMI).jpg](https://commons.wikimedia.org/wiki/File:SDO_20240810_000000_4096_HMIIC_(HMI).jpg), NASA/SDO and the AIA, EVE and HMI science teams. Public domain. HMI's continuum intensitygram, which is the photosphere in visible light; the extreme ultraviolet channels SDO is better known for are false colour by necessity, and on a page that promises nothing is invented those would have been the wrong picture.
  - Mercury — [Mercury in color - Prockter07-edit1.jpg](https://commons.wikimedia.org/wiki/File:Mercury_in_color_-_Prockter07-edit1.jpg), National Aeronautics and Space Administration / Johns Hopkins University Applied Physics Laboratory / Carnegie Institution of Washington. Public domain.
  - Venus — [Venus globe.jpg](https://commons.wikimedia.org/wiki/File:Venus_globe.jpg), NASA/JPL. Public domain.
  - Moon — [Moon nearside LRO.jpg](https://commons.wikimedia.org/wiki/File:Moon_nearside_LRO.jpg), NASA/GSFC/Arizona State University. Public domain.
  - Mars — [Mars Valles Marineris.jpeg](https://commons.wikimedia.org/wiki/File:Mars_Valles_Marineris.jpeg), NASA / USGS (PIA04304). Public domain.
  - Jupiter — [Jupiter and its shrunken Great Red Spot.jpg](https://commons.wikimedia.org/wiki/File:Jupiter_and_its_shrunken_Great_Red_Spot.jpg), NASA, ESA, and A. Simon (Goddard Space Flight Center). Public domain.
  - Saturn — [Saturn (planet) large.jpg](https://commons.wikimedia.org/wiki/File:Saturn_(planet)_large.jpg), Voyager 2. Public domain.
  - Uranus — [Uranus2.jpg](https://commons.wikimedia.org/wiki/File:Uranus2.jpg), NASA/JPL-Caltech. Public domain.
  - Neptune — [Neptune Full.jpg](https://commons.wikimedia.org/wiki/File:Neptune_Full.jpg), NASA. Public domain.

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
