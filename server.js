import express from "express";
import crypto from "crypto";

const app = express();
app.use(express.json());

// --- credentials from environment (set at deploy time) ---
const {
  CONSUMER_KEY,
  CONSUMER_SECRET,
  ACCESS_TOKEN,
  ACCESS_SECRET,
  PROXY_SECRET, // optional shared secret to protect the endpoint
  PORT = 8080,
} = process.env;

for (const k of ["CONSUMER_KEY", "CONSUMER_SECRET", "ACCESS_TOKEN", "ACCESS_SECRET"]) {
  if (!process.env[k]) {
    console.error(`Missing required env var: ${k}`);
    process.exit(1);
  }
}

const FATSECRET_URL = "https://platform.fatsecret.com/rest/server.api";

// RFC3986 percent-encoding
function pct(str) {
  return encodeURIComponent(str).replace(
    /[!*'()]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// FatSecret expects `date` as integer days since epoch (1970-01-01).
// Accept either that, or a YYYY-MM-DD string, or nothing (defaults to today).
function normalizeDate(input) {
  if (input === undefined || input === null || input === "") {
    return Math.floor(Date.now() / 86400000).toString();
  }
  const s = String(input);
  if (s.includes("-")) {
    return Math.floor(new Date(s + "T00:00:00Z").getTime() / 86400000).toString();
  }
  return s; // already a number-string
}

app.get("/", (_req, res) => res.send("fatsecret-signer ok"));

app.post("/journal", async (req, res) => {
  try {
    if (PROXY_SECRET) {
      if (req.header("x-proxy-secret") !== PROXY_SECRET) {
        return res.status(401).json({ error: "unauthorized" });
      }
    }

    const b = req.body || {};

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
      oauth_consumer_key: CONSUMER_KEY,
      oauth_token: ACCESS_TOKEN,
      oauth_signature_method: "HMAC-SHA1",
      oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
      oauth_nonce: crypto.randomBytes(16).toString("hex"),
      oauth_version: "1.0",
    };

    const all = { ...params, ...oauth };
    const normalized = Object.keys(all)
      .sort()
      .map((k) => `${pct(k)}=${pct(all[k])}`)
      .join("&");
    const base = `POST&${pct(FATSECRET_URL)}&${pct(normalized)}`;
    const key = `${pct(CONSUMER_SECRET)}&${pct(ACCESS_SECRET)}`;
    const signature = crypto.createHmac("sha1", key).update(base).digest("base64");

    const bodyParams = new URLSearchParams({ ...all, oauth_signature: signature });

    const fsRes = await fetch(FATSECRET_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: bodyParams.toString(),
    });

    const text = await fsRes.text();
    res.status(fsRes.status);
    res.setHeader("content-type", fsRes.headers.get("content-type") || "application/json");
    res.send(text);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log(`fatsecret-signer listening on :${PORT}`));
