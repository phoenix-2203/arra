// Checking a supplier: the verdict rules, page proofs and complaint filtering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verdict } from "../src/verdict.js";
import { PageProofs } from "../src/pageProofs.js";
import { extractPosts, complaintCandidates } from "../src/supplierCheck.js";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const page = (over = {}) => ({ platform: "instagram", label: "Instagram", handle: "phoenix.store", found: true, summary: { followers: 12400, posts: 860, bio: "" }, flags: [], ...over });
const none = { searched: ["x", "reddit"], complaints: [] };

test("an established page with no complaints looks good; the reasons are plain", () => {
  const v = verdict({ profile: page(), complaints: none });
  assert.equal(v.level, "good");
  assert.match(v.reasons[0].text, /12,400 followers/);
  assert.match(v.reasons.at(-1).text, /doesn't prove they're honest/);
});

test("paying a wallet other than the confirmed page owner's is high risk", () => {
  const proof = { platform: "instagram", handle: "phoenix.store", address: A, at: 1 };
  assert.equal(verdict({ profile: page(), complaints: none, proof, payTo: B }).level, "risk");
  const ok = verdict({ profile: page(), complaints: none, proof, payTo: A });
  assert.equal(ok.level, "good");
  assert.match(ok.reasons[0].text, /confirmed/);
});

test("warning signs, complaints, missing pages and a bad record", () => {
  assert.equal(verdict({ profile: page({ flags: ["Only 40 followers."] }), complaints: none }).level, "careful");
  assert.equal(verdict({ profile: page(), complaints: { searched: ["x"], complaints: [{}], judged: true } }).level, "careful");
  assert.equal(verdict({ profile: page(), complaints: { searched: ["x"], complaints: [{}, {}], judged: true } }).level, "risk");
  assert.equal(verdict({ profile: page({ found: false, summary: null }) }).level, "careful", "often just a typo");
  assert.equal(verdict({ payTo: A, record: { accepted: 2, paid: 1, refundedUnshipped: 1, disputed: 0 } }).level, "risk");
  assert.equal(verdict({ payTo: A, reviews: { count: 3, people: 3, again: [1, 3] } }).level, "risk");
  assert.equal(verdict({ payTo: A, walletTxs: 0 }).level, "unknown", "a new wallet alone isn't a warning");
});

test("page proof: the code must be in the bio of that exact page, for that wallet", async () => {
  const proofs = new PageProofs(join(mkdtempSync(join(tmpdir(), "pp-")), "p.json"), (l) => require_hex(l));
  const { code } = proofs.start("instagram", "@Phoenix.Store", A);
  assert.match(code, /^ARRA-[A-Z2-9]{6}$/);
  assert.equal(proofs.start("instagram", "phoenix.store", A).code, code, "stable across visits");
  assert.notEqual(proofs.start("instagram", "phoenix.store", B).code, code, "tied to the wallet");
  let bio = "Phones wholesale";
  const checker = { check: async () => ({ found: true, summary: { bio }, paid: { txHash: "0xabc" } }) };
  assert.equal((await proofs.confirm("instagram", "phoenix.store", A, checker)).confirmed, false);
  bio = `Phones wholesale ${code.toLowerCase()}`;
  const r = await proofs.confirm("instagram", "phoenix.store", A, checker);
  assert.equal(r.confirmed, true);
  assert.equal(proofs.get("instagram", "PHOENIX.STORE").address, A);
  assert.equal(proofs.byAddress(A.toUpperCase().replace("0X", "0x")).length, 1);
});

test("complaints: posts must name the seller and complain; the seller's own posts don't count", () => {
  const data = { data: { tweets: [
    { tweet_id: "1840000000000000001", screen_name: "ada_buys", text: "@phoenix.store took my deposit and never delivered. Scam!!", created_at: "Mon Oct 05 10:00:00 +0000 2026" },
    { tweet_id: "1840000000000000002", screen_name: "phoenix.store", text: "Beware of fake pages using the name phoenix.store, we only sell here" },
    { tweet_id: "1840000000000000003", screen_name: "tola", text: "Great phones from phoenix.store, arrived early" },
    { tweet_id: "1840000000000000004", screen_name: "kemi", text: "Another scam shop on IG, avoid them" },
  ] } };
  const posts = extractPosts(data, "x");
  assert.equal(posts.length, 4);
  assert.equal(posts[0].url, "https://x.com/ada_buys/status/1840000000000000001");
  const c = complaintCandidates(posts, "phoenix.store", "");
  assert.deepEqual(c.map((p) => p.author), ["ada_buys"]);
  const reddit = extractPosts({ children: [{ data: { title: "Phoenix Store Lagos scammed me", selftext: "Paid 300k, blocked me", permalink: "/r/Nigeria/comments/abc/x/", author: "u/femi", created_utc: 1790000000 } }] }, "reddit");
  assert.equal(reddit[0].url, "https://www.reddit.com/r/Nigeria/comments/abc/x/");
  assert.equal(complaintCandidates(reddit, "phoenix.store", "Phoenix Store").length, 1, "found by business name");
});

