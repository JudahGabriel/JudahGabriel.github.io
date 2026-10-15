import test from "node:test";
import assert from "node:assert/strict";
import { fetchXActivity, oauthHeader } from "./x-activity.mjs";

const env = {
  X_API_KEY: "key", X_API_SECRET: "secret",
  X_ACCESS_TOKEN: "token", X_ACCESS_TOKEN_SECRET: "token-secret",
  X_USER_ID: "12345",
};
const old = {
  id: "x-100", source: "x", kind: "x", label: "X · Post",
  action: "Posted on", context: "X", context_url: "https://x.com/judahgabriel",
  title: "Earlier post", url: "https://x.com/judahgabriel/status/100",
  created_at: "2026-10-01T10:00:00.000Z",
};
const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("OAuth signature matches the published OAuth 1.0 RFC example", () => {
  const header = oauthHeader(new URL("http://photos.example.net/photos?file=vacation.jpg&size=original"), {
    X_API_KEY: "dpf43f3p2l4k3l03", X_API_SECRET: "kd94hf93k423kf44",
    X_ACCESS_TOKEN: "nnch734d00sl2jdk", X_ACCESS_TOKEN_SECRET: "pfkkdhi9sl3r4s00",
  }, "kllo9940pd9333jh", "1191242096");
  assert.ok(header.includes('oauth_signature="tR3%2BTy81lMeYAr%2FFid0kMTYa%2FWM%3D"'));
});

test("missing configuration skips all network access and preserves prior X state", async () => {
  const result = await fetchXActivity([old], "100", {}, () => assert.fail("must not fetch"));
  assert.deepEqual(result, { items: [old], sinceId: "100", skipped: true });
});

test("one bounded incremental request includes reposts, preserves history, and uses original repost URL", async () => {
  let calls = 0;
  const result = await fetchXActivity([old], "100", env, async (url, options) => {
    calls++;
    assert.equal(url.origin, "https://api.x.com");
    assert.equal(url.pathname, "/2/users/12345/tweets");
    assert.equal(url.searchParams.get("max_results"), "10");
    assert.equal(url.searchParams.get("since_id"), "100");
    assert.equal(url.searchParams.get("exclude"), "replies");
    assert.ok(options.headers.Authorization.startsWith("OAuth "));
    return response({
      data: [
        { id: "103", text: "RT", created_at: "2026-10-03T00:00:00Z", referenced_tweets: [{ type: "retweeted", id: "88" }] },
        { id: "102", text: "<script>alert('x')</script>\u0000 & hello", created_at: "2026-10-02T00:00:00Z" },
      ],
      includes: { tweets: [{ id: "88", text: "An original post" }] },
      meta: { newest_id: "103", next_token: "not-followed" },
    });
  });
  assert.equal(calls, 1);
  assert.equal(result.sinceId, "103");
  assert.equal(result.items.length, 3);
  assert.equal(result.items[0].label, "X · Repost");
  assert.equal(result.items[0].url, "https://x.com/i/web/status/88");
  assert.equal(result.items[0].title, "An original post");
  assert.equal(result.items[1].title, "alert('x') & hello");
  assert.equal(result.items[1].url, "https://x.com/judahgabriel/status/102");
  assert.deepEqual(result.items[2], old);
});

test("an empty incremental response keeps previous posts and cursor", async () => {
  const result = await fetchXActivity([old], "100", env, async () => response({ meta: { result_count: 0 } }));
  assert.deepEqual(result.items, [old]);
  assert.equal(result.sinceId, "100");
});

for (const status of [401, 402, 429]) {
  test(`HTTP ${status} is surfaced without exposing response bodies or credentials`, async () => {
    await assert.rejects(
      fetchXActivity([old], "100", env, async () => response({ detail: "private-body" }, status)),
      { message: `X API returned HTTP ${status}; keeping previous X activity.` },
    );
  });
}

test("network timeout is surfaced without leaking credentials", async () => {
  await assert.rejects(
    fetchXActivity([old], "100", env, async () => { throw new Error("secret-url"); }),
    { message: "X API request failed or timed out; keeping previous X activity." },
  );
});

test("invalid payloads and partial API errors cannot advance the cursor", async () => {
  for (const body of [{ errors: [{ detail: "error" }] }, {}, { data: [{ id: "../evil", text: "bad" }] }]) {
    await assert.rejects(fetchXActivity([old], "100", env, async () => response(body)));
  }
});

test("X item URLs never come from API-provided URLs or text", async () => {
  const result = await fetchXActivity([], null, env, async () => response({
    data: [{ id: "999", created_at: "2026-10-02T00:00:00Z", text: "https://evil.example", url: "javascript:bad()" }],
    meta: { newest_id: "999" },
  }));
  assert.equal(result.items[0].url, "https://x.com/judahgabriel/status/999");
});

