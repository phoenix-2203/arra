import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { Reviews, reviewTypedData, dealState, REVIEW_WINDOW } from "../src/reviews.js";

const buyer = privateKeyToAccount(`0x${"1".repeat(64)}`);
const supplier = privateKeyToAccount(`0x${"2".repeat(64)}`);
const stranger = privateKeyToAccount(`0x${"3".repeat(64)}`);
const T = 1_900_000_000;
const order = (id = 7, status = "Released") => ({ id, status, buyer: buyer.address, supplier: supplier.address, usd: { total: "420.00" } });
const tl = (extra = []) => [{ event: "OrderCreated", at: T - 900 }, { event: "OrderAccepted", at: T - 800 }, ...extra];
const done = tl([{ event: "OrderShipped", at: T - 500 }, { event: "BalanceReleased", at: T - 100 }]);

async function signed(acct, id, a, at = T) {
  const signature = await acct.signTypedData(reviewTypedData({ orderId: id, ...a, at }));
  return { ...a, at, signature };
}
const good = { q1: 1, q2: 1, again: 1, comment: "On time, exactly as agreed." };

test("only accepted orders that have ended can be reviewed", () => {
  assert.equal(dealState(order(7, "Shipped"), done).eligible, false);
  assert.equal(dealState(order(7, "Refunded"), [{ event: "OrderCreated", at: 1 }, { event: "BalanceRefunded", at: 2 }]).eligible, false);
  const d = dealState(order(), done);
  assert.equal(d.eligible, true);
  assert.equal(d.closedAt, T - 100);
});

test("double-blind: hidden until both review, then both shown", async () => {
  const r = new Reviews(mkdtempSync(join(tmpdir(), "rv-")));
  const o = order();
  const d = dealState(o, done);
  await r.add(o, d, await signed(buyer, 7, good), T);
  let v = r.view(o, d, T);
  assert.equal(v.submitted.buyer, true);
  assert.equal(v.revealed, false);
  assert.deepEqual(v.reviews, {});
  assert.equal(r.summary(supplier.address, T).asSupplier.count, 0);
  await r.add(o, d, await signed(supplier, 7, { q1: 1, q2: 1, again: 1, comment: "" }), T);
  v = r.view(o, d, T);
  assert.equal(v.revealed, true);
  assert.equal(v.reviews.buyer.comment, good.comment);
  const s = r.summary(supplier.address, T).asSupplier;
  assert.equal(s.count, 1);
  assert.equal(s.people, 1);
  assert.deepEqual(s.q1, [1, 1]);
  assert.equal(s.usd, 420);
});

test("a lone review shows after 14 days; no reviews after the window", async () => {
  const r = new Reviews(mkdtempSync(join(tmpdir(), "rv-")));
  const o = order();
  const d = dealState(o, done);
  await r.add(o, d, await signed(buyer, 7, { q1: 0, q2: 2, again: 0, comment: "Never shipped" }), T);
  const later = d.closedAt + REVIEW_WINDOW;
  assert.equal(r.view(o, d, later).revealed, true);
  const s = r.summary(supplier.address, later).asSupplier;
  assert.deepEqual(s.q1, [0, 1]);
  assert.deepEqual(s.q2, [0, 0]); // "doesn't apply" isn't counted
  await assert.rejects(r.add(o, d, await signed(supplier, 7, good, later), later), /14 days/);
});

test("strangers, repeats and bad answers are refused", async () => {
  const r = new Reviews(mkdtempSync(join(tmpdir(), "rv-")));
  const o = order();
  const d = dealState(o, done);
  await assert.rejects(r.add(o, d, await signed(stranger, 7, good), T), /Only the buyer or the supplier/);
  await assert.rejects(r.add(o, d, await signed(buyer, 8, good), T), /Only the buyer or the supplier/); // signed for another order
  await assert.rejects(r.add(o, d, await signed(buyer, 7, { ...good, again: 2 }), T), /again/);
  await assert.rejects(r.add(o, d, await signed(buyer, 7, { ...good, comment: "x".repeat(281) }), T), /280/);
  await r.add(o, d, await signed(buyer, 7, good), T);
  await assert.rejects(r.add(o, d, await signed(buyer, 7, good, T + 1), T), /already/);
});
