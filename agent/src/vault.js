// Reading the ArraVault and working out what each side can do next.
import { readFileSync } from "node:fs";
import { formatUnits } from "viem";

export const vaultArtifact = JSON.parse(readFileSync(new URL("../abi/ArraVault.json", import.meta.url)));
export const vaultAbi = vaultArtifact.abi;

export const STATUS = ["None", "Pending", "Active", "Shipped", "Disputed", "Released", "Refunded", "Settled"];
export const FINAL = new Set(["Released", "Refunded", "Settled"]);

const usd = (v) => formatUnits(BigInt(v), 6);

/** Order as plain JSON (bigints as strings), or null if the id doesn't exist. */
export async function readOrder(client, vault, id) {
  const [o, split] = await Promise.all([
    client.readContract({ address: vault, abi: vaultAbi, functionName: "getOrder", args: [BigInt(id)] }),
    client.readContract({ address: vault, abi: vaultAbi, functionName: "getSplitOffer", args: [BigInt(id)] }),
  ]);
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
    splitOffer:
      split.proposer === "0x0000000000000000000000000000000000000000"
        ? null
        : { proposer: split.proposer, toSupplier: split.toSupplier.toString() },
    usd: { total: usd(o.total), deposit: usd(o.deposit), held: usd(o.held) },
  };
}

export async function orderCount(client, vault) {
  const next = await client.readContract({ address: vault, abi: vaultAbi, functionName: "nextId" });
  return Number(next) - 1;
}

/** The moment after which nobody needs to wait any more, if any. */
export function dueAction(order, now) {
  if (order.status === "Pending" && now > order.acceptBy) return "reclaim";
  if (order.status === "Active" && now > order.shipBy) return "reclaim";
  if (order.status === "Shipped" && now > order.shippedAt + order.disputeWindow) return "claim";
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
    if (live && BigInt(order.held) > 0n) a.push("releasePart", "release", "proposeSplit");
    if (s === "Shipped" && now <= order.shippedAt + order.disputeWindow) a.push("dispute");
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
      const end = order.shippedAt + order.disputeWindow;
      return now > end
        ? `Shipped and no dispute was raised. The $${u.held} balance can be paid to the supplier.`
        : `Shipped. The buyer has until ${when(end)} to check the goods; after that the $${u.held} balance pays out automatically.`;
    }
    case "Disputed":
      return `Disputed. $${u.held} stays locked until both sides agree a split or the buyer releases it.`;
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
