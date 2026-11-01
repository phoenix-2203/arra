import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { referenceRate, guard, premiumBps, clampMaxBps, FxLedger, returns, DEFAULT_MAX_BPS } from "../src/fxGuard.js";

const ok = (body) => ({ ok: true, json: async () => body });
const src = (name, url, pick) => ({ name, urls: [url], pick, at: () => null });
const SOURCES = [src("a", "https://a", (j) => j.ngn), src("b", "https://b", (j) => j.ngn), src("c", "https://c", (j) => j.ngn)];

test("reference rate is the median of the sources that answer, ignoring nonsense", async () => {
  const answers = { "https://a": ok({ ngn: 1340 }), "https://b": ok({ ngn: 1350 }), "https://c": ok({ ngn: 2 }) };
  const r = await referenceRate({ sources: SOURCES, fetchImpl: async (u) => answers[u] }).get();
  assert.equal(r.ngnPerUsd, 1345);
  assert.equal(r.sources.length, 2);
  assert.equal(r.disagree, false);
});

test("reference rate tries a mirror, flags disagreement, keeps the last good value for 48h", async () => {
  let t = 0;
  let down = false;
  const sources = [{ name: "m", urls: ["https://dead", "https://mirror"], pick: (j) => j.ngn, at: () => null }, src("b", "https://b", (j) => j.ngn)];
  const fetchImpl = async (u) => {
    if (down || u === "https://dead") throw new Error("down");
    return ok({ ngn: u === "https://mirror" ? 1300 : 1400 });
  };
  const rr = referenceRate({ sources, fetchImpl, now: () => t });
  const first = await rr.get();
  assert.equal(first.ngnPerUsd, 1350);
  assert.equal(first.disagree, true, "1300 vs 1400 is more than 5% apart");
  down = true;
  t = 11 * 60_000;
  assert.equal((await rr.get()).stale, true);
  t = 49 * 3600_000;
  assert.equal(await rr.get(), null);
});

test("guard: refuses above the buyer's limit, passes (and says so) with no reference", () => {
  assert.equal(premiumBps(1374, 1346.86), 202);
  const ref = { ngnPerUsd: 1346.86 };
  assert.equal(guard({ ngnPerUsd: 1374, ref }).ok, true, "2.0% is inside the default 3%");
  assert.equal(guard({ ngnPerUsd: 1374, ref, maxBps: 100 }).ok, false);
  assert.equal(guard({ ngnPerUsd: 1420, ref }).ok, false, "5.4% above the mid is refused by default");
  const blind = guard({ ngnPerUsd: 1374, ref: null });
  assert.equal(blind.ok, true);
  assert.equal(blind.checked, false);
  assert.equal(clampMaxBps("nope"), DEFAULT_MAX_BPS);
  assert.equal(clampMaxBps(5), 25);
  assert.equal(clampMaxBps(99999), 1000);
});

test("ledger and returns: execution cost and lock value on filled conversions only", () => {
  const l = new FxLedger(join(mkdtempSync(join(tmpdir(), "arra-fx-")), "fx.jsonl"));
  l.add({ at: 1, rfqId: "r1", usd: "100", ngnPerUsd: 1350, refNgnPerUsd: 1340, premiumBps: 75, status: "quoted" });
  l.add({ at: 2, rfqId: "r2", usd: "50", ngnPerUsd: 1350, refNgnPerUsd: 1340, premiumBps: 75, status: "quoted" });
  l.add({ at: 3, rfqId: "r3", usd: "10", ngnPerUsd: 1500, refNgnPerUsd: 1340, premiumBps: 1194, maxBps: 300, status: "guarded" });
  assert.equal(l.filled("r1", "0xabc", 5), true);
  assert.equal(l.filled("r1", "0xdef", 6), false, "a fill is recorded once");
  const r = returns(l.all(), { ngnPerUsd: 1370 });
  assert.equal(r.fills, 1, "r2 was quoted but never filled");
  assert.equal(r.nairaPaid, 135_000);
  assert.equal(r.executionCostNgn, 1_000);
  assert.equal(r.lockValueNgn, 3_000, "the same $100 costs ₦3,000 more at today's mid");
  assert.equal(r.avgPremiumBps, 75);
  assert.equal(r.refused.length, 1);
  assert.equal(returns(l.all(), null).lockValueNgn, null);
});