import { createHash } from "node:crypto";
function require_hex(label) {
  return createHash("sha256").update(label).digest("hex");
}

test("usernames that look like web addresses still count", async () => {
  const { cleanHandle } = await import("../src/supplierCheck.js");
  assert.equal(cleanHandle("quickdeals.ng"), "quickdeals.ng");
  assert.equal(cleanHandle("@Shop.Lagos.com"), "shop.lagos.com");
  assert.equal(cleanHandle("https://quickdeals.ng"), null);
  assert.equal(cleanHandle("www.shop.com"), null);
  assert.equal(cleanHandle("instagram.com"), null);
  assert.equal(cleanHandle("https://instagram.com/quickdeals.ng?igsh=1"), "quickdeals.ng");
});

test("a wallet that confirmed a different page than the one checked gets a warning", () => {
  const pages = [{ platform: "instagram", label: "Instagram", handle: "other.shop", address: A }];
  const v = verdict({ profile: page(), complaints: none, payTo: A, payToPages: pages });
  assert.equal(v.level, "careful");
  assert.match(v.reasons[0].text, /different page \(@other\.shop/);
  assert.equal(verdict({ payTo: A, payToPages: pages }).level, "good", "wallet-only check shows whose page it is");
});

test("real answers from mainnet: old, crowd-tagging and other people's warnings are dropped; Reddit's nested shape is read", () => {
  const now = Date.parse("2026-11-01T10:00:00Z") / 1000;
  // Shapes and posts as the buy gateway returned them for "celoorg" on 1 Nov 2026.
  const x = { output: { status: "ok", timeline: [
    { type: "tweet", tweet_id: "1513493847577292801", screen_name: "CathaPham", created_at: "Mon Apr 11 10:27:07 +0000 2022", text: "@Uncle_Celo @CeloDaily @ChorusOne @steakwallet @ChurroFi @CoinList @coinbase @Anchorage @CeloTax @CeloOrg Celo coin scam" },
    { type: "tweet", tweet_id: "1253034875977904130", screen_name: "CoinList", created_at: "Thu Apr 23 18:42:49 +0000 2020", text: "Registration for the @CeloOrg Gold auction is now open. Beware of scams." },
    { type: "tweet", tweet_id: "1603045370543865856", screen_name: "hoangphuc168x", created_at: "Wed Dec 14 15:12:54 +0000 2022", text: "@CeloOrg $CELO SCAM?" },
    { type: "tweet", tweet_id: "2023165367506321852", screen_name: "buyer_ng", created_at: "Sun Oct 04 22:39:46 +0000 2026", text: "Paid @celoorg for 20 phones in August, never delivered. Scam." },
  ] } };
  const posts = extractPosts(x, "x");
  assert.equal(posts.length, 4);
  assert.deepEqual(complaintCandidates(posts, "celoorg", "Celo Foundation", now).map((p) => p.author), ["buyer_ng"]);
  const reddit = { output: { children: [{ post: { id: "t3_1abcde", title: "Can't send cUSD back from Celo Foundation wallet, is this a scam?", authorInfo: { name: "RedgeQc" }, content: { markdown: "I added Celo to Metamask..." }, createdAt: "2026-09-01T10:00:00Z" } }] } };
  const rp = extractPosts(reddit, "reddit");
  assert.equal(rp[0].author, "RedgeQc");
  assert.equal(rp[0].url, "https://www.reddit.com/comments/1abcde/");
  assert.match(rp[0].text, /Metamask/);
});

test("matches the AI hasn't confirmed are a warning to read, never high risk", () => {
  const two = [{}, {}];
  assert.equal(verdict({ profile: page(), complaints: { searched: ["x"], complaints: two, judged: false } }).level, "careful");
  assert.equal(verdict({ profile: page(), complaints: { searched: ["x"], complaints: two, judged: true } }).level, "risk");
});

test("negations are praise, not complaints", () => {
  const posts = [
    { source: "x", author: "aixbt_agent", text: "working with celo foundation, zero scam signals in the data", at: null },
    { source: "x", author: "a", text: "Celo Foundation is not a scam, legit team", at: null },
    { source: "x", author: "b", text: "Celo Foundation took my money, no refund, total scam", at: null },
  ];
  assert.deepEqual(complaintCandidates(posts, "celoorg", "Celo Foundation").map((p) => p.author), ["b"]);
});

test("the AI judge falls back when Gemini refuses 'thinking off', and reads plain JSON", async () => {
  const { assistant } = await import("../src/assistant.js");
  const bodies = [];
  const fetchFn = async (_u, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.reasoning_effort) return new Response("bad", { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: "```json\n{\"keep\": [1, 9]}\n```" } }] }), { status: 200 });
  };
  const ai = assistant({ key: "", geminiKey: "g", fetchFn });
  const keep = await ai.judgeComplaints({ handle: "shop", name: "", posts: [{ source: "x", author: "a", text: "x" }, { source: "x", author: "b", text: "y" }] });
  assert.deepEqual(keep, [1], "out-of-range indexes dropped");
  assert.equal(bodies.length, 2);
});

