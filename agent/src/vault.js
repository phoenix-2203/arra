// Reading the ArraVault and working out what each side can do next.
import { readFileSync } from "node:fs";
import { formatUnits } from "viem";

export const vaultArtifact = JSON.parse(readFileSync(new URL("../abi/ArraVault.json", import.meta.url)));
export const vaultAbi = vaultArtifact.abi;
// v2 and v3 vaults return a shorter order struct; read them with their own interface.
export const legacyAbi = JSON.parse(readFileSync(new URL("../abi/ArraVault.v3.json", import.meta.url))).abi;
export const DISPUTE_REPLY = 7 * 86400;
export const DISPUTE_MAX = 30 * 86400;

export const STATUS = ["None", "Pending", "Active", "Shipped", "Disputed", "Released", "Refunded", "Settled"];
export const FINAL = new Set(["Released", "Refunded", "Settled"]);

const usd = (v) => Number(formatUnits(BigInt(v), 6)).toFixed(2);

/** Order as plain JSON (bigints as strings), or null if the id doesn't exist. */
/** v4 vaults have DISPUTE_REPLY; older ones don't. Asked once per vault, then remembered. */
const abiCache = new Map();
export async function abiFor(client, vault) {
  const key = String(vault).toLowerCase();
  if (!abiCache.has(key)) {
    abiCache.set(
      key,
      client
        .readContract({ address: vault, abi: vaultAbi, functionName: "DISPUTE_REPLY" })
        .then(() => vaultAbi)
        .catch((e) => {
          // "No data" / revert = an older vault without that constant: remember it.
          // Anything else (a network hiccup): use the older interface this time, ask again later.
          if (!/returned no data|reverted|execution/i.test(`${e?.shortMessage} ${e?.message}`)) abiCache.delete(key);
          return legacyAbi;
        }),
    );
  }
  return abiCache.get(key);
}

export async function readOrder(client, vault, id, abi) {
  abi ??= await abiFor(client, vault);
  const [o, split] = await Promise.all([
    client.readContract({ address: vault, abi, functionName: "getOrder", args: [BigInt(id)] }),
    client.readContract({ address: vault, abi, functionName: "getSplitOffer", args: [BigInt(id)] }),
  ]);
  const v4 = o.transit !== undefined;
  const status = STATUS[Number(o.status)];
  if (status === "None") return null;
  return {
    id: Number(id),
    buyer: o.buyer,
    supplier: o.supplier,
    total: o.total.toString(),
    deposit: o.deposit.toString(),
    held: o.held.toString(),
    acceptBy: Number(o.acceptBy),
    shipBy: Number(o.shipBy),
    shippedAt: Number(o.shippedAt),
    disputeWindow: Number(o.disputeWindow),
    status,
    ref: o.ref,
    // v4 fields (0 on older vaults, which behave as transit 0: the window starts at shipping)
    v4,
    transit: v4 ? Number(o.transit) : 0,
    arrivedAt: v4 ? Number(o.arrivedAt) : 0,
    disputedAt: v4 ? Number(o.disputedAt) : 0,
    splitOffer:
      split.proposer === "0x0000000000000000000000000000000000000000"
        ? null
        : { proposer: split.proposer, toSupplier: split.toSupplier.toString(), at: split.at !== undefined ? Number(split.at) : 0 },
    usd: { total: usd(o.total), deposit: usd(o.deposit), held: usd(o.held) },
  };
}

export async function orderCount(client, vault) {
  const next = await client.readContract({ address: vault, abi: vaultAbi, functionName: "nextId" });
  return Number(next) - 1;
}

/** When the buyer's check period starts: confirmed arrival, else shipping + transit. */
export const checkStart = (o) => (o.arrivedAt ? o.arrivedAt : o.shippedAt + (o.transit ?? 0));
export const checkEnds = (o) => checkStart(o) + o.disputeWindow;

/** v4: when an unresolved dispute can be ended (stale offer or 30 days), or null. */
export function disputeDueAt(o) {
  if (!o.v4 || o.status !== "Disputed") return null;
  const expiry = o.disputedAt + DISPUTE_MAX;
  if (!o.splitOffer) return expiry;
  return Math.min(expiry, Math.max(o.splitOffer.at, o.disputedAt) + DISPUTE_REPLY);
}

