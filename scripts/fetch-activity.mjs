#!/usr/bin/env node
// Refreshes _data/activity.json from GitHub public events and the blog RSS feeds.
// Each source is fetched independently; a failing source keeps its last good items.
// If every source fails, the existing file is left untouched.
import { readFile, writeFile, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const USER = "judahgabriel";
const MAX_PAGES = 3;
const PER_PAGE = 100;
const MAX_ITEMS = 30;
const MAX_POSTS_PER_BLOG = 5;
const MAX_FEED_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 15000;
const OUT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "_data", "activity.json");

const BLOGS = [
  {
    id: "kineti",
    name: "Kineti L'Tziyon",
    home: "https://blog.judahgabriel.com/",
    feed: "https://blog.judahgabriel.com/feeds/posts/default?alt=rss&redirect=false&max-results=10",
    host: "blog.judahgabriel.com",
  },
  {
    id: "debuggerdotbreak",
    name: "DebuggerDotBreak",
    home: "https://debuggerdotbreak.judahgabriel.com/",
    feed: "https://debuggerdotbreak.judahgabriel.com/feed/",
    host: "debuggerdotbreak.judahgabriel.com",
  },
];

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function cleanText(value, max = 200) {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function httpsUrlOnHost(value, host) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

const githubUrl = (value) => httpsUrlOnHost(value, "github.com");

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function toItem(event) {
  const repo = event?.repo?.name;
  if (!REPO_RE.test(repo ?? "")) return null;
  if (String(event?.actor?.login ?? "").toLowerCase() !== USER) return null;
  const createdAt = new Date(event.created_at);
  if (Number.isNaN(createdAt.getTime())) return null;

  const repoUrl = `https://github.com/${repo}`;
  const p = event.payload ?? {};
  const base = { id: `github-${event.id}`, source: "github", context: repo, context_url: repoUrl, created_at: createdAt.toISOString() };

  switch (event.type) {
    case "PushEvent": {
      const branch = cleanText(String(p.ref ?? "").replace(/^refs\/heads\//, ""), 80);
      const count = Number.isInteger(p.distinct_size) ? p.distinct_size : Number.isInteger(p.size) ? p.size : null;
      const commits = Array.isArray(p.commits) ? p.commits : [];
      const lastMessage = cleanText(commits.at(-1)?.message?.split("\n")[0]);
      let url = repoUrl;
      if (SHA_RE.test(p.before ?? "") && SHA_RE.test(p.head ?? "") && !/^0+$/.test(p.before)) {
        url = `${repoUrl}/compare/${p.before.slice(0, 12)}...${p.head.slice(0, 12)}`;
      } else if (SHA_RE.test(p.head ?? "")) {
        url = `${repoUrl}/commit/${p.head}`;
      }
      const what = count ? plural(count, "commit") : "commits";
      return { ...base, kind: "push", label: "Pushed", action: `Pushed ${what}${branch ? ` to ${branch} in` : " to"}`, title: lastMessage, url };
    }
    case "PullRequestEvent": {
      const pr = p.pull_request ?? {};
      const action = p.action === "closed" && pr.merged ? "merged" : p.action;
      if (!["opened", "closed", "merged", "reopened"].includes(action)) return null;
      const num = Number.isInteger(p.number ?? pr.number) ? (p.number ?? pr.number) : null;
      const verb = action[0].toUpperCase() + action.slice(1);
      return { ...base, kind: "pull-request", label: "Pull request", action: `${verb} pull request${num ? ` #${num}` : ""} in`, title: cleanText(pr.title), url: githubUrl(pr.html_url) ?? (num ? `${repoUrl}/pull/${num}` : repoUrl) };
    }
    case "PullRequestReviewEvent": {
      const pr = p.pull_request ?? {};
      return { ...base, kind: "review", label: "Review", action: `Reviewed pull request${Number.isInteger(pr.number) ? ` #${pr.number}` : ""} in`, title: cleanText(pr.title), url: githubUrl(p.review?.html_url) ?? githubUrl(pr.html_url) ?? repoUrl };
    }
    case "IssuesEvent": {
      const issue = p.issue ?? {};
      if (!["opened", "closed", "reopened"].includes(p.action)) return null;
      const verb = p.action[0].toUpperCase() + p.action.slice(1);
      return { ...base, kind: "issue", label: "Issue", action: `${verb} issue${Number.isInteger(issue.number) ? ` #${issue.number}` : ""} in`, title: cleanText(issue.title), url: githubUrl(issue.html_url) ?? repoUrl };
    }
    case "IssueCommentEvent": {
      if (p.action !== "created") return null;
      const issue = p.issue ?? {};
      const kindWord = issue.pull_request ? "pull request" : "issue";
      return { ...base, kind: "comment", label: "Comment", action: `Commented on ${kindWord}${Number.isInteger(issue.number) ? ` #${issue.number}` : ""} in`, title: cleanText(issue.title), url: githubUrl(p.comment?.html_url) ?? githubUrl(issue.html_url) ?? repoUrl };
    }
    case "CreateEvent": {
      if (p.ref_type === "repository") return { ...base, kind: "create", label: "Created", action: "Created repository", title: cleanText(p.description), url: repoUrl };
      if (p.ref_type === "tag") {
        const tag = cleanText(p.ref, 80);
        return { ...base, kind: "create", label: "Tagged", action: `Created tag ${tag ?? ""} in`.replace("  ", " "), title: null, url: tag ? `${repoUrl}/releases/tag/${encodeURIComponent(tag)}` : repoUrl };
      }
      return null;
    }
    case "ReleaseEvent": {
      if (p.action !== "published") return null;
      const release = p.release ?? {};
      return { ...base, kind: "release", label: "Release", action: "Published a release in", title: cleanText(release.name || release.tag_name), url: githubUrl(release.html_url) ?? `${repoUrl}/releases` };
    }
    case "ForkEvent":
      return { ...base, kind: "fork", label: "Forked", action: "Forked", title: null, url: githubUrl(p.forkee?.html_url) ?? repoUrl };
    case "WatchEvent":
      return { ...base, kind: "star", label: "Starred", action: "Starred", title: null, url: repoUrl };
    case "PublicEvent":
      return { ...base, kind: "create", label: "Open sourced", action: "Made public", title: null, url: repoUrl };
    default:
      return null;
  }
}

async function fetchPage(page) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": `${USER}-github-io-activity-feed`,
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const url = `https://api.github.com/users/${USER}/events/public?per_page=${PER_PAGE}&page=${page}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} ${res.statusText} for page ${page}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`Unexpected response shape for page ${page}`);
  return data;
}

async function fetchGitHub() {
  const items = [];
  const seen = new Set();
  for (let page = 1; page <= MAX_PAGES && items.length < MAX_ITEMS; page++) {
    const events = await fetchPage(page);
    for (const event of events) {
      const item = toItem(event);
      if (item && !seen.has(item.id)) {
        seen.add(item.id);
        items.push(item);
      }
      if (items.length >= MAX_ITEMS) break;
    }
    if (events.length < PER_PAGE) break;
  }
  return items;
}

const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function xmlField(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"));
  if (!match) return null;
  const cdata = match[1].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const raw = cdata ? cdata[1] : decodeEntities(match[1]);
  return decodeEntities(raw.replace(/<[^>]*>/g, ""));
}

async function fetchBlog(blog) {
  const res = await fetch(blog.feed, {
    headers: { Accept: "application/rss+xml, application/xml;q=0.9, */*;q=0.5", "User-Agent": `${USER}-github-io-activity-feed` },
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${blog.name} feed returned ${res.status} ${res.statusText}`);
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_FEED_BYTES) throw new Error(`${blog.name} feed is too large`);
  const xml = await res.text();
  if (xml.length > MAX_FEED_BYTES) throw new Error(`${blog.name} feed is too large`);
  if (!/<rss[\s>]/i.test(xml)) throw new Error(`${blog.name} feed is not RSS`);

  const items = [];
  for (const [, body] of xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi)) {
    const title = cleanText(xmlField(body, "title"));
    const url = httpsUrlOnHost(xmlField(body, "link"), blog.host);
    const date = new Date(xmlField(body, "pubDate") ?? "");
    if (!title || !url || Number.isNaN(date.getTime())) continue;
    items.push({
      id: `${blog.id}-${url}`,
      source: blog.id,
      kind: "blog",
      label: "Blog post",
      action: "New post on",
      context: blog.name,
      context_url: blog.home,
      title,
      url,
      created_at: date.toISOString(),
    });
  }
  if (items.length === 0) throw new Error(`${blog.name} feed had no usable posts`);
  items.sort((a, b) => b.created_at.localeCompare(a.created_at));
  return items.slice(0, MAX_POSTS_PER_BLOG);
}

async function main() {
  let previous = null;
  try {
    previous = JSON.parse(await readFile(OUT_FILE, "utf8"));
  } catch {
    // No previous feed yet.
  }
  const previousItems = Array.isArray(previous?.items) ? previous.items : [];

  const sources = [
    { id: "github", load: fetchGitHub },
    ...BLOGS.map((blog) => ({ id: blog.id, load: () => fetchBlog(blog) })),
  ];
  const results = await Promise.allSettled(sources.map((s) => s.load()));

  const items = [];
  let failures = 0;
  results.forEach((result, i) => {
    const { id } = sources[i];
    if (result.status === "fulfilled") {
      console.log(`${id}: ${result.value.length} items`);
      items.push(...result.value);
    } else {
      failures++;
      const kept = previousItems.filter((item) => item.source === id);
      console.log(`::warning::${id} refresh failed; keeping ${kept.length} previous items. ${result.reason?.message ?? result.reason}`);
      items.push(...kept);
    }
  });
  if (failures === sources.length) throw new Error("all sources failed");

  items.sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (previous?.generated_at && JSON.stringify(previousItems) === JSON.stringify(items)) {
    console.log(`No new activity (${items.length} items); leaving feed unchanged.`);
    return;
  }

  const feed = { generated_at: new Date().toISOString(), items };
  const tmp = `${OUT_FILE}.tmp`;
  await writeFile(tmp, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  await rename(tmp, OUT_FILE);
  console.log(`Wrote ${items.length} activity items.`);
}

main().catch((err) => {
  console.error(`Activity refresh failed; keeping the previous feed. ${err.message}`);
  process.exitCode = 1;
});
