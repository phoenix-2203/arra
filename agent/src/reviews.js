// Reviews: after a real order ends, the buyer and the supplier review each other.
//
// - Only real deals count: the order must have been accepted (money really moved) and
//   be finished (paid out, refunded or settled). Faking a review means locking real money.
// - Each review is signed by the reviewer's wallet (EIP-712, free, moves no money), so
//   nobody, Arra included, can write or edit one in someone else's name.
// - Double-blind, like Airbnb: neither side sees the other's review until both have
//   written one, or the 14-day window closes. Nobody can wait and retaliate.
// - Answers are three plain yes/no questions plus an optional short comment.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { verifyTypedData } from "viem";

export const REVIEW_WINDOW = 14 * 86400;
const FINAL = new Set(["Released", "Refunded", "Settled"]);
// 0 = no, 1 = yes, 2 = doesn't apply (e.g. "goods as described" when nothing shipped).
const ANSWERS = new Set([0, 1, 2]);

export function reviewTypedData({ orderId, q1, q2, again, comment, at }) {
  return {
    domain: { name: "Arra Reviews", version: "1", chainId: 42220 },
    types: {
      Review: [
        { name: "orderId", type: "uint256" },
        { name: "q1", type: "uint8" },
        { name: "q2", type: "uint8" },
        { name: "again", type: "uint8" },
        { name: "comment", type: "string" },
        { name: "at", type: "uint256" },
      ],
    },
    primaryType: "Review",
    message: { orderId: BigInt(orderId), q1, q2, again, comment, at: BigInt(at) },
  };
}

/** When the deal ended and whether it ever went live, from the order's onchain timeline. */
export function dealState(order, timeline) {
  const accepted = timeline.some((s) => s.event === "OrderAccepted");
  const shipped = timeline.some((s) => s.event === "OrderShipped");
  const closedAt = FINAL.has(order.status) && timeline.length ? Math.max(...timeline.map((s) => s.at)) : null;
  return { accepted, shipped, closedAt, eligible: accepted && closedAt !== null };
}

export class Reviews {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  file(id) {
    return join(this.dir, `${Number(id)}.json`);
  }
  load(id) {
    return existsSync(this.file(id)) ? JSON.parse(readFileSync(this.file(id), "utf8")) : null;
  }
  static revealed(rec, now) {
    return !!rec && ((!!rec.buyer && !!rec.supplier) || now >= rec.closedAt + REVIEW_WINDOW);
  }

  /** What the order page shows. Unrevealed reviews are never returned, not even to their author. */
  view(order, deal, now) {
    const rec = this.load(order.id);
    const closesAt = deal.closedAt !== null ? deal.closedAt + REVIEW_WINDOW : null;
    const revealed = Reviews.revealed(rec, now);
    return {
      eligible: deal.eligible,
      shipped: deal.shipped,
      open: deal.eligible && now < closesAt,
      closesAt,
      submitted: { buyer: !!rec?.buyer, supplier: !!rec?.supplier },
      revealed,
      reviews: revealed ? { buyer: rec.buyer ?? null, supplier: rec.supplier ?? null } : {},
    };
  }

  async add(order, deal, body, now) {
    const bad = (m, status = 400) => Object.assign(new Error(m), { status });
    if (!deal.eligible) throw bad("Reviews open once an accepted order has finished");
    if (now >= deal.closedAt + REVIEW_WINDOW) throw bad("The 14 days to review this order have passed");
    const { q1, q2, again, at, signature } = body ?? {};
    const comment = String(body?.comment ?? "").trim();
    if (![q1, q2, again].every((a) => ANSWERS.has(a))) throw bad("Answer the three questions");
    if (again === 2) throw bad("Say whether you would deal with them again");
    if (comment.length > 280) throw bad("Keep the comment under 280 characters");
    if (!Number.isInteger(at) || Math.abs(at - now) > 600) throw bad("The review's time is off; check your phone's clock and try again");
    const data = reviewTypedData({ orderId: order.id, q1, q2, again, comment, at });
    let role = null;
    for (const [r, who] of [["buyer", order.buyer], ["supplier", order.supplier]]) {
      // eslint-disable-next-line no-await-in-loop
      if (await verifyTypedData({ address: who, ...data, signature }).catch(() => false)) role = r;
    }
    if (!role) throw bad("Only the buyer or the supplier of this order can review it", 403);
    const rec = this.load(order.id) ?? { orderId: order.id, buyer: null, supplier: null, closedAt: deal.closedAt, usd: order.usd.total, buyerAddress: order.buyer, supplierAddress: order.supplier };
    if (rec[role]) throw bad("You've already reviewed this order", 409);
    const about = role === "buyer" ? order.supplier : order.buyer;
    rec[role] = { by: role === "buyer" ? order.buyer : order.supplier, about, q1, q2, again, comment, at, signature };
    writeFileSync(this.file(order.id), JSON.stringify(rec, null, 1));
    return rec[role];
  }

  /**
   * A wallet's reviews, split by the role it played. Only revealed reviews count.
   * "people" counts different reviewers, so many reviews from one friend stand out.
   */
  summary(address, now) {
    const me = String(address).toLowerCase();
    const side = () => ({ count: 0, people: 0, usd: 0, q1: [0, 0], q2: [0, 0], again: [0, 0], recent: [] });
    const out = { asSupplier: side(), asBuyer: side() };
    const people = { asSupplier: new Set(), asBuyer: new Set() };
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith(".json")) continue;
      const rec = JSON.parse(readFileSync(join(this.dir, f), "utf8"));
      if (!Reviews.revealed(rec, now)) continue;
      for (const [author, key] of [["buyer", "asSupplier"], ["supplier", "asBuyer"]]) {
        const r = rec[author];
        if (!r || r.about.toLowerCase() !== me) continue;
        const s = out[key];
        s.count++;
        s.usd += Number(rec.usd);
        people[key].add(r.by.toLowerCase());
        for (const q of ["q1", "q2", "again"]) if (r[q] !== 2) (s[q][1]++, r[q] === 1 && s[q][0]++);
        s.recent.push({ orderId: rec.orderId, usd: rec.usd, at: rec.closedAt, q1: r.q1, q2: r.q2, again: r.again, comment: r.comment });
      }
    }
    for (const key of ["asSupplier", "asBuyer"]) {
      out[key].people = people[key].size;
      out[key].usd = Math.round(out[key].usd * 100) / 100;
      out[key].recent = out[key].recent.sort((a, b) => b.at - a.at).slice(0, 5);
    }
    return out;
  }
}
