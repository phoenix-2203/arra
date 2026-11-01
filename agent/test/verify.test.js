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
  assert.equal(verdict({ profile: page(), complaints: { searched: ["x"], complaints: [{}] } }).level, "careful");
  assert.equal(verdict({ profile: page(), complaints: { searched: ["x"], complaints: [{}, {}] } }).level, "risk");
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
