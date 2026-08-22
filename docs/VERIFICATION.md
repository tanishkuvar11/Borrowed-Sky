# Verification

How the astronomy in Borrowed Sky is proved, and against what.

The short version lives in [the README](../README.md#verification). This is the
detail: which check covers which claim, what independent source it is measured
against, and why several of them exist at all, which is usually because the
obvious version of the check shipped first and was wrong.

---

## The checks

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
npx tsx scripts/verify/skyquality.check.ts   # the fitted model, and what it may not touch
npm run verify:ui                            # four headless-Chrome passes over the real app
node scripts/verify/skymodel.mjs             # the model, in a browser, changing the chart
npm run verify:granite                       # live call to watsonx, needs credentials
```

- `frames.check.ts` cross-checks the fast matrix pipeline against astronomy-engine's own `DefineStar → Equator → Horizon` path, two routes sharing no code. They agree to **0.01 arcseconds** across five stars, four sites and three dates.
- `satellites.check.ts` validates propagation against physics derived independently: ISS altitude, orbital speed, period (92.8 min), and the fraction of each orbit spent in sunlight (~63%), plus invariants on every predicted pass.
- `events.check.ts` runs the timeline at Johannesburg, Delhi, the equator, and Svalbard in midsummer, where the Sun never sets and the correct answer is "there is no darkness tonight."
- `place.check.ts` covers the one comparison the place lookup does to its own answer: whether the clocks on screen are the clocks where the observer is standing. It exists because the obvious version, comparing the two zone names, shipped and was wrong. Browsers still report legacy aliases, so a phone in India says `Asia/Calcutta` where the lookup returns `Asia/Kolkata`, and a person sitting at home was told their own clock disagreed with their own location. A wrong warning is worse than no warning, so the comparison is on the offsets the zones are actually set to, and the cases cover aliases, summer time, half-hour offsets and zones that do not resolve.
- `milkyway.check.ts` checks the galactic frame against published equatorial positions. Sagittarius A\* (the observational anchor for the galactic centre) lands **0.1 arcseconds** from its catalogue position, and the north celestial pole round-trips exactly, which catches a pole-angle error that testing the centre alone would miss.

There are also four headless-Chrome integration passes (`npm run verify:ui`) that drive the real app over the DevTools protocol. `screenshot.mjs` and `interact.mjs` assert that tapping an object opens a panel with real readings, that explanations render, and that journal entries persist and plot. `compass.mjs` covers the two orientation paths that otherwise need a physical phone on a real https origin: it loads the app by LAN address to confirm an insecure origin is reported as a connection problem, then shims Safari's gated `requestPermission` to confirm the hook actually subscribes once permission is granted and reads `webkitCompassHeading` as north-referenced. `skymodel.mjs` renders the same night twice, with the fitted model allowed and blocked, and asserts the chart differs.

---
