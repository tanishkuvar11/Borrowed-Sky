# Brief for IBM Bob: prove the app survives watsonx failing, then prove it works when it does not

This task has two parts and they are deliberately unequal.

**Part A can be run today and matters most.** It asks what a visitor sees when the hosted watsonx endpoint refuses: quota exhausted, credentials rejected, service unavailable, request throttled. The app claims to degrade rather than break, and that claim has never been tested against anything but a working endpoint.

**Part B cannot be run until the watsonx quota resets.** It is the hosted tool-calling check. Write it, do not pretend it passed, and say plainly in your report that it is unproven.

Do Part A first and completely. A half-finished Part A is worse than no Part B.

---

## Why this order

Everything in this app has been exercised against a *working* AI endpoint. The interesting question for anybody opening the deployed app is the opposite one: the endpoint is out of quota, or the key is wrong, or watsonx is briefly down. The app is supposed to fall back to a deterministic narrator and say which of the two is speaking. If that path is broken, the failure is invisible until the exact moment it matters.

---

## What already exists

- **`api/ask.ts`** returns a structured error for every refusal it can make. The ones that matter here are `ai_unconfigured` (no credentials), `rate_limited` (429), `ai_ungrounded` (502, the answer failed the grounding guard) and `ai_unavailable` (502, watsonx itself failed).
- **`src/lib/ai.ts`** holds the client side. `narrateLocally(context, tone, question)` is the deterministic fallback narrator, and the code around line 446 chooses a message from `detail.error`.
- **`scripts/verify/granite.check.ts`** is the existing live check. It covers three things and only three: the IAM token exchange, the foundation model listing, and one grounded chat completion. **It does not cover tool calling, embeddings, or any failure path.** Do not duplicate it; Part B extends past where it stops.
- **`scripts/verify/skymodel.mjs`** shows how to drive the real app in headless Chrome and, importantly, how to interfere with the network from the harness: it already blocks a URL with `Network.setBlockedURLs`. That is the technique Part A needs.

---

# Part A: what a visitor sees when the AI is not there

Write `scripts/verify/degrade.mjs`, in the shape of `skymodel.mjs`.

Drive the real app in headless Chrome, seed a site, get into the guide, and ask a question under each of the following conditions. Use `Fetch.enable` with request interception to return the failure, or `Network.setBlockedURLs` where a total failure is what you want.

For each case, assert **all three** of:

1. **An answer still appears.** The guide must not be left empty, spinning, or showing a raw error object.
2. **The answer contains real computed values.** The fallback narrates from the same sky data, so the text must carry something from it. Assert against a number or a name the page itself computed, not a fixed string.
3. **The interface says which narrator spoke.** The app's rule is that it always states whether an answer came from Granite or from the local narrator. Assert that the provenance line is present and does not claim Granite.

The cases:

| case | how to produce it |
|---|---|
| watsonx out of quota | intercept `/api/ask`, respond `502` with `{"error":"ai_unavailable"}` |
| credentials missing | intercept, respond `503` with `{"error":"ai_unconfigured"}` |
| throttled | intercept, respond `429` with `{"error":"rate_limited"}` |
| answer failed the guard | intercept, respond `502` with `{"error":"ai_ungrounded","unsupported":["magnitude 47"]}` |
| endpoint unreachable | block `*/api/ask*` entirely |
| endpoint hangs | intercept and never fulfil, then assert the app recovers rather than spinning forever |

That last case is the one most likely to be broken, so do not leave it out. If there is no timeout on the client request, say so in your report rather than working around it.

**Gate A1:** every case produces a visible, grounded answer.
**Gate A2:** no case leaves the interface claiming an answer came from Granite when it did not.
**Gate A3:** no case leaves an uncaught error in the console. Collect console errors over the run and assert the list is empty.

---

# Part B: hosted tool calling, written now and run later

Extend `scripts/verify/granite.check.ts` with two stages after the ones it already has.

**Stage 4: tool calling.** `api/ask.ts` offers Granite a set of functions it may call to ask the browser about the sky. Nothing has ever confirmed the hosted endpoint returns a well-formed tool call rather than describing one in prose. Send a question that can only be answered by calling a tool, and assert the response contains a structured tool call with a name the app recognises and arguments that parse.

**Stage 5: embeddings.** The retrieval corpus is built with `granite-embedding-30m`. Request one embedding from the hosted endpoint and assert the vector comes back with **384 dimensions**, which is what the stored corpus was built against. A different width means retrieval silently returns nonsense.

Both stages must fail with their own message, in the style the file already uses, because a quota refusal, an unavailable model and a malformed response need three different fixes.

**Do not run these against a live endpoint if the quota is exhausted, and do not report them as passing.** State in your report that Part B is written and unverified, and what command will verify it once quota is available.

---

## Acceptance

- `npm run typecheck` clean.
- `npm run verify` passes end to end.
- `npm run verify:ui` passes, with `degrade.mjs` added to the chain in `package.json` and **actually run and green**.
- `scripts/verify/granite.check.ts` compiles and its new stages are reachable, with the existing three stages unchanged.
- Nothing in `src/` changes unless Part A finds a genuine defect. If it does, fix it and say what it was.

## House style

Read two or three checks in `scripts/verify/` first, particularly `skymodel.mjs` for the browser-driving shape and `granite.check.ts` for the staged-failure shape. Comments explain *why*, especially where the obvious approach was rejected, and they are prose rather than labels. **There are no em dashes anywhere in this repository. Keep it that way.**

---

## After

Report Part A's results case by case, including the exact text the app showed in at least two of them. Then state plainly that Part B is unverified and why.

If Part A found a real defect in the fallback path, that is the most valuable thing this task can produce. Say what it was and what you changed, and do not bury it under the parts that worked.
