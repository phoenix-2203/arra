// Gas drip: a supplier with an empty wallet can't pay the tiny network fee to
// accept an order. When this is switched on (GAS_DRIP=1), the agent sends a
// small amount of CELO to the supplier of a new, still-pending order, so they
// can accept without buying crypto first.
//
// Limits keep it from being farmed:
//  - only orders still waiting to be accepted, and worth at least `minUsd`
//  - only suppliers whose CELO balance is below `threshold`
//  - each supplier address gets gas once, ever
//  - at most `dailyMax` drips per 24 hours
//  - never more than the agent wallet holds
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { parseEther, parseUnits } from "viem";
import { readOrder, orderCount } from "./vault.js";

const DAY = 86400;

export class DripBook {
  constructor(file) {
    this.file = file;
    this.data = file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  }
  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }
  has(address) {
    return !!this.data[address.toLowerCase()];
  }
  add(address, record) {
    this.data[address.toLowerCase()] = record;
    this.save();
  }
  /** The drip sent for one order, if any. */
  forOrder(id) {
    return Object.values(this.data).find((r) => r.orderId === Number(id)) ?? null;
  }
  sentSince(t) {
    return Object.values(this.data).filter((r) => r.at >= t).length;
  }
}

export function dripSettings(env = process.env) {
  return {
    enabled: env.GAS_DRIP === "1",
    amount: parseEther(env.GAS_DRIP_CELO ?? "0.01"),
    threshold: parseEther(env.GAS_DRIP_BELOW_CELO ?? "0.002"),
    minUsd: parseUnits(env.GAS_DRIP_MIN_USD ?? "1", 6),
    dailyMax: Number(env.GAS_DRIP_DAILY ?? 5),
  };
}

/**
 * Checks recent pending orders and tops up suppliers with no gas.
 * `wallet` must be a taggedWallet. Returns what happened, per order.
 */
export async function runGasDrip({ client, wallet, vault, book, settings, now = Math.floor(Date.now() / 1000), txOpts = {}, lookback = 50, log = console.log }) {
  const { amount, threshold, minUsd, dailyMax } = settings;
  const results = [];
  const n = await orderCount(client, vault);
  for (let id = Math.max(1, n - lookback + 1); id <= n; id++) {
    const o = await readOrder(client, vault, id);
    if (!o || o.status !== "Pending" || now > o.acceptBy) continue;
    const who = o.supplier;
    if (book.has(who)) continue;
    if (BigInt(o.total) < minUsd) continue;
    if ((await client.getBalance({ address: who })) >= threshold) continue;
    if (book.sentSince(now - DAY) >= dailyMax) {
      log(`gas drip: daily limit reached, order ${id} skipped`);
      results.push({ id, skipped: "daily limit" });
      break;
    }
    if ((await client.getBalance({ address: wallet.account.address })) < amount) {
      log(`gas drip: agent wallet is low on CELO, order ${id} skipped`);
      results.push({ id, skipped: "agent low on CELO" });
      break;
    }
    try {
      const hash = await wallet.sendTransaction({ to: who, value: amount, ...txOpts });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("transfer failed onchain");
      book.add(who, { orderId: id, hash, amount: amount.toString(), at: now });
      log(`gas drip: sent ${amount} wei CELO to supplier of order ${id} ${hash}`);
      results.push({ id, hash });
    } catch (e) {
      log(`gas drip: order ${id} failed: ${e.shortMessage ?? e.message}`);
      results.push({ id, error: e.shortMessage ?? e.message });
    }
  }
  return results;
}
