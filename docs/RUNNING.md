# Running and deploying Borrowed Sky

The app runs with no credentials at all: the astronomy is computed in the
browser and the guide falls back to its deterministic narrator. Credentials add
IBM Granite, and nothing else changes.

---

## Running it locally

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
