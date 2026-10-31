// API tests with a fake chain reader (no network).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, listen } from "../src/server.js";
import { OrderLinks } from "../src/links.js";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { sheetRef } from "../src/orderSheet.js";
import { TextileError } from "../src/textile.js";
import { keccak256, toBytes } from "viem";

const BUYER = "0x1111111111111111111111111111111111111111";
const SUPPLIER = "0x2222222222222222222222222222222222222222";
const LINKS = new OrderLinks(null, "test-secret");
const sheet = {
  supplier: "Guangzhou Textiles",
  product: "Cotton T-shirts, crew neck",
  quantity: 10,
  unit: "pieces",
  unitPriceUsd: "2.00",
  specs: ["180 gsm 100% combed cotton"],
  packaging: "10 per carton",
  shipBy: "2030-12-15",
  incoterm: "FOB Guangzhou",
};
const T = 1_800_000_000;
const onchain = {
  buyer: BUYER, supplier: SUPPLIER, total: 20_000_000n, deposit: 6_000_000n, held: 14_000_000n,
  acceptBy: BigInt(T - 100), shipBy: BigInt(T + 86400), shippedAt: 0n, disputeWindow: 86400, status: 2, ref: sheetRef(sheet),
};
// Minimal stand-in for a viem public client.
const fakeClient = {
  async readContract({ functionName, args }) {
    if (functionName === "nextId") return 2n;
    if (functionName === "getSplitOffer") return { proposer: "0x0000000000000000000000000000000000000000", toSupplier: 0n };
    if (functionName === "getOrder") return args[0] === 1n ? onchain : { ...onchain, status: 0 };
    throw new Error(functionName);
  },
};

