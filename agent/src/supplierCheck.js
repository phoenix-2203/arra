// Supplier check: before locking money for someone found on Instagram, TikTok or X,
// importers scroll the supplier's page by hand to see whether it looks real. Arra's
// agent does that for them: it buys the public profile from the buy gateway over x402
// on Celo mainnet (a few tenths of a cent, paid in USDT from the agent's tagged wallet;
// the gateway covers gas) and turns it into a few plain facts and warnings.
//
// Spending is bounded: a cap per call, a daily cap, a 24-hour cache per handle, and the
// server's per-visitor limits. Every payment is logged with its settlement transaction.
import { x402 } from "@celo/buy-core";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PLATFORMS = {
  instagram: { label: "Instagram", path: "/v1/social/instagram/profile", body: (h) => ({ username: h }), url: (h) => `https://www.instagram.com/${h}/` },
  tiktok: { label: "TikTok", path: "/v1/social/tiktok/profile", body: (h) => ({ username: h }), url: (h) => `https://www.tiktok.com/@${h}` },
  x: { label: "X", path: "/v1/social/x/tools/tikhub-api-v1-twitter-web-fetch-user-profile", body: (h) => ({ queryParams: { screen_name: h } }), url: (h) => `https://x.com/${h}` },
};
const HANDLE_RE = /^[A-Za-z0-9._]{1,40}$/;
const DAY = 86400_000;

