// Turns an order's timeline into the money lines of its receipt.
// `to` says where the money went: the vault, the supplier or the buyer.
export function moneyRows(steps, order) {
  // The last releasePart also emits BalanceReleased in the same transaction: count it once.
  const partTx = new Set(steps.filter((s) => s.event === "PartReleased").map((s) => s.tx));
  const rows = [];
  for (const s of steps) {
    if (s.event === "BalanceReleased" && partTx.has(s.tx)) continue;
    const base = { at: s.at, tx: s.tx };
    switch (s.event) {
      case "OrderCreated":
        rows.push({ ...base, what: "Buyer locked the order total in the vault", amount: s.amount, to: "vault" });
        break;
      case "OrderAccepted":
        if (s.amount !== "0") rows.push({ ...base, what: "Deposit paid to the supplier on acceptance", amount: s.amount, to: "supplier" });
        break;
      case "PartReleased":
        rows.push({ ...base, what: "Part of the balance paid to the supplier", amount: s.amount, to: "supplier" });
        break;
      case "BalanceReleased":
        rows.push({ ...base, what: "Balance paid to the supplier", amount: s.amount, to: "supplier" });
        break;
      case "BalanceRefunded":
        rows.push({ ...base, what: "Returned to the buyer", amount: s.amount, to: "buyer" });
        break;
      case "KeeperPaid":
        rows.push({ ...base, what: "Fee to Arra's agent for the automatic refund or payout", amount: s.amount, to: "keeper" });
        break;
      case "SplitSettled":
        if (s.amount !== "0") rows.push({ ...base, what: "Agreed split: supplier's share", amount: s.amount, to: "supplier" });
        if (s.toBuyer && s.toBuyer !== "0") rows.push({ ...base, what: "Agreed split: buyer's share returned", amount: s.toBuyer, to: "buyer" });
        break;
      default:
    }
  }
  // If history is unavailable, still show the total so the receipt is never empty.
  if (!rows.length) rows.push({ at: Math.floor(Date.now() / 1000), tx: "", what: "Order total", amount: order.total, to: "vault" });
  return rows;
}
