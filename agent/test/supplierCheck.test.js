// The supplier check against a fake buy gateway: a real x402 v1 challenge is answered
// with a real signed EIP-3009 authorization from the agent's key, then the profile is
// summarised into plain facts and warnings. Spending caps and the cache are enforced.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { supplierChecker, summarize, flags, cleanHandle } from "../src/supplierCheck.js";

const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const PAYTO = "0x20faAca5F980E29639A0FCC6dcA6988E18ed333B";
const challenge = (resource) => ({
  x402Version: 1,
  error: "X-PAYMENT header is required",
  accepts: [{ scheme: "exact", network: "celo", maxAmountRequired: "5000", resource, description: "profile", mimeType: "application/json", payTo: PAYTO, maxTimeoutSeconds: 60, asset: USDT, extra: { name: "Tether USD", version: "1" } }],
});

function fakeGateway(profile, calls) {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const h = new Headers(init?.headers);
    const payment = h.get("X-PAYMENT");
    calls.push({ url, body: init?.body, paid: !!payment });
    if (!payment) return new Response(JSON.stringify(challenge(url)), { status: 402, headers: { "content-type": "application/json" } });
    const p = JSON.parse(Buffer.from(payment, "base64").toString());
    calls.at(-1).payment = p;
    const settle = Buffer.from(JSON.stringify({ success: true, transaction: "0x" + "ab".repeat(32), network: "celo", payer: p.payload.authorization.from })).toString("base64");
    return new Response(JSON.stringify(profile), { status: 200, headers: { "content-type": "application/json", "X-PAYMENT-RESPONSE": settle } });
  };
}

test("pays the challenge with a signed USDT authorization and summarises the profile", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const calls = [];
  const now = Date.parse("2026-11-01T10:00:00Z");
  const profile = { data: { user: { full_name: "Phoenix Store", biography: "Phones wholesale, Shenzhen", is_verified: false, is_private: false, edge_followed_by: { count: 12400 }, edge_owner_to_timeline_media: { count: 860, edges: [{ node: { taken_at_timestamp: now / 1000 - 3 * 86400 } }] } } } };
  const c = supplierChecker({ account, dataDir: mkdtempSync(join(tmpdir(), "sc-")), fetchImpl: fakeGateway(profile, calls), now: () => now });
  const r = await c.check("instagram", "@Phoenix.Store");
  assert.equal(r.handle, "phoenix.store");
  assert.equal(r.found, true);
  assert.equal(r.summary.followers, 12400);
  assert.equal(r.summary.posts, 860);
  assert.equal(r.summary.name, "Phoenix Store");
  assert.deepEqual(r.flags, []);
  assert.equal(r.paid.amount, "5000");
  assert.equal(r.paid.txHash, "0x" + "ab".repeat(32));
  // the authorization: from the agent, to the gateway's payTo, exactly the price
  const auth = calls[1].payment.payload.authorization;
  assert.equal(auth.from.toLowerCase(), account.address.toLowerCase());
  assert.equal(auth.to.toLowerCase(), PAYTO.toLowerCase());
  assert.equal(auth.value, "5000");
  assert.equal(JSON.parse(calls[0].body).username, "phoenix.store");
  // cached for a day: no second payment
  const again = await c.check("instagram", "phoenix.store");
  assert.equal(again.cached, true);
  assert.equal(calls.length, 2);
  assert.equal(c.payments().length, 1);
});

test("refuses bad input, respects the daily cap, and words the warnings plainly", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const calls = [];
  const c = supplierChecker({ account, dataDir: mkdtempSync(join(tmpdir(), "sc-")), fetchImpl: fakeGateway({ followers_count: 40, statuses_count: 3, created_at: "Mon Aug 03 10:00:00 +0000 2026" }, calls), dailyCapUsd: 0.005, now: () => Date.parse("2026-11-01T10:00:00Z") });
  await assert.rejects(c.check("facebook", "x"), { status: 400 });
  await assert.rejects(c.check("x", "not a handle!"), { status: 400 });
  const r = await c.check("x", "newshop");
  assert.deepEqual(r.flags, ["Only 40 followers.", "Only 3 posts.", "The account is less than 6 months old."]);
  await assert.rejects(c.check("x", "another"), { status: 429 }, "daily cap reached");
  assert.equal(cleanHandle("https://www.instagram.com/phoenix.store/?hl=en"), "phoenix.store");
  assert.equal(cleanHandle("tiktok.com/@shop_ng"), "shop_ng", "links work with or without https://");
  assert.equal(cleanHandle("instagram.com"), null, "a bare domain is not a handle");
  assert.deepEqual(flags(summarize({ is_private: true, follower_count: 5000, media_count: 300 })), ["Private account: you can't see their posts."]);
});
