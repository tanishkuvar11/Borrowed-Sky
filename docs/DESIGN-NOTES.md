# Nothing is fabricated

The hard rule of the build, and the decisions that came out of it. The summary
is in [the README](../README.md#the-core-principle-nothing-is-fabricated); this
is the reasoning, including the three places the app does something other than
compute, and what fences each of them in.

---

## The rule

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

The same question about stars is what [the sky model](#machine-learning-a-sky-model-fitted-to-170000-human-observations) answers. Being above the horizon on a moonlit night in a city is not the same as being visible from there, and that difference was the one thing the app used to guess at.
