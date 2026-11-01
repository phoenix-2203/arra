// Arra's treasury rules for turning a buyer's naira into the dollars an order needs.
//
// Arra is the buyer's treasury agent, not a trader: it never holds a position of its own.
// Its job is to (1) remove the naira risk between deposit and balance by converting the
// whole order once, on day one, and (2) make sure that one conversion is a fair price.
// This file is (2) and the record of (1). The full strategy is in docs/strategy.md.
//
// - referenceRate(): an independent naira-per-dollar mid rate (two free public sources,
//   median, cached; the last good value is kept for 48 hours if both go quiet).
// - guard(): compares Textile's firm quote with that reference and refuses a quote that
//   costs more than the buyer's limit above it. Nothing moves when it refuses.
// - FxLedger: every conversion Arra makes, with the reference at that moment, so the
//   returns can be measured afterwards: execution cost now, and what the lock was worth.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const REF_SOURCES = [
  {
    name: "ExchangeRate-API",
    // FX_REF_API swaps in another feed with the same answer shape (a paid feed, or a local test).
    urls: [process.env.FX_REF_API ?? "https://open.er-api.com/v6/latest/USD"],
    pick: (j) => j?.rates?.NGN,
    at: (j) => j?.time_last_update_unix,
  },
  {
    name: "currency-api",
    urls: ["https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json", "https://latest.currency-api.pages.dev/v1/currencies/usd.json"],
    pick: (j) => j?.usd?.ngn,
    at: (j) => (j?.date ? Math.floor(Date.parse(`${j.date}T00:00:00Z`) / 1000) : null),
  },
];

// Limits the buyer can pick: how far above the independent mid rate Arra may convert.
// The default is 3%: a small importer's real alternative is the street rate, which in
// October 2026 ran about 2.5-3% above the official one (₦1,385 vs ₦1,347; see strategy.md).
export const DEFAULT_MAX_BPS = 300;
export const MAX_BPS_CHOICES = [100, 300, 500];
export const clampMaxBps = (v) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(1000, Math.max(25, n)) : DEFAULT_MAX_BPS;
};

const sane = (r) => typeof r === "number" && Number.isFinite(r) && r > 100 && r < 100_000;
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** Independent naira-per-dollar reference. get() → { ngnPerUsd, sources, at, stale } or null. */
export function referenceRate({ fetchImpl = fetch, sources = REF_SOURCES, now = () => Date.now(), ttlMs = 10 * 60_000, keepMs = 48 * 3600_000, timeoutMs = 4000 } = {}) {
  let fresh = null; // { value, at }
  let lastGood = null;
  let inflight = null;

  async function one(src) {
    for (const url of src.urls) {
      try {
        const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) continue;
        const j = await res.json();
        const rate = Number(src.pick(j));
        if (sane(rate)) return { name: src.name, ngnPerUsd: rate, asOf: src.at(j) ?? null };
      } catch {
        /* try the next mirror */
      }
    }
    return null;
  }

  async function load() {
    const got = (await Promise.all(sources.map(one))).filter(Boolean);
    if (!got.length) return null;
    const mid = median(got.map((g) => g.ngnPerUsd));
    // Sources more than 5% apart: one of them is wrong, so say so instead of averaging blindly.
    const spread = got.length > 1 ? Math.max(...got.map((g) => g.ngnPerUsd)) / Math.min(...got.map((g) => g.ngnPerUsd)) - 1 : 0;
    return { ngnPerUsd: Math.round(mid * 100) / 100, sources: got, disagree: spread > 0.05, at: Math.floor(now() / 1000) };
  }

  return {
    async get() {
      if (fresh && now() - fresh.at < ttlMs) return fresh.value;
      inflight ??= load().finally(() => (inflight = null));
      const v = await inflight;
      if (v) {
        fresh = { value: v, at: now() };
        lastGood = fresh;
        return v;
      }
      if (lastGood && now() - lastGood.at < keepMs) return { ...lastGood.value, stale: true };
      return null;
    },
  };
}