/** The moment after which nobody needs to wait any more, if any. */
export function dueAction(order, now) {
  if (order.status === "Pending" && now > order.acceptBy) return "reclaim";
  if (order.status === "Active" && now > order.shipBy) return "reclaim";
  if (order.status === "Shipped" && now > checkEnds(order)) return "claim";
  const d = disputeDueAt(order);
  if (d !== null && now > d) return "resolveDispute";
  return null;
}

/**
 * What `who` ("buyer" | "supplier" | "anyone") can do now, with plain-language
 * deadlines. Mirrors the contract's rules so the app never offers a button
 * that would fail.
 */
export function nextActions(order, now, who) {
  const a = [];
  const s = order.status;
  const live = s === "Active" || s === "Shipped" || s === "Disputed";
  const due = dueAction(order, now);

  if (who === "supplier") {
    if (s === "Pending" && now <= order.acceptBy) a.push("accept", "decline");
    if (s === "Active" && now <= order.shipBy) a.push("markShipped");
    if (live) a.push("proposeSplit", "refundBuyer");
  }
  if (who === "buyer") {
    if (s === "Pending") a.push("cancel");
    if (order.v4 && (s === "Pending" || s === "Active")) a.push("extendDeadlines");
    if (order.v4 && s === "Shipped" && !order.arrivedAt && order.transit > 0 && now <= order.shippedAt + order.transit) a.push("confirmArrival");
    if (live && BigInt(order.held) > 0n) a.push("releasePart", "release", "proposeSplit");
    if (s === "Shipped" && now <= checkEnds(order)) a.push("dispute");
  }
  if (live && order.splitOffer && who !== "anyone") {
    const mine = order.splitOffer.proposer.toLowerCase() === (who === "buyer" ? order.buyer : order.supplier).toLowerCase();
    if (!mine) a.push("acceptSplit");
  }
  if (due) a.push(due);
  return a;
}

/** One line on where the order stands and what happens next. */
export function explain(order, now) {
  const when = (t) => new Date(t * 1000).toUTCString().slice(0, 16);
  const u = order.usd;
  switch (order.status) {
    case "Pending":
      return now > order.acceptBy
        ? `The supplier didn't accept in time. The buyer can take back all $${u.total}.`
        : `$${u.total} is locked. Waiting for the supplier to accept by ${when(order.acceptBy)}; they get the $${u.deposit} deposit the moment they do.`;
    case "Active":
      return now > order.shipBy
        ? `Not shipped by ${when(order.shipBy)}. The $${u.held} balance goes back to the buyer.`
        : `Accepted. Deposit paid; $${u.held} stays locked until shipping (due by ${when(order.shipBy)}).`;
    case "Shipped": {
      const end = checkEnds(order);
      if (now > end) return `Shipped and no problem was raised. The $${u.held} balance can be paid to the supplier.`;
      if (order.v4 && !order.arrivedAt && order.transit > 0 && now <= order.shippedAt + order.transit) {
        return `Shipped and on its way. The buyer's ${Math.round(order.disputeWindow / 86400)}-day check period starts when they confirm arrival, or on ${when(order.shippedAt + order.transit)} at the latest. The $${u.held} balance pays out after that unless they raise a problem.`;
      }
      return `Shipped. The buyer has until ${when(end)} to check the goods; after that the $${u.held} balance pays out automatically.`;
    }
    case "Disputed": {
      const d = disputeDueAt(order);
      if (d === null) return `Disputed. $${u.held} stays locked until both sides agree a split or the buyer releases it.`;
      return order.splitOffer && d < order.disputedAt + DISPUTE_MAX
        ? `Disputed. A split offer is on the table; if the other side doesn't accept or counter by ${when(d)}, it goes through as offered.`
        : `Disputed. $${u.held} stays locked while both sides talk. With no agreement by ${when(d)}, it splits 50/50.`;
    }
    case "Released":
      return "Complete: the supplier has been paid in full.";
    case "Refunded":
      return "Closed: the locked balance went back to the buyer.";
    case "Settled":
      return "Settled by an agreed split.";
    default:
      return "";
  }
}
