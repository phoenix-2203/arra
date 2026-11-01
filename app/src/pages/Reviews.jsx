// Reviews on a finished order. Buyer and supplier each answer three yes/no questions
// about the other, plus an optional comment, signed by their wallet (free, moves no
// money). Double-blind: both stay hidden until both have written, or 14 days pass.
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { signReview } from "../chain.js";

const WORDS = {
  en: {
    title: "How did it go?",
    // What the buyer is asked about the supplier, and the supplier about the buyer.
    buyer: { q1: (goods) => (goods ? "Did they ship on time?" : "Did they deliver on time?"), q2: (goods) => (goods ? "Were the goods as agreed?" : "Was the work as agreed?"), again: "Would you order from them again?", other: "the supplier", s1: (goods) => (goods ? "Shipped on time" : "Delivered on time"), s2: (goods) => (goods ? "Goods as agreed" : "Work as agreed") },
    supplier: { q1: () => "Did they pay on time?", q2: () => "Were they clear and fair to deal with?", again: "Would you sell to them again?", other: "the buyer", s1: () => "Paid on time", s2: () => "Clear and fair to deal with" },
    yes: "Yes",
    no: "No",
    comment: "Anything others should know? (optional)",
    post: "Sign and post review",
    signing: "Confirm in your wallet (free, moves no money)…",
    blind: (other, date) => `Your review stays hidden until ${other} writes theirs, or until ${date}, so nobody can answer back.`,
    sent: (other, date) => `Thanks. Your review is saved and shows when ${other} writes theirs, or on ${date}.`,
    closed: "Reviews for this order have closed.",
    byBuyer: "The buyer about the supplier",
    bySupplier: "The supplier about the buyer",
    none: "Didn't leave a review.",
    again: "Would deal again",
    signed: "Signed by their wallet",
  },
  zh: {
    title: "这笔交易怎么样？",
    buyer: { q1: (goods) => (goods ? "对方是否按时发货？" : "对方是否按时交付？"), q2: (goods) => (goods ? "货物是否符合约定？" : "工作是否符合约定？"), again: "您还会向对方下单吗？", other: "供应商", s1: (goods) => (goods ? "按时发货" : "按时交付"), s2: (goods) => (goods ? "货物符合约定" : "工作符合约定") },
    supplier: { q1: () => "对方是否按时付款？", q2: () => "对方沟通是否清楚、公平？", again: "您还会与该买家合作吗？", other: "买家", s1: () => "按时付款", s2: () => "沟通清楚、公平" },
    yes: "是",
    no: "否",
    comment: "有什么想告诉其他人的吗？（选填）",
    post: "签名并发布评价",
    signing: "请在钱包中确认（免费，不会转账）…",
    blind: (other, date) => `在${other}提交评价或 ${date} 之前，您的评价不会公开，双方都无法据此回击。`,
    sent: (other, date) => `谢谢。您的评价已保存，将在${other}提交评价后或 ${date} 公开。`,
    closed: "该订单的评价已关闭。",
    byBuyer: "买家对供应商的评价",
    bySupplier: "供应商对买家的评价",
    none: "未留下评价。",
    again: "愿意再次合作",
    signed: "由其钱包签名",
  },
};

function YesNo({ value, onChange, w, label }) {
  return (
    <div className="yn">
      <span>{label}</span>
      <div className="chips" role="radiogroup" aria-label={label}>
        {[[1, w.yes], [0, w.no]].map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={`chip${value === v ? (v ? " on" : " on no") : ""}`} onClick={() => onChange(v)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

function Shown({ r, title, qs, goods, w }) {
  if (!r) return (
    <div className="review">
      <p className="small muted"><strong>{title}</strong></p>
      <p className="small muted">{w.none}</p>
    </div>
  );
  const mark = (v) => (v === 1 ? <span className="tick">✓</span> : v === 0 ? <span className="cross">✗</span> : <span className="muted">–</span>);
  return (
    <div className="review">
      <p className="small muted"><strong>{title}</strong></p>
      <ul className="review-answers small">
        {r.q1 !== 2 ? <li>{mark(r.q1)} {qs.s1(goods)}</li> : null}
        {r.q2 !== 2 ? <li>{mark(r.q2)} {qs.s2(goods)}</li> : null}
        <li>{mark(r.again)} {w.again}</li>
      </ul>
      {r.comment ? <p className="note-text">“{r.comment}”</p> : null}
      <p className="tiny muted">{w.signed}</p>
    </div>
  );
}

export default function Reviews({ order, link, role, goods, lang = "en" }) {
  const w = WORDS[lang] ?? WORDS.en;
  const [v, setV] = useState(null);
  const [a, setA] = useState({ q1: null, q2: null, again: null });
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const party = role === "buyer" || role === "supplier";

  const load = useCallback(() => api.reviews(link).then(setV).catch(() => {}), [link]);
  useEffect(() => {
    load();
  }, [load, order.status]);

  if (!v?.eligible) return null;
  const date = new Date(v.closesAt * 1000).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-GB", { day: "numeric", month: "short" });
  const qs = party ? w[role] : null;
  // Nothing shipped: "as agreed" can't be judged, and a buyer who was refunded wasn't late to pay.
  const skipQ2 = role === "buyer" && !v.shipped;
  const skipQ1 = role === "supplier" && !v.shipped;
  const mine = party && v.submitted[role];
  const ready = (skipQ1 || a.q1 !== null) && (skipQ2 || a.q2 !== null) && a.again !== null;

  async function post() {
    setError("");
    setBusy(w.signing);
    try {
      const body = await signReview(order.id, { q1: skipQ1 ? 2 : a.q1, q2: skipQ2 ? 2 : a.q2, again: a.again, comment });
      setV(await api.addReview(link, body));
    } catch (e) {
      const msg = e.shortMessage ?? e.message ?? "";
      if (!/reject|denied|cancel/i.test(msg)) setError(msg);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="stack">
      {v.revealed ? (
        <>
          <h2>{lang === "zh" ? "评价" : "Reviews"}</h2>
          <div className="reviews">
            <Shown r={v.reviews.buyer} title={w.byBuyer} qs={w.buyer} goods={goods} w={w} />
            <Shown r={v.reviews.supplier} title={w.bySupplier} qs={w.supplier} goods={goods} w={w} />
          </div>
        </>
      ) : party && !mine && v.open ? (
        <div className="block stack review-ask">
          <h3>{w.title}</h3>
          {!skipQ1 ? <YesNo label={qs.q1(goods)} value={a.q1} onChange={(x) => setA({ ...a, q1: x })} w={w} /> : null}
          {!skipQ2 ? <YesNo label={qs.q2(goods)} value={a.q2} onChange={(x) => setA({ ...a, q2: x })} w={w} /> : null}
          <YesNo label={qs.again} value={a.again} onChange={(x) => setA({ ...a, again: x })} w={w} />
          <textarea rows={2} maxLength={280} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={w.comment} />
          <button className="money" disabled={!ready || !!busy} onClick={post}>{w.post}</button>
          <p className="small muted">{w.blind(qs.other, date)}</p>
          {busy ? <p className="note">{busy}</p> : null}
          {error ? <p className="note bad">{error}</p> : null}
        </div>
      ) : mine ? (
        <p className="note ok">{w.sent(qs.other, date)}</p>
      ) : party && !v.open ? (
        <p className="small muted">{w.closed}</p>
      ) : null}
    </section>
  );
}
