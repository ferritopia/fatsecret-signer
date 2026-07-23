# fatsecret-signer

A Cloudflare Worker that signs FatSecret **OAuth 1.0 (HMAC-SHA1) 3-legged** requests so an n8n AI Agent can write to a personal FatSecret food journal.

## Why this exists

FatSecret's API splits into two auth models:

- **Read** endpoints (`foods.search`, `food.get`) work with **OAuth2 client credentials** — n8n handles these natively.

- **Write** endpoints on a user's journal (`food_entry.create`) require **OAuth 1.0 3-legged**: a per-user Access Token + Access Secret, with every request signed using **HMAC-SHA1** (the only method FatSecret supports).

n8n cannot produce a valid HMAC-SHA1 OAuth1 signature for this flow:

- Its **OAuth1 Generic credential** ("Connect my account") fails against FatSecret's 3-legged flow (returns HTTP 400).

- `require('crypto')` is **blocked** inside the n8n Code node.

- The n8n **Crypto node** only offers MD5/SHA256/SHA3/SHA384/SHA512 for HMAC — **no SHA1**.

So signing is done in this Worker instead. n8n calls the Worker with a simple JSON payload; the Worker signs, forwards to FatSecret, and returns the raw response.

## Architecture

AI Agent (n8n)
└─ tool: fatsecret_food_journal_create (HTTP Request Tool)
└─ POST https://{worker}/journal   (Authentication: None, header x-proxy-secret)
└─ Cloudflare Worker (this repo)
├─ builds OAuth1 signature base string
├─ HMAC-SHA1 via Web Crypto (crypto.subtle)
└─ POST https://platform.fatsecret.com/rest/server.api


Read tools (`fatsecret_food_search`, `fatsecret_food_get`) keep using n8n's OAuth2 credential directly and do **not** go through this Worker.

## Endpoints

| Method | Path       | Purpose                                          |
| ------ | ---------- | ------------------------------------------------ |
| GET    | `/`        | Health check — returns `fatsecret-signer ok`     |
| POST   | `/journal` | Sign + forward a `food_entry.create.v2` request  |

### `POST /journal`

Headers:

- `Content-Type: application/json`
- `x-proxy-secret: <PROXY_SECRET>` — required only if the `PROXY_SECRET` secret is set.

Body:

``` json
{
  "food_id": "3092",
  "serving_id": "32999",
  "number_of_units": "1",
  "meal": "breakfast",
  "food_entry_name": "Chicken Breast",
  "date": "2026-07-22"
} 
```

- ‎⁠meal⁠ must be one of: ‎⁠breakfast⁠, ‎⁠lunch⁠, ‎⁠dinner⁠, ‎⁠snack⁠.

- ‎⁠date⁠ accepts ‎⁠YYYY-MM-DD⁠ or an integer “days since epoch”. If omitted, defaults to today. FatSecret stores journal dates as days since 1970-01-01; the Worker converts automatically.

- Response is FatSecret’s raw JSON, passed through with its original status code.

## Files



|File            |Purpose                                                     |
|----------------|------------------------------------------------------------|
|`worker.js`     |Worker entry point — OAuth1 signing + forwarding logic      |
|`wrangler.jsonc`|Worker configuration (name, entry point, compatibility date)|
|`README.md`     |This document                                               |

## Secrets / environment

Set these as Secrets in the Cloudflare dashboard (Worker → Settings → Variables and Secrets → Add → type Secret). Never hardcode them in ‎⁠worker.js⁠.


|Name             |Required|Description                                                                                                                                               |
|-----------------|--------|----------------------------------------------------------------------------------------------------------------------------------------------------------|
|`CONSUMER_KEY`   |yes     |FatSecret Consumer Key (from the developer dashboard)                                                                                                     |
|`CONSUMER_SECRET`|yes     |FatSecret Consumer Secret                                                                                                                                 |
|`ACCESS_TOKEN`   |yes     |Per-user OAuth1 Access Token (from the 3-legged flow)                                                                                                     |
|`ACCESS_SECRET`  |yes     |Per-user OAuth1 Access Secret (from the 3-legged flow)                                                                                                    |
|`PROXY_SECRET`   |no      |A self-chosen random string. If set, callers must send it as the `x-proxy-secret` header. Not a FatSecret value — you invent it to lock down the endpoint.|


## Getting the Access Token + Access Secret (one time)

The 3-legged OAuth1 flow, run once outside n8n, yields a permanent per-user Access Token + Access Secret:

1. Request token — signed POST to ‎⁠https://authentication.fatsecret.com/oauth/request_token⁠ with ‎⁠oauth_callback=oob⁠.

2. Authorize — open ‎⁠https://authentication.fatsecret.com/oauth/authorize?oauth_token=<token>⁠, log in to FatSecret, approve. FatSecret shows a verifier PIN.

3. Access token — signed GET to ‎⁠https://authentication.fatsecret.com/oauth/access_token⁠ with the request token, its secret, and the verifier. Response contains ‎⁠oauth_token⁠ (Access Token) + ‎⁠oauth_token_secret⁠ (Access Secret).

Store both as the ‎⁠ACCESS_TOKEN⁠ / ‎⁠ACCESS_SECRET⁠ secrets above.

## Deploy (GitHub → Cloudflare, continuous)

1. Push this repo to GitHub with ‎⁠worker.js⁠ and ‎⁠wrangler.jsonc⁠ at the repo root.

2. Cloudflare dashboard → Workers & Pages → Create application → Import a repository.

3. Select the repo and production branch (‎⁠main⁠).

 - Build command: leave empty (a single-file Worker needs no build step).

 - Deploy command: leave the default (‎⁠npx wrangler deploy⁠).

4. Deploy. After this, every ‎⁠git push⁠ to ‎⁠main⁠ rebuilds and redeploys automatically.

5. Add the secrets (see above), then Deploy once more so they take effect.

Worker URL: ‎⁠https://fatsecret-signer.<subdomain>.workers.dev⁠. Health check: open the root URL and confirm it returns ‎⁠fatsecret-signer ok⁠.

## Free tier

Cloudflare Workers free plan allows 100,000 requests/day — far above this workload.

## Wire into n8n

In the ‎⁠fatsecret_food_journal_create⁠ HTTP Request Tool (called by the AI Agent):

- Authentication: None

- Method: POST

- URL: ‎⁠https://fatsecret-signer.<subdomain>.workers.dev/journal⁠

- Send Headers: on → ‎⁠x-proxy-secret⁠ = your ‎⁠PROXY_SECRET⁠

- Send Body: on → JSON:
```
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

If a secret leaks, regenerate it in the FatSecret dashboard, then update the Worker secret (dashboard → Settings → Variables and Secrets → Edit) and redeploy. No code change needed.

## Troubleshooting

|Symptom                                            |Likely cause                                                                                      |
|---------------------------------------------------|--------------------------------------------------------------------------------------------------|
|`Invalid signature` from FatSecret                 |Signed params differ from sent params, or base64 output mismatch. Check the signature base string.|
|HTTP 400 `problem generating the authorization URL`|Only relevant to n8n’s OAuth1 Connect flow — not used here; the Worker bypasses it.               |
|`401 unauthorized` from the Worker                 |`x-proxy-secret` header missing or doesn’t match the `PROXY_SECRET` secret.                       |
|Deploy button does nothing                         |`wrangler.jsonc` / `worker.js` not at repo root, or production branch not set.                    |
|Wrong journal date                                 |Send `YYYY-MM-DD` or leave `date` empty; the Worker handles the days-since-epoch conversion.      |

