// A fake buy gateway for local tests: answers x402 challenges, then canned data.
import { createServer } from "node:http";
const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const now = Math.floor(Date.now() / 1000);
const PROFILES = {
  "phoenix.store": { full_name: "Phoenix Store", biography: "Phones wholesale · Shenzhen → Lagos ARRA-CODE", follower_count: 12400, media_count: 860, is_private: false, is_verified: false, items: [{ taken_at: now - 3 * 86400 }] },
  "quickdeals.ng": { full_name: "Quick Deals NG", biography: "iPhones at crazy prices DM", follower_count: 85, media_count: 6, is_private: false, items: [{ taken_at: now - 20 * 86400 }] },
};
// Invented for the demo video (clearly labelled there as an example).
PROFILES["gadgetplug.ng"] = { full_name: "Gadget Plug NG", biography: "UK used iPhones · pay first, fast delivery", follower_count: 132, media_count: 7, is_private: false, items: [{ taken_at: now - 9 * 86400 }] };
const XPOSTS = {
  "gadgetplug.ng": [
    { tweet_id: "1851000000000000001", screen_name: "bimpe_o", text: "Paid @gadgetplug.ng 380k for two iPhones in September. No delivery, now they've blocked me. Scam.", created_at: "Tue Oct 06 09:12:00 +0000 2026" },
    { tweet_id: "1851000000000000002", screen_name: "chidi_buys", text: "gadgetplug.ng took my deposit and stopped replying. Please don't buy from them.", created_at: "Fri Oct 23 18:40:00 +0000 2026" },
  ],
  "quickdeals.ng": [
    { tweet_id: "1850000000000000001", screen_name: "ada_buys", text: "@quickdeals.ng collected my 250k deposit and blocked me. Scam, don't buy!", created_at: "Mon Oct 12 10:00:00 +0000 2026" },
    { tweet_id: "1850000000000000002", screen_name: "tunde_k", text: "quickdeals.ng never delivered my phones, now asking for more money. Beware.", created_at: "Wed Oct 21 10:00:00 +0000 2026" },
  ],
};
let bioOverride = {};
createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.url.startsWith("/gemini") && JSON.parse(body).tools) {
    // Stand-in for the order assistant (demo video): one complete, realistic order.
    const draft = { kind: "goods", supplier: "Phoenix Store", product: "Samsung Galaxy A15 phones", quantity: 20, unit: "pieces", unitPriceUsd: "14.00",
      details: [{ label: "Model or spec", value: "Galaxy A15, 128 GB, dual SIM" }, { label: "Colour", value: "Black" }],
      packaging: "Original boxes, 10 per carton", shipBy: "2026-12-15", term: "FOB", port: "Shenzhen", depositPct: 30, transitDays: 60 };
    const args = { message: "Done: 20 Samsung Galaxy A15 phones from Phoenix Store at $14 each, $280 in total, shipping by 15 December. Check the details below.", draft, ready: true };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "respond", arguments: JSON.stringify(args) } }] } }] }));
    return;
  }
  if (req.url.startsWith("/gemini")) {
    // Stand-in for the AI check of posts: keeps posts that name the seller and complain.
    const user = JSON.parse(body).messages.at(-1).content;
    const keep = [...user.matchAll(/\[(\d+)\][^\n]*(scam|blocked|no delivery|don't buy)/gi)].map((m) => Number(m[1]));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ keep }) } }] }));
    return;
  }
  if (req.url === "/__bio") { bioOverride = JSON.parse(body); res.end("ok"); return; }
  if (!req.headers["x-payment"]) {
    res.writeHead(402, { "content-type": "application/json" });
    res.end(JSON.stringify({ x402Version: 1, error: "X-PAYMENT header is required", accepts: [{ scheme: "exact", network: "celo", maxAmountRequired: "5000", resource: `http://localhost:8799${req.url}`, description: "x", mimeType: "application/json", payTo: "0x20faAca5F980E29639A0FCC6dcA6988E18ed333B", maxTimeoutSeconds: 60, asset: USDT, extra: { name: "Tether USD", version: "1" } }] }));
    return;
  }
  const p = JSON.parse(Buffer.from(req.headers["x-payment"], "base64").toString());
  const tx = "0x" + Math.random().toString(16).slice(2).padEnd(64, "0").slice(0, 64);
  const settle = Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "celo", payer: p.payload.authorization.from })).toString("base64");
  const b = JSON.parse(body || "{}");
  await new Promise((r) => setTimeout(r, req.url.includes("/search") ? 4000 : 2000)); // SLOW: like the real providers
  let out;
  if (req.url.includes("/instagram/profile")) {
    const u = b.username;
    const prof = PROFILES[u] ?? (u.startsWith("new") ? { full_name: u, biography: bioOverride[u] ?? "", follower_count: 300, media_count: 40, items: [{ taken_at: now - 86400 }] } : null);
    if (!prof) { res.writeHead(404, { "content-type": "application/json", "X-PAYMENT-RESPONSE": settle }); res.end(JSON.stringify({ error: "user not found" })); return; }
    out = { output: { ...prof, biography: bioOverride[u] ?? prof.biography } };
  } else if (req.url.includes("twitter-web-fetch-user-profile")) {
    // @shiproafrica as the real gateway returned it on 1 Nov 2026.
    out = { output: { status: "active", profile: "shiproafrica", blue_verified: true, desc: "Products/gadgets sourcing & procurement | China - Nigeria freight services | Alipay funding & supplier payments", name: "shipro", protected: false, friends: 2, sub_count: 244, statuses_count: 423, created_at: "Tue Apr 15 11:56:49 +0000 2025" } };
  } else if (req.url.includes("/x/posts/search")) {
    const hit = Object.keys(XPOSTS).find((k) => b.query.includes(k));
    out = { output: { tweets: hit ? XPOSTS[hit] : [] } };
  } else if (req.url.includes("/reddit/posts/search")) {
    out = { output: { posts: [] } };
  } else out = { output: {} };
  res.writeHead(200, { "content-type": "application/json", "X-PAYMENT-RESPONSE": settle });
  res.end(JSON.stringify({ transaction: tx, ...out }));
}).listen(8799, () => console.log("fake buy on :8799"));