test("timeline request expands media for posts and their referenced originals", async () => {
  let requestUrl;
  const result = await fetchXActivity([], null, env, async (url) => {
    requestUrl = url;
    return response({
      data: [
        {
          id: "300", text: "RT", created_at: "2026-10-05T00:00:00Z",
          referenced_tweets: [{ type: "retweeted", id: "88" }],
        },
        {
          id: "299", text: "Photos", created_at: "2026-10-04T00:00:00Z",
          attachments: { media_keys: ["photo-1", "video-1", "gif-1", "photo-2", "photo-5"] },
        },
      ],
      includes: {
        tweets: [{ id: "88", text: "Original", attachments: { media_keys: ["repost-photo"] } }],
        media: [
          { media_key: "repost-photo", type: "photo", url: "https://pbs.twimg.com/media/original.jpg", alt_text: "original <photo>", width: 800, height: 600 },
          { media_key: "photo-1", type: "photo", url: "https://pbs.twimg.com/media/photo.jpg", alt_text: "A photo & text", width: 1200, height: 800 },
          { media_key: "video-1", type: "video", url: "https://pbs.twimg.com/media/video.mp4", preview_image_url: "https://pbs.twimg.com/ext_tw_video_thumb/video.jpg", alt_text: "A video", width: 1920, height: 1080 },
          { media_key: "gif-1", type: "animated_gif", preview_image_url: "https://pbs.twimg.com/tweet_video_thumb/gif.jpg", alt_text: "A GIF", width: 600, height: 600 },
          { media_key: "photo-2", type: "photo", url: "https://pbs.twimg.com/media/photo-2.jpg", width: 400, height: 600 },
          { media_key: "photo-5", type: "photo", url: "https://pbs.twimg.com/media/photo-5.jpg", width: 400, height: 600 },
        ],
      },
      meta: { newest_id: "300" },
    });
  });

  assert.equal(requestUrl.searchParams.get("expansions"), "attachments.media_keys,referenced_tweets.id");
  assert.equal(requestUrl.searchParams.get("tweet.fields").split(",").includes("attachments"), true);
  assert.equal(requestUrl.searchParams.get("media.fields"), "media_key,type,url,preview_image_url,alt_text,width,height");
  const [repost, post] = result.items;
  assert.deepEqual(repost.media[0], {
    type: "photo", url: "https://pbs.twimg.com/media/original.jpg",
    alt_text: "original <photo>", width: 800, height: 600, video: false,
  });
  assert.equal(post.media.length, 4);
  assert.deepEqual(post.media.map((media) => media.type), ["photo", "video", "animated_gif", "photo"]);
  assert.equal(post.media[0].alt_text, "A photo & text");
  assert.equal(post.media[0].width, 1200);
  assert.equal(post.media[1].url, "https://pbs.twimg.com/ext_tw_video_thumb/video.jpg");
  assert.equal(post.media[1].video, true);
  assert.equal(post.media[2].url, "https://pbs.twimg.com/tweet_video_thumb/gif.jpg");
  assert.equal(post.media[2].video, true);
  assert.equal(post.media[3].alt_text, "");
});

test("untrusted, incomplete, and unsupported media are discarded", async () => {
  const result = await fetchXActivity([], null, env, async () => response({
    data: [{
      id: "301", text: "Attachments", created_at: "2026-10-05T00:00:00Z",
      attachments: { media_keys: ["bad-host", "http", "missing", "unsupported", "bad-size", "good"] },
    }],
    includes: { media: [
      { media_key: "bad-host", type: "photo", url: "https://pbs.twimg.com.evil.example/x.jpg", width: 10, height: 10 },
      { media_key: "http", type: "photo", url: "http://pbs.twimg.com/x.jpg", width: 10, height: 10 },
      { media_key: "missing", type: "video", preview_image_url: "https://evil.example/x.jpg", width: 10, height: 10 },
      { media_key: "unsupported", type: "audio", url: "https://pbs.twimg.com/x.jpg", width: 10, height: 10 },
      { media_key: "bad-size", type: "photo", url: "https://pbs.twimg.com/x.jpg", width: -10, height: 0 },
      { media_key: "good", type: "photo", url: "https://pbs.twimg.com/good.jpg", width: 10, height: 10 },
    ] },
  }));
  assert.equal(result.items[0].media.length, 1);
  assert.equal(result.items[0].media[0].url, "https://pbs.twimg.com/good.jpg");
  assert.equal(result.items[0].media[0].width, 10);
});
