// Reads the vault's events into per-order timelines (each step with its time
// and transaction) and live totals for the homepage. Logs are fetched in
// chunks and cached, so each refresh only reads new blocks.
import { vaultAbi, readOrder, orderCount } from "./vault.js";

const EVENTS = vaultAbi.filter((e) => e.type === "event");
const ORDER_EVENTS = new Set(["OrderCreated", "OrderAccepted", "OrderShipped", "OrderDisputed", "PartReleased", "SplitProposed", "SplitSettled", "BalanceReleased", "BalanceRefunded"]);

export class LogIndex {
  constructor({ client, vault, fromBlock, chunk = 4_000n, lag = 2n }) {
    // forno.celo.org answers eth_getLogs for at most 5,000 blocks per request.
    if (chunk > 5_000n) chunk = 5_000n;
    this.lag = lag;
    this.client = client;
    this.vault = vault;
    this.next = fromBlock != null ? BigInt(fromBlock) : null;
    this.chunk = chunk;
    this.logs = [];
    this.blockTimes = new Map();
    this.syncing = null;
  }

  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      // Stay 2 blocks behind the tip: public nodes can be a block or two apart,
      // and asking a lagging node for a block it hasn't seen fails.
      const tip = await this.client.getBlockNumber({ cacheTime: 0 });
      const head = tip > this.lag ? tip - this.lag : tip;
      if (this.next == null) this.next = head > 500_000n ? head - 500_000n : 0n;
      let failures = 0;
      while (this.next <= head) {
        const to = this.next + this.chunk - 1n < head ? this.next + this.chunk - 1n : head;
        let logs;
        try {
          logs = await this.client.getLogs({ address: this.vault, events: EVENTS, fromBlock: this.next, toBlock: to, strict: true });
        } catch (e) {
          // Too big a range for this node, or a hiccup: read smaller pieces and retry.
          if (++failures > 6) throw e;
          if (this.chunk > 1_000n) this.chunk /= 2n;
          await new Promise((r) => setTimeout(r, 400 * failures));
          continue;
        }
        failures = 0;
        for (const l of logs) if (ORDER_EVENTS.has(l.eventName)) this.logs.push(l);
        this.next = to + 1n;
      }
    })().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  async time(blockNumber) {
    const k = blockNumber.toString();
    if (!this.blockTimes.has(k)) {
      let b;
      for (let i = 0; ; i++) {
        try {
          b = await this.client.getBlock({ blockNumber });
          break;
        } catch (e) {
          if (i >= 3) throw e;
          await new Promise((r) => setTimeout(r, 500 * (i + 1)));
        }
      }
      this.blockTimes.set(k, Number(b.timestamp));
    }
    return this.blockTimes.get(k);
  }

  /** Every step of one order, oldest first, with amounts in USDT units as strings. */
  async timeline(id) {
    await this.sync();
    const mine = this.logs.filter((l) => l.args.id === BigInt(id));
    // A final releasePart also emits BalanceReleased in the same transaction; show it once.
    const partTx = new Set(mine.filter((l) => l.eventName === "PartReleased").map((l) => l.transactionHash));
    const out = [];
    for (const l of mine) {
      if (l.eventName === "BalanceReleased" && partTx.has(l.transactionHash)) continue;
      const a = l.args;
      const amount = a.depositPaid ?? a.amount ?? a.total ?? a.toSupplier ?? null;
      out.push({
        event: l.eventName,
        at: await this.time(l.blockNumber),
        tx: l.transactionHash,
        amount: amount != null ? amount.toString() : null,
        ...(a.toBuyer != null ? { toBuyer: a.toBuyer.toString() } : {}),
        ...(a.remaining != null ? { remaining: a.remaining.toString() } : {}),
      });
    }
    return out;
  }
}

/**
 * How each vault event moves money for the buyer and the supplier of that
 * order. "in" / "out" change the person's wallet; "info" is money moving
 * inside the order (for example the buyer's locked money paying the deposit).
 */
