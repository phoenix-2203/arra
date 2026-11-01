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
  let h = String(raw ?? "").trim();
  h = h.replace(/^(https?:\/\/)?(www\.|m\.)?(instagram\.com|tiktok\.com|x\.com|twitter\.com)\/@?/i, "").replace(/[/?#].*$/, "").replace(/^@/, "");
  // A bare website address isn't a username.
  if (/\.(com|net|org|ng|cn|io|co)$/i.test(h)) return null;
  return HANDLE_RE.test(h) ? h.toLowerCase() : null;
}

// ---- reading whatever shape the profile comes back in -------------------------------
function walk(obj, visit, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 7) return;
  for (const [k, v] of Object.entries(obj)) {
    visit(k, v);
    if (v && typeof v === "object") walk(v, visit, depth + 1);
  }
}
function first(obj, keys, test) {
  let found;
  walk(obj, (k, v) => {
    if (found === undefined && keys.includes(k) && test(v)) found = v;
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
  const followers = num(first(data, ["follower_count", "followers_count", "followerCount", "followersCount", "followers"], isNum)) ?? num(first(data, ["edge_followed_by"], (v) => isNum(v?.count))?.count);
  const following = num(first(data, ["following_count", "followingCount", "friends_count", "follows_count", "following"], isNum));
  const posts = num(first(data, ["media_count", "mediaCount", "posts_count", "postsCount", "statuses_count", "videoCount", "video_count", "aweme_count", "postCount"], isNum)) ?? num(first(data, ["edge_owner_to_timeline_media"], (v) => isNum(v?.count))?.count);
  const verified = first(data, ["is_verified", "verified", "isVerified", "is_blue_verified"], (v) => typeof v === "boolean");
  const priv = first(data, ["is_private", "private", "privateAccount", "protected"], (v) => typeof v === "boolean");
  const name = first(data, ["full_name", "fullName", "nickname", "displayName", "name"], isStr);
  const bio = first(data, ["biography", "bio", "description", "signature"], isStr);
  const createdAt = epoch(first(data, ["created_at", "createdAt", "create_time", "account_created_at"], (v) => epoch(v) !== undefined));
  let lastPostAt;
  walk(data, (k, v) => {
    if (["taken_at", "taken_at_timestamp", "createTime", "create_time", "timestamp", "created_at"].includes(k)) {
      const t = epoch(v);
      if (t && t <= Date.now() / 1000 + 86400 && (!lastPostAt || t > lastPostAt) && t !== createdAt) lastPostAt = t;
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

// The stablecoins the gateway takes on Celo (6 decimals each). The agent pays with whichever it holds.
const TOKENS = { USDT: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", USAT: "0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771", USDC: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C" };
const balanceAbi = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }];

export function supplierChecker({ account, client = null, dataDir, gateway = process.env.BUY_GATEWAY ?? "https://gateway.usebuy.ai", network = process.env.BUY_NETWORK ?? "celo", dailyCapUsd = Number(process.env.BUY_DAILY_CAP_USD ?? 0.5), fetchImpl, now = () => Date.now() }) {
  const dir = join(dataDir, "supplier-checks");
  mkdirSync(dir, { recursive: true });
  const log = join(dataDir, "buy-payments.jsonl");
  const day = () => new Date(now()).toISOString().slice(0, 10);
  const spentToday = () => {
    if (!existsSync(log)) return 0;
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((p) => p.at.slice(0, 10) === day() && p.outcome !== "rejected").reduce((s, p) => s + Number(p.amount) / 1e6, 0);
  };
  return {
    enabled: !!account,
    payments() {
      if (!existsSync(log)) return [];
      return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    async check(platform, rawHandle) {
      const P = PLATFORMS[platform];
      const handle = cleanHandle(rawHandle);
      if (!P) throw Object.assign(new Error("Choose Instagram, TikTok or X"), { status: 400 });
      if (!handle) throw Object.assign(new Error("That doesn't look like a username"), { status: 400 });
      const file = join(dir, `${platform}-${handle}.json`);
      if (existsSync(file)) {
        const c = JSON.parse(readFileSync(file, "utf8"));
        if (now() - Date.parse(c.at) < DAY) return { ...c, cached: true, flags: c.found ? flags(c.summary, Math.floor(now() / 1000)) : c.flags };
      }
      if (!account) throw Object.assign(new Error("Supplier checks aren't switched on"), { status: 503 });
      if (spentToday() >= dailyCapUsd) throw Object.assign(new Error("Supplier checks are paused for today. Try again tomorrow."), { status: 429 });
      let paid = null;
      // Pay with whichever stablecoin the agent holds (USDT first, then USA₮, then USDC).
      let token = process.env.BUY_TOKEN ?? "USDT";
      if (!process.env.BUY_TOKEN && client) {
        for (const [sym, addr] of Object.entries(TOKENS)) {
          const b = await client.readContract({ address: addr, abi: balanceAbi, functionName: "balanceOf", args: [account.address] }).catch(() => 0n);
          if (b >= 30_000n) { token = sym; break; }
        }
      }
      const res = await x402.payingFetch(
        { account, network, preferredToken: token, fetchImpl },
        `${gateway}${P.path}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(P.body(handle)),
          maxAmount: 30_000n, // never more than $0.03 for one profile
          onPayment: (info) => {
            paid = { at: new Date(now()).toISOString(), url: info.url, amount: info.amount, asset: info.asset, txHash: info.txHash ?? null, outcome: info.outcome, platform, handle };
            appendFileSync(log, JSON.stringify(paid) + "\n");
          },
        },
      ).catch((e) => {
        console.error("supplier check:", e.code ?? "", e.message);
        throw Object.assign(new Error("The supplier check couldn't run just now. You can still continue."), { status: 502 });
      });
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      const notFound = res.status === 404 || /not.?found|doesn.?t exist|no user/i.test(text.slice(0, 400));
      if (!res.ok && !notFound) {
        console.error("supplier check:", res.status, text.slice(0, 300));
        throw Object.assign(new Error("The supplier check couldn't run just now. You can still continue."), { status: 502 });
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
        paid: paid ? { amount: paid.amount, txHash: paid.txHash } : null,
        at: new Date(now()).toISOString(),
      };
      writeFileSync(file, JSON.stringify(out));
      return out;
    },
  };
}
