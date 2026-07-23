// fatsecret-signer — Cloudflare Worker version
// FatSecret 3-legged OAuth1 (HMAC-SHA1) signing proxy.
// Secrets are provided via Worker environment (wrangler secret / dashboard), NOT hardcoded.

const FATSECRET_URL = "https://platform.fatsecret.com/rest/server.api";

function pct(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function normalizeDate(input) {
  if (input === undefined || input === null || input === "") {
    return Math.floor(Date.now() / 86400000).toString();
  }
  const s = String(input);
  if (s.includes("-")) {
    return Math.floor(new Date(s + "T00:00:00Z").getTime() / 86400000).toString();
  }
  return s;
}

async function hmacSha1Base64(key, data) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(data));
  // ArrayBuffer -> base64
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("fatsecret-signer ok");
    }

    if (request.method !== "POST" || url.pathname !== "/journal") {
      return new Response("not found", { status: 404 });
    }

    if (env.PROXY_SECRET) {
      if (request.headers.get("x-proxy-secret") !== env.PROXY_SECRET) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
    }

    let b;
    try {
      b = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: "invalid json body" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }

    const params = {
      method: "food_entry.create.v2",
      food_id: String(b.food_id),
      serving_id: String(b.serving_id),
      number_of_units: String(b.number_of_units),
      meal: String(b.meal),
      food_entry_name: String(b.food_entry_name),
      date: normalizeDate(b.date),
      format: "json",
    };

    const oauth = {
      oauth_consumer_key: env.CONSUMER_KEY,
      oauth_token: env.ACCESS_TOKEN,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_nonce: crypto.randomUUID().replace(/-/g, ""),
      oauth_version: "1.0",
    };

    const all = { ...params, ...oauth };
    const normalized = Object.keys(all)
      .sort()
      .map((k) => `${pct(k)}=${pct(all[k])}`)
      .join("&");
    const base = `POST&${pct(FATSECRET_URL)}&${pct(normalized)}`;
    const signingKey = `${pct(env.CONSUMER_SECRET)}&${pct(env.ACCESS_SECRET)}`;
    const signature = await hmacSha1Base64(signingKey, base);

    const bodyParams = new URLSearchParams({ ...all, oauth_signature: signature });

    const fsRes = await fetch(FATSECRET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyParams.toString(),
    });

    const text = await fsRes.text();
    return new Response(text, {
      status: fsRes.status,
      headers: { "content-type": fsRes.headers.get("content-type") || "application/json" },
    });
  },
};
