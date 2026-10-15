import { createHmac, randomBytes } from "node:crypto";

const ID = /^[1-9]\d{0,24}$/;
const MAX_ITEMS = 30;
const encode = (value) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function oauthHeader(url, env, nonce = randomBytes(16).toString("hex"), timestamp = String(Math.floor(Date.now() / 1000))) {
  const oauth = {
    oauth_consumer_key: env.X_API_KEY,
    oauth_nonce: nonce,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp,
    oauth_token: env.X_ACCESS_TOKEN,
    oauth_version: "1.0",
  };
  const params = [...url.searchParams, ...Object.entries(oauth)]
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([ak, av], [bk, bv]) => ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`).join("&");
  const base = ["GET", `${url.origin}${url.pathname}`, params].map(encode).join("&");
  const key = `${encode(env.X_API_SECRET)}&${encode(env.X_ACCESS_TOKEN_SECRET)}`;
  oauth.oauth_signature = createHmac("sha1", key).update(base).digest("base64");
  return `OAuth ${Object.entries(oauth).map(([k, v]) => `${encode(k)}="${encode(v)}"`).join(", ")}`;
}

function postItem(post, expanded) {
  if (!ID.test(post.id ?? "") || typeof post.text !== "string" || !post.created_at) throw new Error("Invalid X post.");
  const date = new Date(post.created_at);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid X post date.");
  const repost = post.referenced_tweets?.find((ref) => ref.type === "retweeted");
  if (repost && !ID.test(repost.id ?? "")) throw new Error("Invalid X repost ID.");
  const original = repost ? expanded.find((tweet) => tweet.id === repost.id) : post;
  const text = original?.note_tweet?.text ?? original?.text ?? post.text;
  const title = text.replace(/<[^>]*>/g, "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 1000);
  return {
    id: `x-${post.id}`,
    source: "x",
    kind: "x",
    label: repost ? "X · Repost" : "X · Post",
    action: repost ? "Reposted on" : "Posted on",
    context: "X",
    context_url: "https://x.com/judahgabriel",
    title,
    url: repost ? `https://x.com/i/web/status/${repost.id}` : `https://x.com/judahgabriel/status/${post.id}`,
    created_at: date.toISOString(),
  };
}

export async function fetchXActivity(previous, sinceId, env = process.env, request = fetch) {
  const required = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET", "X_USER_ID"];
  if (required.some((key) => !env[key]?.trim())) return { items: previous, sinceId, skipped: true };
  if (!ID.test(env.X_USER_ID)) throw new Error("X_USER_ID must be a numeric X user ID.");
  if (sinceId && !ID.test(sinceId)) throw new Error("Invalid stored X cursor; keeping previous X activity.");

  const url = new URL(`https://api.x.com/2/users/${env.X_USER_ID}/tweets`);
  url.search = new URLSearchParams({
    max_results: "10",
    exclude: "replies",
    "tweet.fields": "created_at,referenced_tweets,note_tweet",
    expansions: "referenced_tweets.id",
  }).toString();
  if (sinceId) url.searchParams.set("since_id", sinceId);

  let res;
  try {
    res = await request(url, {
      headers: { Authorization: oauthHeader(url, env), Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch {
    throw new Error("X API request failed or timed out; keeping previous X activity.");
  }
  if (!res.ok) throw new Error(`X API returned HTTP ${res.status}; keeping previous X activity.`);
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error("Invalid X API JSON; keeping previous X activity.");
  }
  if (body.errors?.length || (!Array.isArray(body.data) && body.meta?.result_count !== 0)) {
    throw new Error("Incomplete X API response; keeping previous X activity.");
  }
  const posts = body.data ?? [];
  const items = posts.map((post) => postItem(post, body.includes?.tweets ?? []));
  // Use event IDs (including the repost event), never the original reposted post's ID.
  const ids = [...posts.map((post) => post.id), ...(sinceId ? [sinceId] : [])];
  const newest = ids.reduce((max, id) => !max || BigInt(id) > BigInt(max) ? id : max, null);
  const merged = [...new Map([...items, ...previous].map((item) => [item.id, item])).values()]
    .sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, MAX_ITEMS);
  return { items: merged, sinceId: newest };
}