test("X profiles: follower and bio fields under X's own names", async () => {
  const { summarize } = await import("../src/supplierCheck.js");
  const s = summarize({ output: { profile: "shiproafrica", name: "shipro", desc: "Shipping from China to Nigeria", sub_count: 1840, friends: 210, statuses_count: 423, blue_verified: false, protected: false, created_at: "Tue Apr 15 10:00:00 +0000 2025" } });
  assert.equal(s.followers, 1840);
  assert.equal(s.following, 210);
  assert.equal(s.posts, 423);
  assert.equal(s.bio, "Shipping from China to Nigeria");
  assert.equal(s.verified, false);
});

test("a page without a follower count is described without question marks", () => {
  const v = verdict({ profile: page({ label: "X", summary: { followers: null, posts: 423, createdAt: 1744711200 } }), complaints: none });
  assert.ok(!v.reasons.some((r) => r.text.includes("?")));
  assert.equal(v.level, "good");
});

test("a modest but long-running, active page looks established (real @shiproafrica numbers)", () => {
  const v = verdict({ profile: page({ label: "X", handle: "shiproafrica", summary: { followers: 244, posts: 423, createdAt: 1744718209 } }), complaints: none });
  assert.equal(v.level, "good");
  assert.match(v.reasons[0].text, /244 followers, 423 posts, on X since Apr 2025/);
});

test("TikTok: the account's creation date is not mistaken for its last post", async () => {
  const { summarize, flags } = await import("../src/supplierCheck.js");
  const now = 1793526000;
  const noPosts = summarize({ output: { userInfo: { user: { uniqueId: "happy14076", nickname: "guangzhouClothingshop", createTime: 1556000000, signature: "Factory" }, stats: { followerCount: 8738, videoCount: 173 } } } });
  assert.equal(noPosts.createdAt, 1556000000);
  assert.equal(noPosts.lastPostAt, null);
  assert.deepEqual(flags(noPosts, now), [], "unknown last post: no 'hasn't posted' warning");
  const withPosts = summarize({ output: { user: { createTime: 1556000000, followerCount: 8738 }, itemList: [{ createTime: now - 19 * 3600, author: { followerCount: 1 } }] } });
  assert.equal(withPosts.lastPostAt, now - 19 * 3600);
  assert.equal(withPosts.followers, 8738, "a post's author fields don't override the profile's");
});

test("contact numbers a seller lists in their bio (real @happy14076 bio)", async () => {
  const { contactsIn } = await import("../src/supplierCheck.js");
  assert.deepEqual(contactsIn("Video show style is limited, add me, I send you a full catalog.Thank you for your support.\nwechat 18025912617\nwhatsapp +86 13642384303"), [
    { kind: "WeChat", value: "18025912617" },
    { kind: "WhatsApp", value: "+86 13642384303" },
  ]);
  assert.deepEqual(contactsIn("Celo is now a Layer 2. Secured by Ethereum."), []);
  assert.deepEqual(contactsIn("Since 2019 | 24/7"), [], "years and hours aren't phone numbers");
});
