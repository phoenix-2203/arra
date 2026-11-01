// A wallet's track record on Arra, read from the vaults' public history.
// The buyer sees the supplier's record before locking money; the supplier sees
// the buyer's before accepting.
import { useEffect, useState } from "react";
import { api } from "./api.js";

const month = (ts, lang) => new Date(ts * 1000).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-GB", { month: "short", year: "numeric" });

const WORDS = {
  en: {
    newSupplier: "New on Arra: this wallet hasn't completed an order yet. For a first order, consider a smaller deposit.",
    supplier: (r, since) =>
      `On Arra since ${since}: ${r.paid} order${r.paid === 1 ? "" : "s"} paid out, ${r.refundedUnshipped} not shipped in time, ${r.disputed} with a problem raised.`,
    warnSupplier: "This wallet has kept a deposit without shipping before. Be careful with the deposit size.",
    newBuyer: "First order from this buyer on Arra.",
    buyer: (r, since) => `This buyer on Arra since ${since}: ${r.orders} order${r.orders === 1 ? "" : "s"}, ${r.paid} paid out, ${r.disputesRaised} problem${r.disputesRaised === 1 ? "" : "s"} raised.`,
    reviews: (n, people, who) => `${n} review${n === 1 ? "" : "s"} from ${people} ${who}${people === 1 ? "" : "s"}`,
    buyerWord: "buyer",
    supplierWord: "supplier",
    sQ1: "on time",
    sQ2: "as agreed",
    bQ1: "paid on time",
    bQ2: "fair to deal with",
    again: "would deal again",
    of: (a, b) => `${a} of ${b}`,
    read: "Read reviews",
    order: (usd) => `$${usd} order`,
    proof: "Only people who completed a real order with this wallet can review it, and each review is signed by their wallet.",
  },
  zh: {
    newSupplier: "Arra 新用户：该钱包尚未完成订单。首次合作可考虑降低定金比例。",
    supplier: (r, since) => `自 ${since} 起使用 Arra：已付款 ${r.paid} 单，未按时发货 ${r.refundedUnshipped} 单，被提出问题 ${r.disputed} 单。`,
    warnSupplier: "该钱包曾收取定金但未发货，请谨慎设置定金。",
    newBuyer: "该买家首次在 Arra 下单。",
    buyer: (r, since) => `该买家自 ${since} 起使用 Arra：共 ${r.orders} 单，已付款 ${r.paid} 单，提出问题 ${r.disputesRaised} 次。`,
    reviews: (n, people, who) => `${n} 条评价，来自 ${people} 位${who}`,
    buyerWord: "买家",
    supplierWord: "供应商",
    sQ1: "按时",
    sQ2: "符合约定",
    bQ1: "按时付款",
    bQ2: "沟通公平",
    again: "愿意再次合作",
    of: (a, b) => `${a}/${b}`,
    read: "查看评价",
    order: (usd) => `$${usd} 订单`,
    proof: "只有与该钱包完成真实订单的人才能评价，且每条评价都由其钱包签名。",
  },
};

/** Reviews from people who completed real orders with this wallet, folded under one line. */
function ReviewLine({ s, as, w, lang }) {
  if (!s?.count) return null;
  const pair = ([yes, all], label) => (all ? `${w.of(yes, all)} ${label}` : null);
  const parts = as === "supplier" ? [pair(s.q1, w.sQ1), pair(s.q2, w.sQ2), pair(s.again, w.again)] : [pair(s.q1, w.bQ1), pair(s.q2, w.bQ2), pair(s.again, w.again)];
  const bad = s.again[1] && s.again[0] / s.again[1] < 0.75;
  return (
    <details className={`more rv-line${bad ? " bad" : ""}`}>
      <summary>
        <strong>{w.reviews(s.count, s.people, as === "supplier" ? w.buyerWord : w.supplierWord)}</strong>
        <span className="muted"> · {parts.filter(Boolean).join(" · ")}</span>
      </summary>
      <ul className="rv-list">
        {s.recent.map((r) => (
          <li key={r.orderId}>
            <span className="tiny muted num">{w.order(r.usd)} · {month(r.at, lang)}</span>
            <span className={r.again ? "tick" : "cross"}>{r.again ? "✓" : "✗"}</span> {r.comment ? `“${r.comment}”` : <span className="muted">{w.again}: {r.again ? "✓" : "✗"}</span>}
          </li>
        ))}
      </ul>
      <p className="tiny muted">{w.proof}</p>
    </details>
  );
}

export default function TrackRecord({ address, as, lang = "en" }) {
  const [rec, setRec] = useState(null);
  const [rv, setRv] = useState(null);
  useEffect(() => {
    setRec(null);
    setRv(null);
    if (!address) return;
    let live = true;
    api.record(address).then((r) => live && setRec(r)).catch(() => {});
    api.reviewSummary(address).then((r) => live && setRv(r)).catch(() => {});
    return () => {
      live = false;
    };
  }, [address]);
  if (!rec) return null;
  const w = WORDS[lang] ?? WORDS.en;
  if (as === "supplier") {
    const r = rec.asSupplier;
    return (
      <div className="stack-sm">
        {!r.accepted ? (
          <p className="note">{w.newSupplier}</p>
        ) : (
          <p className={`note ${r.refundedUnshipped ? "bad" : "ok"}`}>
            {w.supplier(r, month(r.firstAt, lang))}
            {r.refundedUnshipped ? ` ${w.warnSupplier}` : ""}
          </p>
        )}
        <ReviewLine s={rv?.asSupplier} as="supplier" w={w} lang={lang} />
      </div>
    );
  }
  const r = rec.asBuyer;
  return (
    <div className="stack-sm">
      <p className="small muted">{!r.orders || r.orders <= 1 ? w.newBuyer : w.buyer(r, month(r.firstAt, lang))}</p>
      <ReviewLine s={rv?.asBuyer} as="buyer" w={w} lang={lang} />
    </div>
  );
}