export function moneyFor(event, a) {
  const amt = (v) => (v != null ? v.toString() : null);
  switch (event) {
    case "OrderCreated":
      return { buyer: ["out", amt(a.total), "Locked in the vault"], supplier: ["info", amt(a.total), "Buyer locked the money"] };
    case "OrderAccepted":
      return { buyer: ["info", amt(a.depositPaid), "Deposit paid to the supplier from the vault"], supplier: ["in", amt(a.depositPaid), "Deposit received"] };
    case "PartReleased":
      return { buyer: ["info", amt(a.amount), "Part of the balance paid to the supplier"], supplier: ["in", amt(a.amount), "Part of the balance received"] };
    case "BalanceReleased":
      return { buyer: ["info", amt(a.amount), "Balance paid to the supplier"], supplier: ["in", amt(a.amount), "Balance received"] };
    case "BalanceRefunded":
      return { buyer: ["in", amt(a.amount), "Refunded to you"], supplier: ["info", amt(a.amount), "Refunded to the buyer"] };
    case "SplitSettled":
      return { buyer: ["in", amt(a.toBuyer), "Your share of the agreed split"], supplier: ["in", amt(a.toSupplier), "Your share of the agreed split"] };
    default:
      return null; // shipped, disputed, split offered: no money moved
  }
}

/** Every money movement for one wallet, newest first, across all its orders. */
LogIndex.prototype.activity = async function activity(address) {
  await this.sync();
  const me = address.toLowerCase();
  const parties = new Map();
  for (const l of this.logs) {
    if (l.eventName === "OrderCreated") parties.set(l.args.id, { buyer: l.args.buyer.toLowerCase(), supplier: l.args.supplier.toLowerCase(), ref: l.args.ref });
  }
  // Paying the last of the balance with releasePart emits PartReleased and
  // BalanceReleased in the same transaction for the same money: count it once.
  const partTx = new Set(this.logs.filter((l) => l.eventName === "PartReleased").map((l) => `${l.transactionHash}:${l.args.id}`));
  const rows = [];
  for (const l of this.logs) {
    if (l.eventName === "BalanceReleased" && partTx.has(`${l.transactionHash}:${l.args.id}`)) continue;
    const p = parties.get(l.args.id);
    if (!p) continue;
    const role = p.buyer === me ? "buyer" : p.supplier === me ? "supplier" : null;
    if (!role) continue;
    const m = moneyFor(l.eventName, l.args)?.[role];
    if (!m || m[1] === "0") continue;
    rows.push({
      orderId: Number(l.args.id),
      role,
      event: l.eventName,
      flow: m[0],
      amount: m[1],
      label: m[2],
      counterparty: role === "buyer" ? p.supplier : p.buyer,
      ref: p.ref,
      at: await this.time(l.blockNumber),
      tx: l.transactionHash,
    });
  }
  return rows.reverse();
};

/** Totals across all orders, for the homepage. */
export async function vaultStats(client, vault) {
  const n = await orderCount(client, vault);
  let lockedNow = 0n;
  let totalValue = 0n;
  let completed = 0;
  const suppliers = new Set();
  const buyers = new Set();
  for (let id = 1; id <= n; id++) {
    const o = await readOrder(client, vault, id);
    if (!o) continue;
    totalValue += BigInt(o.total);
    lockedNow += BigInt(o.held);
    buyers.add(o.buyer.toLowerCase());
    if (o.status !== "Pending") {
      suppliers.add(o.supplier.toLowerCase());
    }
    if (["Released", "Settled", "Refunded"].includes(o.status)) completed++;
  }
  return {
    orders: n,
    completed,
    buyers: buyers.size,
    suppliers: suppliers.size,
    lockedNow: lockedNow.toString(),
    totalValue: totalValue.toString(),
  };
}
