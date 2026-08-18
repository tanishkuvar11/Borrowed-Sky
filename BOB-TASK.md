# Brief for IBM Bob: the grounding guard

This is a self-contained slice of Borrowed Sky, specified to be built in [IBM Bob](https://bob.ibm.com/). Open the repository in Bob and give it this file.

Nothing else in the app depends on this landing. If it is not built, Borrowed Sky works exactly as it does today. If it is built, the one promise the project makes about its AI stops being a matter of trust and becomes a check that runs on every answer.

---

## The problem to solve

Borrowed Sky computes the sky in the browser with astronomy-engine and SGP4, then hands a finished JSON description of it to IBM Granite on watsonx.ai and asks for a sentence. Granite is instructed, in the system prompt, never to state a position, time, distance or brightness that is not in that JSON.

That instruction is currently the *only* thing standing between a user and a hallucinated star. A prompt is a request, not a guarantee. The app's central claim is that nothing it shows is fabricated, and every other data path in it is verified by a check that runs independently of the code producing it (see `scripts/verify/*.check.ts`). The narration path is the one that is not.

**Build the missing check.** Granite's answer gets compared against the JSON it was given, and an answer containing a claim that JSON does not support is not shown.

---

## What to build

### 1. `api/_lib/grounding.ts`

A pure module. No network, no environment, no imports outside the standard library, so it can be tested on its own.

```ts
export interface GroundingReport {
  /** False when the answer makes at least one claim the context does not support. */
  ok: boolean;
  /** Human-readable list of the unsupported claims, for the retry prompt and logs. */
  unsupported: string[];
}

export function checkGrounding(answer: string, context: unknown): GroundingReport;
```

`context` is the `SkyContext` object defined in `src/lib/ai.ts`. Treat it as arbitrary JSON and walk it recursively rather than typing against that interface; the module must not import from `src/`.

Three classes of claim are checked. Anything else in the answer is prose and passes untouched.

**a. Measurements.** A number in the answer counts as a claim only when it carries an astronomical unit or role next to it: degrees (`30 degrees`, `30°`), magnitude (`magnitude 1.4`), distance (`km`, `kilometres`, `light years`, `million km`), percentage (`60% lit`), duration (`in 12 minutes`, `2 hours`), or a clock time (`20:20`, `8:42 pm`). A bare number in prose ("two planets are up") is not a claim and is ignored.

A measurement is supported when some number anywhere in the context is within tolerance of it: `abs(a - c) <= max(0.5, 0.05 * abs(c))`. Granite is explicitly encouraged by the system prompt to round and approximate ("about a third of the way up"), so an exact-match rule would reject correct answers. Numbers embedded inside context *strings* count too, because the context carries phrases like `"384,400 km away"` and `"light takes 8 minutes to cross it"`; strip thousands separators before comparing.

**b. Named objects.** Any capitalised body name in the answer must appear somewhere in the context. Cover the Sun, the Moon, the eight planets, Pluto, the ISS, Tiangong, and the star names the catalogue uses. Allow a small always-permitted list: `Earth`, `Milky Way`, `Borrowed Sky`, and the compass names below. Do not fail on ordinary capitalised sentence starts.

**c. Directions.** Any compass direction in the answer (`north`, `north-east`, `NE`, `northeast`, and every variant, both hyphenated and not) must appear in the context. The context writes them out in the form `compassPoint()` produces in `src/lib/astro/satellites.ts`; read that function to get the exact vocabulary.

Each unsupported claim goes into `unsupported` as a short phrase naming what was said and why it failed, for example `"magnitude 1.4 (nothing in tonight's data is within 5% of it)"` or `"Betelgeuse (not in tonight's sky)"`.

Be conservative in both directions and say so in the code comments: a guard that rejects correct answers is as damaging as one that lets fabrications through, because every rejection drops the user to the plainer local narrator.

### 2. Wire it into `api/ask.ts`

After a completion comes back and before it is sent to the client:

- Run `checkGrounding(text, skyContext)`.
- If `ok`, respond as now but add `checked: true` to the JSON payload.
- If not `ok`, send **one** retry to the same model, appending an assistant turn with the answer and a user turn naming the unsupported claims and instructing it to answer again using only the JSON. Check the retry the same way.
- If the retry also fails, respond `502` with `{ error: 'ai_ungrounded', unsupported }` and do not send the text. The client already falls back to the deterministic narrator on any non-OK response; this just gives it a reason.

Do not add a second retry. Two round trips is already the limit of what someone standing in a field will wait for.

### 3. Handle the new reason in `src/lib/ai.ts`

`askGuide` maps error codes to the note shown under the answer. Add `ai_ungrounded`, worded so it is honest without alarming: the AI's answer mentioned something that is not in tonight's computed data, so the built-in narrator answered instead.

### 4. `scripts/verify/grounding.check.ts`

Follow the shape of the existing checks in that directory: no test framework, plain assertions, `console.log` a line per case, exit non-zero on failure, and end with `PASS` or `FAIL` plus the failures. Add it to the `verify:astro` chain in `package.json`.

Build the context for the cases by calling the real `buildSkyContext` from `src/lib/ai.ts` on a real computed sky, the way `scripts/verify/granite.check.ts` does. **Do not hand-write a fake sky object.** This repository has one rule above all others: no fabricated astronomy data anywhere, including in tests. A hand-written context would also silently stop matching the real shape the first time `buildSkyContext` changes.

Cases that must pass, each asserted against a context computed at run time:

| # | Answer under test | Expected |
|---|---|---|
| 1 | A sentence built from values read out of the computed context | `ok: true` |
| 2 | The same sentence with the altitude rounded to the nearest 5 degrees | `ok: true` (tolerance) |
| 3 | The same sentence with the altitude replaced by one 30 degrees off | `ok: false` |
| 4 | An object named that is not in the context | `ok: false`, named in `unsupported` |
| 5 | A compass direction the context never mentions for anything | `ok: false` |
| 6 | Pure prose with no numbers, names or directions | `ok: true` |
| 7 | `"I can't see that in tonight's data."` | `ok: true`, the refusal must never be blocked |
| 8 | A magnitude that no object in the context has | `ok: false` |

---

## Acceptance

- `npm run typecheck` clean.
- `npx tsx scripts/verify/grounding.check.ts` prints `PASS`.
- `npm run verify:granite` still passes with credentials set, and the answer it prints is judged grounded.
- With `WATSONX_API_KEY` unset, the app behaves exactly as before. The guard is on the Granite path only.
- `api/_lib/grounding.ts` imports nothing from `src/` and nothing from `node_modules`.

## House style

Read a few existing files first. Comments in this repository explain *why* a decision was made, especially where the obvious approach was rejected, and they are written in prose rather than as labels. There are no em dashes anywhere in the repository; keep it that way. Prefer a named function over a clever expression.

---

## After Bob

Record what happened for the write-up, honestly: which parts Bob planned, wrote, or corrected, what it got wrong first, and what needed human judgement. A truthful account of a real collaboration is worth more than a claim of autonomy, and it is the thing the README section on Bob is for.
