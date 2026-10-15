import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const exec = promisify(execFile);
const scripts = path.dirname(fileURLToPath(import.meta.url));
for (const configured of [false, true]) {
  test(`GitHub and blogs still refresh when X ${configured ? "backfill returns 402" : "is not configured"}`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "activity-test-"));
    try {
      await mkdir(path.join(root, "scripts"));
      await mkdir(path.join(root, "_data"));
      for (const name of ["fetch-activity.mjs", "x-activity.mjs"]) {
        await copyFile(path.join(scripts, name), path.join(root, "scripts", name));
      }
      const old = {
        id: "x-100", source: "x", kind: "x", title: "Kept X post",
        created_at: "2026-10-01T00:00:00.000Z",
        url: "https://x.com/judahgabriel/status/100",
      };
      await writeFile(path.join(root, "_data", "activity.json"), JSON.stringify({
        generated_at: "2026-10-01T00:00:00Z",
        x_since_id: configured ? null : "100",
        ...(configured ? { x_backfill_restore_id: "100" } : {}),
        items: [old],
      }));
      await writeFile(path.join(root, "network.mjs"), `
        globalThis.fetch = async input => {
          const url = String(input);
          if (url.startsWith("https://api.x.com/")) {
            if (!${configured}) throw new Error("X must not be fetched");
            return new Response("{}", {status: 402});
          }
          if (url.startsWith("https://api.github.com/")) return new Response(JSON.stringify([
            {id:"42", actor:{login:"judahgabriel"}, repo:{name:"JudahGabriel/example"},
             created_at:"2026-10-15T00:00:00Z", type:"WatchEvent", payload:{}}
          ]));
          const host = new URL(url).hostname;
          return new Response('<rss><channel><item><title>Post</title><link>https://' + host +
            '/post</link><pubDate>Thu, 15 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>');
        };
      `);
      const env = { ...process.env };
      for (const key of ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET", "X_USER_ID"]) {
        env[key] = configured ? (key === "X_USER_ID" ? "12345" : "test-only") : "";
      }
      const { stdout } = await exec(process.execPath, [
        "--import", pathToFileURL(path.join(root, "network.mjs")).href, path.join(root, "scripts", "fetch-activity.mjs"),
      ], { env });
      assert.match(stdout, configured ? /X API returned HTTP 402/ : /X refresh skipped/);
      const feed = JSON.parse(await readFile(path.join(root, "_data", "activity.json"), "utf8"));
      assert.deepEqual(feed.items.find((item) => item.source === "x"), old);
      assert.equal(feed.x_since_id, "100");
      assert.equal(feed.x_backfill_restore_id, undefined);
      assert.ok(feed.items.some((item) => item.source === "github"));
      assert.ok(feed.items.some((item) => item.source === "kineti"));
      assert.ok(feed.items.some((item) => item.source === "debuggerdotbreak"));
      assert.equal(feed.items.at(-1).source, "x");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