const submitted = [];
const fakeTextile = {
  async preview({ buyAmount }) {
    return { data: { sellAmount: (buyAmount * 1600n).toString(), buyAmount: buyAmount.toString() } };
  },
  async request({ buyAmount, taker, takerProof }) {
    if (!takerProof) throw new TextileError(401, { error: { code: "proof_of_control_required", message: "Sign once" } });
    return { data: { rfqId: "rfq_9", claimToken: "rfqc_hidden", status: "quoted", quote: { takerPays: (buyAmount * 1601n).toString(), buyAmount: buyAmount.toString(), feeAmount: "1", reactor: "0xreactor", expiresAt: "2030-01-01T00:00:00Z", taker }, transactions: { approval: { to: "0xc", data: "0x", value: "0" }, swap: { to: "0xr", data: "0x", value: "0" } } } };
  },
  async submit(id, claim, txHash) {
    submitted.push({ id, claim, txHash });
    return { data: { status: "submitted" } };
  },
  async rampProviders() {
    return { providers: [{ id: "busha", chainIds: [56] }] };
  },
};
let server, base, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "arra-srv-"));
  const staticDir = join(dir, "dist");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), '<!doctype html><head><title>Arra</title><meta name="description" content="x" /><meta property="og:title" content="Arra" /><meta property="og:image" content="/og.png" /></head>');
  server = await listen(createApp({ client: fakeClient, vault: "0xvault", dataDir: join(dir, "data"), staticDir, now: () => T, textile: fakeTextile, links: LINKS }), 0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
const get = (path, headers) => fetch(base + path, { headers }).then(async (r) => [r.status, r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text()]);

test("sheet review flags vague terms and fingerprints clean sheets", async () => {
  const [, bad] = await post("/api/sheet/review", { sheet: { ...sheet, specs: ["good quality"] } });
  assert.equal(bad.ready, false);
  const [, ok] = await post("/api/sheet/review", { sheet });
  assert.equal(ok.ready, true);
  assert.equal(ok.ref, sheetRef(sheet));
  assert.equal(ok.totalUsdt, "20000000");
});

test("sheets are stored and served by fingerprint; dirty sheets are refused", async () => {
  assert.equal((await post("/api/sheets", { sheet: { ...sheet, quantity: 0 } }))[0], 400);
  const [s, { ref }] = await post("/api/sheets", { sheet });
  assert.equal(s, 200);
  const [, stored] = await get(`/api/sheets/${ref}`);
  assert.equal(stored.sheet.product, sheet.product);
});

test("order view: role, actions, explanation and payee memory", async () => {
  await post("/api/sheets", { sheet });
  const [, asBuyer] = await get(`/api/orders/1?as=${BUYER}`);
  assert.equal(asBuyer.role, "buyer");
  assert.equal(asBuyer.order.status, "Active");
  assert.deepEqual(asBuyer.actions, ["releasePart", "release", "proposeSplit"]);
  assert.match(asBuyer.explanation, /Deposit paid/);
  assert.equal(asBuyer.sheet.sheet.supplier, "Guangzhou Textiles");
  const [, asSupplier] = await get(`/api/orders/1?as=${SUPPLIER}`);
  assert.deepEqual(asSupplier.actions, ["markShipped", "proposeSplit", "refundBuyer"]);
  // The accepted address is now remembered for this buyer.
  const [, known] = await post("/api/payee/check", { buyer: BUYER, supplierName: "guangzhou textiles", address: SUPPLIER });
  assert.equal(known.status, "known");
  const [, changed] = await post("/api/payee/check", { buyer: BUYER, supplierName: "Guangzhou Textiles", address: BUYER });
  assert.equal(changed.status, "changed");
  assert.equal((await get("/api/orders/2"))[0], 404);
  // Wallets may report addresses in lower or upper case.
  const [, lower] = await get(`/api/orders/1?as=${SUPPLIER.toLowerCase()}`);
  assert.equal(lower.role, "supplier");
  const [, upper] = await get(`/api/orders/1?as=0x${SUPPLIER.slice(2).toUpperCase()}`);
  assert.equal(upper.role, "supplier");
});

test("private links: each order has an unguessable code that opens it", async () => {
  const { OrderLinks, LINK_RE } = await import("../src/links.js");
  const [, byNumber] = await get("/api/orders/1");
  assert.match(byNumber.link, LINK_RE);
  const [st, byCode] = await get(`/api/orders/${byNumber.link}?as=${BUYER}`);
  assert.equal(st, 200);
  assert.equal(byCode.order.id, 1);
  assert.equal(byCode.role, "buyer");
  assert.equal((await get(`/api/orders/${byNumber.link}/timeline`))[0], 200);
  assert.equal((await get("/api/orders/abcdefghjk"))[0], 404, "a made-up code finds nothing");
  // Same secret, same code; different secret, different code.
  const a = new OrderLinks(null, "secret-a"), b = new OrderLinks(null, "secret-b");
  assert.equal(a.code(1), new OrderLinks(null, "secret-a").code(1));
  assert.notEqual(a.code(1), b.code(1));
  assert.notEqual(a.code(1), a.code(2));
  assert.equal(a.resolve(a.code(7), 10), 7);
  assert.equal(a.resolve(a.code(11), 10), null, "only existing orders");
});

test("shared order links get a preview with the amount and what it's for", async () => {
  await post("/api/sheets", { sheet });
  const [, page] = await get("/o/1");
  assert.match(page, /<title>Order #1: Cotton T-shirts, crew neck, 10 pieces · Arra<\/title>/);
  assert.match(page, /og:image" content="http:\/\/127\.0\.0\.1:\d+\/og\/[A-Za-z0-9]{10}\.png\?v=Active-14000000"/, "each order gets its own picture");
  assert.match(page, /og:description" content="\$20\.00 USDT order\./);
  const [, home] = await get("/");
  assert.match(home, /<title>Arra<\/title>/);
  const code = page.match(/\/og\/([A-Za-z0-9]{10})\.png/)[1];
  const img = await fetch(`${base}/og/${code}.png`);
  assert.equal(img.headers.get("content-type"), "image/png");
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.equal(bytes.subarray(1, 4).toString(), "PNG");
  assert.equal(bytes.readUInt32BE(16), 1200, "1200 px wide");
  assert.equal((await fetch(`${base}/og/abcdefghjk.png`)).status, 404);
  const [, receipt] = await get("/o/1/receipt");
  assert.match(receipt, /Receipt for order #1/);
});

test("my orders, container check, errors and the app shell", async () => {
  assert.equal((await get(`/api/orders?address=${SUPPLIER}`))[0], 401, "listing a wallet's orders needs its signature");
  assert.equal((await get(`/api/orders?address=${SUPPLIER}`, { "x-arra-session": LINKS.session(BUYER) }))[0], 401, "another wallet's session doesn't count");
  const [, list] = await get(`/api/orders?address=${SUPPLIER}`, { "x-arra-session": LINKS.session(SUPPLIER) });
  assert.equal(list.orders.length, 1);
  assert.equal((await post("/api/container/check", { number: "CSQU3054383" }))[1].ok, true);
  assert.equal((await get("/api/orders?address=nope"))[0], 400);
  assert.equal((await get("/api/nope"))[0], 404);
  const bad = await fetch(base + "/api/sheet/review", { method: "POST", body: "{" });
  assert.equal(bad.status, 400);
  const [s, html] = await get("/o/1");
  assert.match(html, /og:description" content="\$20\.00 USDT order\. Accepted\. Deposit paid; \$14\.00 stays locked/, "dollar amounts survive");
  assert.equal(s, 200);
  assert.match(html, /Arra<\/title>/);
  const [, traversal] = await get("/../../etc/passwd");
  assert.match(traversal, /<title>Arra/);
});

test("naira payment: preview, proof-gated firm quote, claim token kept on the server", async () => {
  const [, p] = await post("/api/fx/preview", { usd: "47" });
  assert.equal(p.ngnPerUsd, 1600);
  assert.equal(p.usdt, "47000000");
  assert.equal((await post("/api/fx/preview", { usd: "abc" }))[0], 400);
  const [s401, need] = await post("/api/fx/quote", { taker: BUYER, usd: "47" });
  assert.equal(s401, 401);
  assert.equal(need.code, "proof_of_control_required");
  const [s, q] = await post("/api/fx/quote", { taker: BUYER, usd: "47", takerProof: { nonce: "0x1", issuedAt: 1, signature: "0x2" } });
  assert.equal(s, 200);
  assert.equal(q.status, "quoted");
  assert.equal(q.claimToken, undefined, "claim token never reaches the browser");
  assert.equal(q.ngnPerUsd, 1601);
  const hash = "0x" + "ab".repeat(32);
  assert.equal((await post(`/api/fx/${q.rfqId}/submit`, { txHash: hash }))[0], 200);
  assert.deepEqual(submitted.at(-1), { id: "rfq_9", claim: "rfqc_hidden", txHash: hash });
  assert.equal((await post("/api/fx/rfq_unknown/submit", { txHash: hash }))[0], 404);
  const [, prov] = await get("/api/ramp/providers");
  assert.deepEqual(prov.celo, []);
});

test("container number: kept only if it matches the fingerprint the supplier recorded", async () => {
  const shippedHash = keccak256(toBytes("CSQU3054383"));
  const history = { async timeline() { return [{ event: "OrderShipped", at: T, tx: `0x${"ab".repeat(32)}`, trackingHash: shippedHash }]; }, async sync() {}, async activity() { return []; } };
  const d = mkdtempSync(join(tmpdir(), "arra-trk-"));
  const srv = await listen(createApp({ client: fakeClient, vault: "0xvault", dataDir: d, staticDir: null, now: () => T, textile: fakeTextile, history }), 0);
  const b = `http://127.0.0.1:${srv.address().port}`;
  const postTo = (body) => fetch(`${b}/api/orders/1/tracking`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  assert.equal((await postTo({ number: "MSCU1234565" }))[0], 400, "a valid number that isn't this order's is refused");
  assert.equal((await postTo({ number: "CSQU3054384" }))[0], 400, "a bad check digit is refused");
  const [st, ok] = await postTo({ number: "csqu 305438 3" });
  assert.equal(st, 200);
  assert.equal(ok.number, "CSQU3054383");
  const view = await fetch(`${b}/api/orders/1`).then((r) => r.json());
  assert.equal(view.tracking.number, "CSQU3054383", "the buyer can now see and track it");
  srv.close();
});

test("supplier invites: the supplier's own wallet fills the address; first claim keeps it", async () => {
  const [st, { code }] = await post("/api/invites", { buyer: BUYER, name: "Shenzhen Brightway" });
  assert.equal(st, 200);
  assert.match(code, /^[2-9a-km-zA-HJ-NP-Z]{12}$/);
  const [, before] = await get(`/api/invites/${code}`);
  assert.equal(before.address, null);
  assert.equal(before.name, "Shenzhen Brightway");
  assert.equal((await post(`/api/invites/${code}/claim`, { address: BUYER }))[0], 400, "not the buyer's own wallet");
  const [cs, claimed] = await post(`/api/invites/${code}/claim`, { address: SUPPLIER.toLowerCase() });
  assert.equal(cs, 200);
  assert.equal(claimed.address, SUPPLIER);
  assert.equal((await post(`/api/invites/${code}/claim`, { address: SUPPLIER }))[0], 200, "same wallet again is fine");
  assert.equal((await post(`/api/invites/${code}/claim`, { address: "0x3333333333333333333333333333333333333333" }))[0], 409, "a forwarded link can't swap the address");
  assert.equal((await get(`/api/invites/${code}`))[1].address, SUPPLIER);
  assert.equal((await post("/api/invites", { buyer: BUYER, name: "" }))[0], 400);
  assert.equal((await get("/api/invites/abcdefghjkmn"))[0], 404);
});

test("notes: only the buyer or supplier can post, signed by their wallet; changes need the other side to agree", async () => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const { noteTypedData } = await import("../src/notes.js");
  const buyerAcc = privateKeyToAccount(`0x${"a1".repeat(32)}`);
  const supAcc = privateKeyToAccount(`0x${"b2".repeat(32)}`);
  const stranger = privateKeyToAccount(`0x${"c3".repeat(32)}`);
  const client = { async readContract({ functionName, args }) {
    if (functionName === "nextId") return 2n;
    if (functionName === "getSplitOffer") return { proposer: "0x0000000000000000000000000000000000000000", toSupplier: 0n };
    if (functionName === "getOrder") return args[0] === 1n ? { ...onchain, buyer: buyerAcc.address, supplier: supAcc.address } : { ...onchain, status: 0 };
  } };
  const d = mkdtempSync(join(tmpdir(), "arra-notes-"));
  const srv = await listen(createApp({ client, vault: "0xvault", dataDir: d, staticDir: null, now: () => T, textile: fakeTextile }), 0);
  const b = `http://127.0.0.1:${srv.address().port}`;
  const postJ = (path, body) => fetch(b + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
  const sign = async (acc, n) => ({ ...n, signature: await acc.signTypedData(noteTypedData({ orderId: 1, ...n })) });
  const ZERO = `0x${"0".repeat(64)}`;

  const [s1, r1] = await postJ("/api/orders/1/notes", await sign(buyerAcc, { kind: "note", text: "Paid deposit, waiting for samples", photo: ZERO, replyTo: ZERO, at: T }));
  assert.equal(s1, 200);
  assert.equal(r1.note.role, "buyer");
  assert.equal((await postJ("/api/orders/1/notes", await sign(stranger, { kind: "note", text: "fake", photo: ZERO, replyTo: ZERO, at: T })))[0], 403, "strangers can't post");
  const forged = await sign(buyerAcc, { kind: "note", text: "original", photo: ZERO, replyTo: ZERO, at: T });
  assert.equal((await postJ("/api/orders/1/notes", { ...forged, text: "edited after signing" }))[0], 403, "changing the words breaks the signature");

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]).toString("base64");
  const [, { photo }] = await postJ("/api/orders/1/photos", { jpegBase64: jpeg });
  assert.match(photo, /^0x[0-9a-f]{64}$/);
  assert.equal((await fetch(`${b}/api/photos/${photo}.jpg`)).headers.get("content-type"), "image/jpeg");

  const [, ch] = await postJ("/api/orders/1/notes", await sign(supAcc, { kind: "change", text: "Colour changes from navy to black", photo, replyTo: ZERO, at: T }));
  assert.equal((await postJ("/api/orders/1/notes", await sign(supAcc, { kind: "agree", text: "", photo: ZERO, replyTo: ch.note.id, at: T })))[0], 400, "you can't agree to your own change");
  assert.equal((await postJ("/api/orders/1/notes", await sign(buyerAcc, { kind: "agree", text: "", photo: ZERO, replyTo: ch.note.id, at: T })))[0], 200);
  const list = (await fetch(`${b}/api/orders/1/notes`).then((r) => r.json())).notes;
  assert.equal(list.length, 3);
  assert.equal(list.find((n) => n.kind === "change").agreedBy, buyerAcc.address);
  srv.close();
});

test("terms first: the supplier agrees to exactly this draft; any edit resets it; or they suggest a change", async () => {
  const [, { code }] = await post("/api/invites", { buyer: BUYER, name: "Brightway" });
  const [, d1] = await post(`/api/invites/${code}/draft`, { sheet });
  assert.equal(d1.draftRef, sheetRef(sheet));
  assert.equal((await post(`/api/invites/${code}/agree`, { address: SUPPLIER, ref: `0x${"00".repeat(32)}` }))[0], 409, "agreeing to an old version fails");
  const [as, agreed] = await post(`/api/invites/${code}/agree`, { address: SUPPLIER, ref: d1.draftRef });
  assert.equal(as, 200);
  assert.equal(agreed.agreedRef, d1.draftRef);
  assert.equal(agreed.address, SUPPLIER, "agreeing also gives the buyer the wallet");
  const changed = { ...sheet, quantity: 12 };
  const [, d2] = await post(`/api/invites/${code}/draft`, { sheet: changed });
  assert.equal(d2.agreedRef, null, "editing the terms resets the agreement");
  const [, sug] = await post(`/api/invites/${code}/suggest`, { address: SUPPLIER, text: "12 is fine but ship by 20 Dec" });
  assert.equal(sug.changeRequest.text, "12 is fine but ship by 20 Dec");
  assert.equal((await post(`/api/invites/${code}/agree`, { address: "0x3333333333333333333333333333333333333333", ref: d2.draftRef }))[0], 409, "a different wallet can't agree for them");
  assert.equal((await get(`/api/invites/${code}`))[1].draft.quantity, 12);
});

test("sign-in: a real wallet signature gets a 30-day session; forged or old ones don't", async () => {
  const acct = privateKeyToAccount(generatePrivateKey());
  const at = Date.now();
  const [, { text }] = await get(`/api/session/text?address=${acct.address}&at=${at}`);
  const signature = await acct.signMessage({ message: text });
  const [ok, { token }] = await post("/api/session", { address: acct.address, at, signature });
  assert.equal(ok, 200);
  assert.equal(LINKS.sessionWallet(token), acct.address.toLowerCase());
  assert.equal((await post("/api/session", { address: SUPPLIER, at, signature }))[0], 401, "signature from another wallet");
  assert.equal((await post("/api/session", { address: acct.address, at: at - 3600_000, signature }))[0], 400, "stale sign-in");
  assert.equal(LINKS.sessionWallet(token.replace(/.$/, (c) => (c === "a" ? "b" : "a"))), null, "tampered token");
  assert.equal(LINKS.sessionWallet(LINKS.session(SUPPLIER, Date.now() - 31 * 86400_000)), null, "expired token");
});

test("after locking, only the sheet's author gets the order's private link", async () => {
  const [, o] = await get("/api/orders/1");
  const ref = o.order.ref;
  assert.equal((await post("/api/orders/1/link", { owner: "nope" }))[0], 403);
  const [s, r] = await post("/api/orders/1/link", { owner: LINKS.owner(ref) });
  assert.equal(s, 200);
  assert.equal(r.link, LINKS.code(1));
});
