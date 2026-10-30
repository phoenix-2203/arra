// Arra across vault versions. Deployed contracts never change, so an upgrade is
// a new vault; old orders finish where they are. Order numbers never overlap
// (the new vault starts after the old one's last order), so every number
// belongs to exactly one vault and the app can treat them as one Arra.
import { readOrder, orderCount } from "./vault.js";
import { LogIndex } from "./history.js";

export class VaultSet {
  /**
   * @param vaults oldest first: [{ address, firstId, fromBlock?, history? }]
   *               The last one is where new orders go.
   */
  constructor({ client, vaults, lag }) {
    if (!vaults?.length) throw new Error("at least one vault");
    this.client = client;
    this.list = vaults.map((v) => ({
      address: v.address,
      firstId: v.firstId ?? 1,
      history: v.history ?? new LogIndex({ client, vault: v.address, fromBlock: v.fromBlock, lag }),
    }));
  }

  /** Where new orders are created. */
  get current() {
    return this.list.at(-1).address;
  }

  get addresses() {
    return this.list.map((v) => v.address);
  }

  /** The vault an order number lives in. */
  entryFor(id) {
    let hit = this.list[0];
    for (const v of this.list) if (Number(id) >= v.firstId) hit = v;
    return hit;
  }

  vaultFor(id) {
    return this.entryFor(id).address;
  }

  /** Highest order number across all vaults. */
  async count() {
    const counts = await Promise.all(this.list.map((v) => orderCount(this.client, v.address)));
    return Math.max(0, ...counts);
  }

  /** The order, with the address of the vault that holds it. */
  async read(id) {
    const vault = this.vaultFor(id);
    const o = await readOrder(this.client, vault, id);
    return o ? { ...o, vault } : null;
  }

  sync() {
    return Promise.all(this.list.map((v) => v.history.sync()));
  }

  timeline(id) {
    return this.entryFor(id).history.timeline(id);
  }

  /** Every payment in or out of one wallet, across all vaults, newest first. */
  async activity(address) {
    const all = (await Promise.all(this.list.map((v) => v.history.activity(address)))).flat();
    return all.sort((a, b) => b.at - a.at);
  }

  /** Homepage totals across all vaults. */
  async stats() {
    const n = await this.count();
    let lockedNow = 0n;
    let totalValue = 0n;
    let completed = 0;
    let orders = 0;
    const buyers = new Set();
    const suppliers = new Set();
    for (let id = 1; id <= n; id++) {
      const o = await this.read(id);
      if (!o) continue;
      orders++;
      totalValue += BigInt(o.total);
      lockedNow += BigInt(o.held);
      buyers.add(o.buyer.toLowerCase());
      if (o.status !== "Pending") suppliers.add(o.supplier.toLowerCase());
      if (["Released", "Settled", "Refunded"].includes(o.status)) completed++;
    }
    return { orders, completed, buyers: buyers.size, suppliers: suppliers.size, lockedNow: lockedNow.toString(), totalValue: totalValue.toString() };
  }
}
