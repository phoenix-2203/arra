// API tests with a fake chain reader (no network).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, listen } from "../src/server.js";
import { sheetRef } from "../src/orderSheet.js";
import { TextileError } from "../src/textile.js";

const BUYER = "0x1111111111111111111111111111111111111111";
const SUPPLIER = "0x2222222222222222222222222222222222222222";
const sheet = {
  supplier: "Guangzhou Textiles",
  product: "Cotton T-shirts, crew neck",
  quantity: 10,
  unit: "pieces",
  unitPriceUsd: "2.00",
  specs: ["180 gsm 100% combed cotton"],
  packaging: "10 per carton",
  shipBy: "2026-12-15",
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
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Arra</title>");
  server = await listen(createApp({ client: fakeClient, vault: "0xvault", dataDir: join(dir, "data"), staticDir, now: () => T, textile: fakeTextile }), 0);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => [r.status, await r.json()]);
const get = (path) => fetch(base + path).then(async (r) => [r.status, r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text()]);

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

test("my orders, container check, errors and the app shell", async () => {
  const [, list] = await get(`/api/orders?address=${SUPPLIER}`);
  assert.equal(list.orders.length, 1);
  assert.equal((await post("/api/container/check", { number: "CSQU3054383" }))[1].ok, true);
  assert.equal((await get("/api/orders?address=nope"))[0], 400);
  assert.equal((await get("/api/nope"))[0], 404);
  const bad = await fetch(base + "/api/sheet/review", { method: "POST", body: "{" });
  assert.equal(bad.status, 400);
  const [s, html] = await get("/o/1");
  assert.equal(s, 200);
  assert.match(html, /<title>Arra/);
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