/** How much more naira per dollar a quote costs than the reference, in basis points (1% = 100). */
export const premiumBps = (rate, ref) => (sane(rate) && sane(ref) ? Math.round((rate / ref - 1) * 10_000) : null);

/**
 * Should Arra take this quote? With no reference at all (both sources down for two days)
 * the guard lets the quote through and says so: the buyer still sees and confirms the
 * exact rate in their wallet, and blocking every naira payment would be worse.
 */
export function guard({ ngnPerUsd, ref, maxBps = DEFAULT_MAX_BPS }) {
  const limit = clampMaxBps(maxBps);
  if (!ref) return { ok: true, checked: false, premiumBps: null, maxBps: limit, refNgnPerUsd: null };
  const p = premiumBps(ngnPerUsd, ref.ngnPerUsd);
  return { ok: p !== null && p <= limit, checked: true, premiumBps: p, maxBps: limit, refNgnPerUsd: ref.ngnPerUsd, stale: !!ref.stale };
}

/** Every conversion, with the reference at that moment. One JSON object per line. */
export class FxLedger {
  constructor(file) {
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    if (!existsSync(file)) writeFileSync(file, "");
  }
  all() {
    return readFileSync(this.file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }
  add(entry) {
    appendFileSync(this.file, `${JSON.stringify(entry)}\n`);
  }
  /** Marks a quote as filled once its transaction is submitted. */
  filled(rfqId, txHash, at) {
    const rows = this.all();
    const r = rows.find((x) => x.rfqId === rfqId);
    if (!r || r.txHash) return false;
    r.txHash = txHash;
    r.filledAt = at;
    writeFileSync(this.file, rows.map((x) => JSON.stringify(x)).join("\n") + "\n");
    return true;
  }
}

/**
 * Returns of Arra's strategy on the conversions it actually made.
 * - execution: naira paid above (or below) the independent mid at the moment of the fill.
 * - lock: what the same dollars would cost at today's mid, minus what the buyer paid at
 *   the mid on the day. Positive means converting on day one saved the buyer naira.
 * Only filled conversions count; refused and expired quotes are listed separately.
 */
export function returns(rows, current) {
  const fills = rows.filter((r) => r.txHash && r.status === "quoted");
  const refused = rows.filter((r) => r.status === "guarded");
  const now = current?.ngnPerUsd ?? null;
  const per = fills.map((r) => {
    const usd = Number(r.usd);
    const paid = usd * r.ngnPerUsd;
    const exec = r.refNgnPerUsd ? usd * (r.ngnPerUsd - r.refNgnPerUsd) : null;
    const lock = r.refNgnPerUsd && now ? usd * (now - r.refNgnPerUsd) : null;
    return { rfqId: r.rfqId, at: r.filledAt ?? r.at, usd, ngnPerUsd: r.ngnPerUsd, refNgnPerUsd: r.refNgnPerUsd ?? null, premiumBps: r.premiumBps ?? null, nairaPaid: Math.round(paid), executionCostNgn: exec === null ? null : Math.round(exec), lockValueNgn: lock === null ? null : Math.round(lock), txHash: r.txHash };
  });
  const sum = (k) => per.reduce((t, x) => t + (x[k] ?? 0), 0);
  const usd = per.reduce((t, x) => t + x.usd, 0);
  const withRef = per.filter((x) => x.premiumBps !== null);
  return {
    currentRefNgnPerUsd: now,
    fills: per.length,
    usdConverted: Math.round(usd * 100) / 100,
    nairaPaid: sum("nairaPaid"),
    avgPremiumBps: withRef.length ? Math.round(withRef.reduce((t, x) => t + x.premiumBps * x.usd, 0) / withRef.reduce((t, x) => t + x.usd, 0)) : null,
    executionCostNgn: sum("executionCostNgn"),
    lockValueNgn: now ? sum("lockValueNgn") : null,
    refused: refused.map((r) => ({ at: r.at, usd: Number(r.usd), ngnPerUsd: r.ngnPerUsd, refNgnPerUsd: r.refNgnPerUsd, premiumBps: r.premiumBps, maxBps: r.maxBps })),
    rows: per,
  };
}
