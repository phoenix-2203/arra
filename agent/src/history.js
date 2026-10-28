// Reads the vault's events into per-order timelines (each step with its time
// and transaction) and live totals for the homepage. Logs are fetched in
// chunks and cached, so each refresh only reads new blocks.
import { vaultAbi, readOrder, orderCount } from "./vault.js";

const EVENTS = vaultAbi.filter((e) => e.type === "event");
const ORDER_EVENTS = new Set(["OrderCreated", "OrderAccepted", "OrderShipped", "OrderDisputed", "PartReleased", "SplitProposed", "SplitSettled", "BalanceReleased", "BalanceRefunded"]);

export class LogIndex {
  constructor({ client, vault, fromBlock, chunk = 20_000n }) {
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
      const head = await this.client.getBlockNumber({ cacheTime: 0 });
      if (this.next == null) this.next = head > 500_000n ? head - 500_000n : 0n;
      while (this.next <= head) {
        const to = this.next + this.chunk - 1n < head ? this.next + this.chunk - 1n : head;
        const logs = await this.client.getLogs({ address: this.vault, events: EVENTS, fromBlock: this.next, toBlock: to, strict: true });
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
      const b = await this.client.getBlock({ blockNumber });
      this.blockTimes.set(k, Number(b.timestamp));
    }
    return this.blockTimes.get(k);
  }

  /** Every step of one order, oldest first, with amounts in USDT units as strings. */
  async timeline(id) {
    await this.sync();
    const mine = this.logs.filter((l) => l.args.id === BigInt(id));
    const out = [];
    for (const l of mine) {
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
