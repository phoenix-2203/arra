// API tests with a fake chain reader (no network).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, listen } from "../src/server.js";
import { sheetRef } from "../src/orderSheet.js";

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

let server, base, dir;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), "arra-srv-"));
  const staticDir = join(dir, "dist");
  mkdirSync(staticDir);
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>Arra</title>");
  server = await listen(createApp({ client: fakeClient, vault: "0xvault", dataDir: join(dir, "data"), staticDir, now: () => T }), 0);
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
