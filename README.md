# fatsecret-signer

A tiny signing proxy that lets an OAuth2-limited HTTP client (e.g. an n8n **HTTP Request Tool** driven by an AI Agent) write to a **personal FatSecret food journal**, which requires **OAuth 1.0 (HMAC-SHA1) 3-legged** authentication.

The service receives a simple JSON payload, builds and signs the OAuth1 request, forwards it to the FatSecret REST API, and returns the raw response.

## Why this exists

- FatSecret **read** endpoints (`foods.search`, `food.get`) work with OAuth2 client credentials.
- FatSecret **write** endpoints on a user's journal (`food_entry.create`) require **OAuth 1.0 3-legged** with a per-user Access Token + Access Secret, and signatures must use **HMAC-SHA1** (the only method FatSecret supports).
- n8n's OAuth1 Generic credential and its Crypto node cannot produce a valid HMAC-SHA1 signature for this flow, so signing is done here instead.

## Endpoints

| Method | Path       | Purpose                                   |
| ------ | ---------- | ----------------------------------------- |
| GET    | `/`        | Health check (returns `fatsecret-signer ok`) |
| POST   | `/journal` | Sign + forward a `food_entry.create.v2` request |

### `POST /journal`

Headers:

- `Content-Type: application/json`
- `x-proxy-secret: <PROXY_SECRET>` — required only if `PROXY_SECRET` env var is set.

Body:

```json
{
  "food_id": "3092",
  "serving_id": "32999",
  "number_of_units": "1",
  "meal": "breakfast",
  "food_entry_name": "Chicken Breast",
  "date": "2026-07-22"
}
```

Notes:

- `meal` must be one of `breakfast`, `lunch`, `dinner`, `snack`.
- `date` accepts `YYYY-MM-DD` **or** an integer "days since epoch". If omitted, defaults to today. FatSecret stores dates as days since 1970-01-01; the service converts for you.
- The response is FatSecret's raw JSON, passed through with its original status code.

## Prerequisites

You need four FatSecret values:

- **Consumer Key** and **Consumer Secret** — from your FatSecret developer dashboard.
- **Access Token** and **Access Secret** — obtained once via the 3-legged OAuth1 flow (see `docs/get-access-token.md`, or use the standalone `fatsecret-3legged.js` helper).

## Local run

```bash
npm install
CONSUMER_KEY=xxx \
CONSUMER_SECRET=xxx \
ACCESS_TOKEN=xxx \
ACCESS_SECRET=xxx \
PROXY_SECRET=some-random-string \
npm start
```

Test:

```bash
curl -X POST http://localhost:8080/journal \
  -H "Content-Type: application/json" \
  -H "x-proxy-secret: some-random-string" \
  -d '{"food_id":"3092","serving_id":"32999","number_of_units":"1","meal":"breakfast","food_entry_name":"Chicken Breast","date":"2026-07-22"}'
```

## Deploy to Google Cloud Run

### Option A — deploy directly from source (one-off)

From inside this folder, with `gcloud` authenticated and a project selected:

```bash
gcloud run deploy fatsecret-signer \
  --source . \
  --region asia-southeast2 \
  --allow-unauthenticated \
  --min-instances 0 \
  --max-instances 3 \
  --memory 256Mi \
  --cpu 1 \
  --set-env-vars "CONSUMER_KEY=xxx,CONSUMER_SECRET=xxx,ACCESS_TOKEN=xxx,ACCESS_SECRET=xxx,PROXY_SECRET=some-random-string"
```

`gcloud` prints a **Service URL** like `https://fatsecret-signer-xxxx.asia-southeast2.run.app`.

### Option B — GitHub → Cloud Run continuous deployment (recommended)

1. Push this repo to GitHub.
2. Cloud Run console → your service → **Edit & Deploy** → **Build** tab → **Continuously deploy from a repository** → **Set up with Cloud Build**.
3. Authorize GitHub, pick the repo and `main` branch, build type **Dockerfile**.
4. Set env vars + scaling once (below). After that, every `git push` to `main` rebuilds and redeploys automatically.

### Staying inside the free tier

- `--min-instances 0` → scales to zero; **no cost when idle** (most important).
- `256Mi` memory + `1` CPU → minimal usage per request.
- `--max-instances 3` → caps runaway scaling.
- Cloud Build free tier: 120 build-minutes/day (a build here takes ~1–2 min).

## Environment variables

| Variable          | Required | Description                                          |
| ----------------- | -------- | ---------------------------------------------------- |
| `CONSUMER_KEY`    | yes      | FatSecret Consumer Key                               |
| `CONSUMER_SECRET` | yes      | FatSecret Consumer Secret                            |
| `ACCESS_TOKEN`    | yes      | Per-user OAuth1 Access Token (from 3-legged flow)    |
| `ACCESS_SECRET`   | yes      | Per-user OAuth1 Access Secret (from 3-legged flow)   |
| `PROXY_SECRET`    | no       | If set, callers must send it as `x-proxy-secret`     |
| `PORT`            | no       | Defaults to `8080` (Cloud Run sets this)             |

**Never commit secrets.** They are provided at deploy time via Cloud Run env vars, not in the code. `.dockerignore` excludes `.env`.

## Wiring into n8n

In the `fatsecret_food_journal_create` HTTP Request Tool:

- **Authentication**: None
- **Method**: POST
- **URL**: `https://<service-url>/journal`
- **Send Headers**: on → `x-proxy-secret` = your `PROXY_SECRET`
- **Send Body**: on → JSON:

```json
{
  "food_id": "{{ $fromAI('food_id', 'FatSecret food ID.') }}",
  "serving_id": "{{ $fromAI('serving_id', 'Serving ID from Food Get.') }}",
  "number_of_units": "{{ $fromAI('number_of_units', 'Serving multiplier, e.g. 2.5') }}",
  "meal": "{{ $fromAI('meal', 'breakfast|lunch|dinner|snack') }}",
  "food_entry_name": "{{ $fromAI('food_entry_name', 'Display name in journal.') }}",
  "date": "{{ $fromAI('date', 'Date YYYY-MM-DD, or empty for today.') }}"
}
```

## Rotating credentials

If a secret leaks, regenerate it in the FatSecret dashboard, then update Cloud Run without touching the repo:

```bash
gcloud run services update fatsecret-signer \
  --region asia-southeast2 \
  --update-env-vars "CONSUMER_SECRET=new-secret"
```

## Files

- `server.js` — Express app: signs OAuth1 (HMAC-SHA1) and forwards to FatSecret.
- `package.json` — dependencies and start script.
- `Dockerfile` — container image for Cloud Run.
- `.dockerignore` — keeps `node_modules`, `.env`, etc. out of the image.