/** "@Phoenix.Store " or "instagram.com/phoenix.store" → "phoenix.store". */
export function cleanHandle(raw) {
  const input = String(raw ?? "").trim();
  const PAGE = /^(https?:\/\/)?(www\.|m\.)?(instagram\.com|tiktok\.com|x\.com|twitter\.com)\/@?/i;
  // A link to some other website isn't a username ("shop.ng" on its own can be one).
  if (!PAGE.test(input) && /^(https?:\/\/|www\.)/i.test(input)) return null;
  const h = input.replace(PAGE, "").replace(/[/?#].*$/, "").replace(/^@/, "");
  if (/^(instagram|tiktok|x|twitter)\.com$/i.test(h)) return null;
  return HANDLE_RE.test(h) ? h.toLowerCase() : null;
}

// ---- reading whatever shape the profile comes back in -------------------------------
// Lists of posts or videos inside a profile answer. Dates count as "last post" only inside
// one of these; the account's own fields (followers, the date it was created) only outside.
// Without this, an account created in 2019 looked like it last posted in 2019.
const POST_LISTS = new Set(["items", "edges", "edge_owner_to_timeline_media", "media", "posts", "videos", "itemList", "item_list", "aweme_list", "video_list", "tweets", "timeline", "reels", "feed", "latest_posts", "recent_posts", "recent_media", "user_posts", "medias"]);
function walk(obj, visit, depth = 0, inPost = false) {
  if (!obj || typeof obj !== "object" || depth > 7) return;
  for (const [k, v] of Object.entries(obj)) {
    visit(k, v, inPost);
    if (v && typeof v === "object") walk(v, visit, depth + 1, inPost || POST_LISTS.has(k));
  }
}
function first(obj, keys, test) {
  let found;
  walk(obj, (k, v, inPost) => {
    if (found === undefined && !inPost && keys.includes(k) && test(v)) found = v;
  });
  return found;
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined);
const isNum = (v) => num(v) !== undefined;
const isStr = (v) => typeof v === "string" && v.trim().length > 0;
/** Seconds since 1970 from a unix time (s or ms) or a date string, if it looks like one. */
function epoch(v) {
  const n = num(v);
  if (n !== undefined) return n > 1e12 ? Math.floor(n / 1000) : n > 1e9 ? n : undefined;
  if (typeof v === "string" && /\d{4}|\w{3} \w{3} \d/.test(v)) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : Math.floor(t / 1000);
  }
  return undefined;
}

export function summarize(data) {
  const followers = num(first(data, ["follower_count", "followers_count", "followerCount", "followersCount", "followers", "sub_count", "subscriber_count", "fans", "fansCount", "follower"], isNum)) ?? num(first(data, ["edge_followed_by"], (v) => isNum(v?.count))?.count);
  const following = num(first(data, ["following_count", "followingCount", "friends_count", "follows_count", "following", "friends"], isNum));
  const posts = num(first(data, ["media_count", "mediaCount", "posts_count", "postsCount", "statuses_count", "videoCount", "video_count", "aweme_count", "postCount"], isNum)) ?? num(first(data, ["edge_owner_to_timeline_media"], (v) => isNum(v?.count))?.count);
  const verified = first(data, ["is_verified", "verified", "isVerified", "is_blue_verified", "blue_verified"], (v) => typeof v === "boolean");
  const priv = first(data, ["is_private", "private", "privateAccount", "protected", "is_protected"], (v) => typeof v === "boolean");
  const name = first(data, ["full_name", "fullName", "nickname", "displayName", "name"], isStr);
  const bio = first(data, ["biography", "bio", "description", "signature", "desc"], isStr);
  const createdAt = epoch(first(data, ["created_at", "createdAt", "create_time", "createTime", "account_created_at"], (v) => epoch(v) !== undefined));
  // Only dates found on actual posts. If the answer carries no posts, the last post is
  // unknown, and no "hasn't posted" warning is given.
  let lastPostAt;
  walk(data, (k, v, inPost) => {
    if (inPost && ["taken_at", "taken_at_timestamp", "createTime", "create_time", "timestamp", "created_at", "createdAt"].includes(k)) {
      const t = epoch(v);
      if (t && t <= Date.now() / 1000 + 86400 && (!lastPostAt || t > lastPostAt)) lastPostAt = t;
    }
  });
  return {
    name: name?.slice(0, 80) ?? null,
    bio: bio?.slice(0, 200) ?? null,
    followers: followers ?? null,
    following: following ?? null,
    posts: posts ?? null,
    verified: verified ?? null,
    private: priv ?? null,
    createdAt: createdAt ?? null,
    lastPostAt: lastPostAt ?? null,
  };
}

/** Plain-words warnings a careful buyer would notice on the page. */
export function flags(s, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  if (s.private) out.push("Private account: you can't see their posts.");
  if (s.followers !== null && s.followers < 200) out.push(`Only ${s.followers} followers.`);
  if (s.posts !== null && s.posts < 10) out.push(`Only ${s.posts} posts.`);
  if (s.createdAt && now - s.createdAt < 180 * 86400) out.push("The account is less than 6 months old.");
  if (s.lastPostAt && now - s.lastPostAt > 180 * 86400) out.push("No posts in the last 6 months.");
  return out;
}

// ---- public complaints: X and Reddit posts that name the seller ---------------------
// Words people actually use when a seller took the money. Searching for them narrows the
// results; each post still has to name this seller, and the seller's own posts are dropped
// (shops often post "beware of fake pages using our name").
export const COMPLAINT_RE = /\bscam|\bscammed|\bscammer|\bfraud|\bfake\b|\bthie(f|ves)|\bstole|never deliver|didn'?t deliver|did not deliver|not deliver|no delivery|ran away|blocked me|\brefund|don'?t buy|do not buy|\bbeware|ripped off|not as (described|pictured|advertised)|wrong (item|goods|product)|\b419\b/i;
const TEXT_KEYS = ["full_text", "text", "selftext", "body", "content", "title"];
const AUTHOR_KEYS = ["screen_name", "username", "author", "user_name", "userName"];
const URL_KEYS = ["permalink", "url", "tweet_url", "link", "postUrl"];
const ID_KEYS = ["id_str", "rest_id", "tweet_id", "id"];

/** Pulls posts out of any search answer: objects that carry some text, an author and a link or id. */
export function extractPosts(data, source) {
  const out = [];
  const seen = new Set();
  const visit = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(visit);
    const own = (keys) => keys.map((k) => o[k]).find((v) => typeof v === "string" && v.trim());
    const title = typeof o.title === "string" ? o.title : "";
    // Reddit's newer answers nest the text: { content: { markdown } } and { authorInfo: { name } }.
    const nested = o.content && typeof o.content === "object" ? o.content.markdown ?? o.content.text ?? null : null;
    const body = own(TEXT_KEYS.filter((k) => k !== "title")) ?? (typeof nested === "string" && nested.trim() ? nested : undefined);
    const text = [title, body && body !== title ? body : ""].filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
    if (text.length >= 12) {
      let author = own(AUTHOR_KEYS) ?? (typeof o.authorInfo?.name === "string" ? o.authorInfo.name : null) ?? (o.user && typeof o.user === "object" ? AUTHOR_KEYS.map((k) => o.user[k]).find((v) => typeof v === "string") : null) ?? (o.core?.user_results?.result?.legacy?.screen_name) ?? null;
      let url = own(URL_KEYS) ?? null;
      const id = ID_KEYS.map((k) => o[k]).find((v) => (typeof v === "string" || typeof v === "number") && /^\d{6,}$/.test(String(v)));
      if (url && url.startsWith("/r/")) url = `https://www.reddit.com${url}`;
      const t3 = typeof o.id === "string" && /^t3_[a-z0-9]+$/i.test(o.id) ? o.id.slice(3) : null;
      if (!url && source === "reddit" && t3) url = `https://www.reddit.com/comments/${t3}/`;
      if (!url && source === "x" && id && author) url = `https://x.com/${author}/status/${id}`;
      const at = epoch(o.created_utc ?? o.created_at ?? o.createdAt ?? o.created ?? o.timestamp);
      if ((url || id || t3) && !seen.has(text)) {
        seen.add(text);
        out.push({ source, text: text.slice(0, 400), author: author ? String(author).replace(/^u\//, "") : null, url: url && /^https:\/\//.test(url) ? url : null, at: at ?? null });
      }
    }
    for (const v of Object.values(o)) if (v && typeof v === "object") visit(v);
  };
  visit(data);
  return out;
}

/**
 * Keeps posts that could be a customer's complaint about this seller. Dropped: the seller's
 * own posts, posts older than two years (people and shops change), and posts that tag a
 * crowd of accounts (replies like "@a @b @c @d scam?" are noise, not a buyer's story).
 */
export function complaintCandidates(posts, handle, name, nowSec = Math.floor(Date.now() / 1000)) {
  const names = [handle, name && name.trim().length >= 5 ? name.trim() : null].filter(Boolean).map((x) => x.toLowerCase());
  return posts.filter((p) => {
    const t = p.text.toLowerCase();
    if (p.author && p.author.toLowerCase() === handle.toLowerCase()) return false;
    if (p.at && nowSec - p.at > 2 * 365 * 86400) return false;
    if ((p.text.match(/@\w+/g) ?? []).length >= 4) return false;
    // "zero scam signals", "not a scam", "legit, no fraud": praise, not a complaint.
    const plain = p.text.replace(NEGATED_RE, " ");
    return names.some((n) => t.includes(n)) && COMPLAINT_RE.test(plain);
  });
}
const NEGATED_RE = /\b(no|zero|not|never|isn'?t|wasn'?t|ain'?t|without)\s+(a\s+|an\s+|any\s+)?(scam\w*|fraud\w*|fake\w*|refund\w*)/gi;

// The stablecoins the gateway takes on Celo (6 decimals each). The agent pays with whichever it holds.
const TOKENS = { USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", USAT: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" };
const balanceAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];
const SEARCH = {
  x: { path: "/v1/social/x/posts/search", body: (q) => ({ query: q, type: "latest" }) },
  reddit: { path: "/v1/social/reddit/posts/search", body: (q) => ({ query: q, sort: "relevance", timeRange: "all" }) },
};

export function supplierChecker({ account, client = null, dataDir, gateway = process.env.BUY_GATEWAY ?? "https://gateway.usebuy.ai", network = process.env.BUY_NETWORK ?? "celo", dailyCapUsd = Number(process.env.BUY_DAILY_CAP_USD ?? 0.5), fetchImpl, now = () => Date.now(), judge = null }) {
  const dir = join(dataDir, "supplier-checks");
  mkdirSync(dir, { recursive: true });
  const log = join(dataDir, "buy-payments.jsonl");
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const spentToday = () => {
    if (!existsSync(log)) return 0;
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((p) => p.at.slice(0, 10) === day() && p.outcome !== "rejected").reduce((s, p) => s + Number(p.amount) / 1e6, 0);
  };
  const cached = (file) => {
    if (!existsSync(file)) return null;
    const c = JSON.parse(readFileSync(file, "utf8"));
    return now() - Date.parse(c.at) < DAY ? c : null;
  };
  let tokenChoice = null;
  // One check in flight per page: a second visitor asking at the same moment waits for it
  // instead of paying again.
  const inflight = new Map();
  const shared = (key, fn) => {
    if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
    return inflight.get(key);
  };
  const unavailable = () => Object.assign(new Error("The supplier check couldn't run just now. You can still continue."), { status: 502 });

  /** One paid call to the buy gateway. Returns the HTTP answer and the payment, if any. */
  async function paidCall(path, body, what) {
    if (!account) throw Object.assign(new Error("Supplier checks aren't switched on"), { status: 503 });
    if (spentToday() >= dailyCapUsd) throw Object.assign(new Error("Supplier checks are paused for today. Try again tomorrow."), { status: 429 });
    let paid = null;
    // Pay with whichever stablecoin the agent holds (USDT first, then USA₮, then USDC).
    let token = process.env.BUY_TOKEN ?? "USDT";
    if (!process.env.BUY_TOKEN && client) {
      // Which coin to pay with, re-checked every 10 minutes rather than on every call.
      if (!tokenChoice || now() - tokenChoice.at > 600_000) {
        const bals = await Promise.all(Object.values(TOKENS).map((addr) => client.readContract({ address: addr, abi: balanceAbi, functionName: "balanceOf", args: [account.address] }).catch(() => 0n)));
        const i = bals.findIndex((b) => b >= 30_000n);
        tokenChoice = { at: now(), sym: i >= 0 ? Object.keys(TOKENS)[i] : "USDT" };
      }
      token = tokenChoice.sym;
    }
    // The gateway says when its data provider hiccupped and nothing was charged: try again
    // once, a moment later (a fresh payment authorization is signed each time).
    const once = () => x402.payingFetch(
      { account, network, preferredToken: token, fetchImpl },
      `${gateway}${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
        maxAmount: 30_000n, // never more than $0.03 for one call
        onPayment: (info) => {
          paid = { at: new Date(now()).toISOString(), url: info.url, amount: info.amount, asset: info.asset, txHash: info.txHash ?? null, outcome: info.outcome, ...what };
          appendFileSync(log, JSON.stringify(paid) + "\n");
        },
      },
    );
    let res;
    let text;
    for (let attempt = 0; ; attempt++) {
      // eslint-disable-next-line no-await-in-loop
      res = await once().catch((e) => {
        console.error("buy:", e.code ?? "", e.message);
        throw unavailable();
      });
      // eslint-disable-next-line no-await-in-loop
      text = await res.text();
      const retry = res.status >= 500 && /"retryable":\s*true/.test(text) && !/"paymentSettled":\s*true/.test(text);
      if (!retry || attempt >= 2) break;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { res, text, data, paid: paid ? { amount: paid.amount, txHash: paid.txHash } : null };
  }

  async function check(platform, rawHandle, { fresh = false } = {}) {
    const P = PLATFORMS[platform];
    const handle = cleanHandle(rawHandle);
    if (!P) throw Object.assign(new Error("Choose Instagram, TikTok or X"), { status: 400 });
    if (!handle) throw Object.assign(new Error("That doesn't look like a username"), { status: 400 });
    const file = join(dir, `${platform}-${handle}.v3.json`); // v3: post dates only from posts; older saved reads are ignored
    const c = !fresh && cached(file);
    if (c) return { ...c, cached: true, flags: c.found ? flags(c.summary, Math.floor(now() / 1000)) : c.flags };
    const { res, text, data, paid } = await paidCall(P.path, P.body(handle), { platform, handle });
    const notFound = res.status === 404 || /not.?found|doesn.?t exist|no user/i.test(text.slice(0, 400));
    if (!res.ok && !notFound) {
      console.error("supplier check:", res.status, text.slice(0, 300));
      throw unavailable();
    }
    const summary = data && !notFound ? summarize(data) : null;
    const found = !!summary && (summary.followers !== null || summary.posts !== null || summary.name !== null);
    const out = {
      platform,
      label: P.label,
      handle,
      url: P.url(handle),
      found,
      summary,
      flags: found ? flags(summary, Math.floor(now() / 1000)) : [`No public ${P.label} account named @${handle}. Ask the supplier for the exact name.`],
      paid,
      at: new Date(now()).toISOString(),
    };
    writeFileSync(file, JSON.stringify(out));
    return out;
  }

  /**
   * Public complaints about a seller on X and Reddit. Two paid searches (about $0.01),
   * kept for a day. Each kept post names the seller and complains; when an AI judge is
   * available it also drops posts that aren't a customer's complaint about this seller.
   */
  async function complaints(rawHandle, rawName = "", { judge: useJudge = judge } = {}) {
    const handle = cleanHandle(rawHandle);
    if (!handle) throw Object.assign(new Error("That doesn't look like a username"), { status: 400 });
    const name = String(rawName ?? "").replace(/["()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
    const key = `complaints-${handle}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.json`;
    const file = join(dir, key);
    const c = cached(file);
    if (c) return { ...c, cached: true };
    const who = [`"${handle}"`, `"@${handle}"`, name.length >= 5 ? `"${name}"` : null].filter(Boolean).join(" OR ");
    const words = "(scam OR scammed OR fraud OR fake OR refund OR \"never delivered\" OR \"didn't deliver\" OR beware)";
    const searched = [];
    const posts = [];
    const payments = [];
    // Both searches at once: the check takes as long as the slower one, not both added up.
    const results = await Promise.all([["x", `(${who}) ${words}`], ["reddit", `(${who}) (scam OR scammed OR fraud OR fake OR refund)`]].map(async ([source, q]) => {
      try {
        return { source, r: await paidCall(SEARCH[source].path, SEARCH[source].body(q), { search: source, handle }) };
      } catch (e) {
        return { source, e };
      }
    }));
    for (const { source, r, e } of results) {
      if (e) {
        if (e.status === 429 || e.status === 503) throw e;
        continue;
      }
      if (r.paid) payments.push({ source, ...r.paid });
      if (!r.res.ok) {
        console.error("complaints:", source, r.res.status, r.text.slice(0, 200));
        continue;
      }
      searched.push(source);
      posts.push(...extractPosts(r.data, source));
    }
    if (!searched.length) throw unavailable();
    let found = complaintCandidates(posts, handle, name, Math.floor(now() / 1000));
    let judged = false;
    if (found.length && useJudge) {
      try {
        const keep = await useJudge({ handle, name, posts: found });
        if (Array.isArray(keep)) {
          found = found.filter((_, i) => keep.includes(i));
          judged = true;
        }
      } catch (e) {
        console.error("complaints judge:", e.message);
      }
    }
    const out = { handle, name, searched, scanned: posts.length, complaints: found.slice(0, 8), judged, paid: payments, at: new Date(now()).toISOString() };
    writeFileSync(file, JSON.stringify(out));
    return out;
  }

  return {
    enabled: !!account,
    payments() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    check: (platform, handle, opts = {}) => (opts.fresh ? check(platform, handle, opts) : shared(`p:${platform}:${cleanHandle(handle)}`, () => check(platform, handle, opts))),
    complaints: (handle, name = "", opts = {}) => shared(`c:${cleanHandle(handle)}:${String(name).trim().toLowerCase()}`, () => complaints(handle, name, opts)),
  };
}
