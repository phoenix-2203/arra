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
  },
  zh: {
    newSupplier: "Arra 新用户：该钱包尚未完成订单。首次合作可考虑降低定金比例。",
    supplier: (r, since) => `自 ${since} 起使用 Arra：已付款 ${r.paid} 单，未按时发货 ${r.refundedUnshipped} 单，被提出问题 ${r.disputed} 单。`,
    warnSupplier: "该钱包曾收取定金但未发货，请谨慎设置定金。",
    newBuyer: "该买家首次在 Arra 下单。",
    buyer: (r, since) => `该买家自 ${since} 起使用 Arra：共 ${r.orders} 单，已付款 ${r.paid} 单，提出问题 ${r.disputesRaised} 次。`,
  },
};

export default function TrackRecord({ address, as, lang = "en" }) {
  const [rec, setRec] = useState(null);
  useEffect(() => {
    setRec(null);
    if (!address) return;
    api.record(address).then(setRec).catch(() => {});
  }, [address]);
  if (!rec) return null;
  const w = WORDS[lang] ?? WORDS.en;
  if (as === "supplier") {
    const r = rec.asSupplier;
    if (!r.accepted) return <p className="note">{w.newSupplier}</p>;
    return (
      <p className={`note ${r.refundedUnshipped ? "bad" : "ok"}`}>
        {w.supplier(r, month(r.firstAt, lang))}
        {r.refundedUnshipped ? ` ${w.warnSupplier}` : ""}
      </p>
    );
  }
  const r = rec.asBuyer;
  if (!r.orders || r.orders <= 1) return <p className="small muted">{w.newBuyer}</p>;
  return <p className="small muted">{w.buyer(r, month(r.firstAt, lang))}</p>;
}
