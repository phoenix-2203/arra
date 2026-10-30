// "Something's wrong": a proper problem report, learned from Alibaba Trade Assurance
// (reason, evidence, the refund you want) but settled by the vault, not a company.
// One report = hold the balance (dispute) + an offer for how to split it + a signed note
// with the reason and photo. On v4 vaults the supplier then has 7 days to accept or
// counter, or the offer goes through by itself.
import { useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { api } from "../api.js";
import { vaultCall, signNote, shrinkPhoto } from "../chain.js";
import { withToast } from "../toast.jsx";

const WORDS = {
  en: {
    title: "What's wrong?",
    reasons: { notArrived: "Not arrived", wrongItem: "Wrong item", short: "Short quantity", damaged: "Damaged", quality: "Poor quality", other: "Something else" },
    details: "Describe it: what you ordered, what you got, how many.",
    photo: "Add a photo",
    refund: "How much of the balance should come back to you?",
    keep: (s, b) => `$${s} to the supplier, $${b} back to you`,
    v4: "The supplier gets 7 days to accept this or offer something else. If they ignore it, it goes through as you asked.",
    legacy: "The balance stays locked until you both agree. The supplier can accept your offer or counter it.",
    submit: "Hold the balance and send this",
    steps: "Your wallet will ask you to confirm 2 transactions and 1 free signature.",
    cancel: "Cancel",
    toast: { confirm: "Confirm in your wallet", pending: "Sending to Celo…", hold: "Balance held", offer: "Your offer was sent" },
  },
  zh: {
    title: "出了什么问题？",
    reasons: { notArrived: "未到货", wrongItem: "货不对", short: "数量不足", damaged: "货物损坏", quality: "质量差", other: "其他" },
    details: "请描述：订购了什么、收到了什么、数量多少。",
    photo: "添加照片",
    refund: "希望退回多少尾款？",
    keep: (s, b) => `付给供应商 $${s}，退回您 $${b}`,
    v4: "供应商有 7 天时间接受或提出其他方案。如未回应，将按您的要求执行。",
    legacy: "尾款将保持锁定，直到双方同意。供应商可以接受或还价。",
    submit: "冻结尾款并发送",
    steps: "钱包会请您确认 2 笔交易和 1 次免费签名。",
    cancel: "取消",
    toast: { confirm: "请在钱包中确认", pending: "正在发送到 Celo…", hold: "尾款已冻结", offer: "已发送您的方案" },
  },
};

export default function Problem({ order, link, preset, lang = "en", onDone, onCancel }) {
  const w = WORDS[lang] ?? WORDS.en;
  const held = BigInt(order.held);
  const [reason, setReason] = useState(preset ?? "");
  const [details, setDetails] = useState("");
  const [photo, setPhoto] = useState(null);
  const [refundPct, setRefundPct] = useState(preset === "notArrived" ? 100 : 30);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const refund = (held * BigInt(refundPct)) / 100n;
  const money = (v) => Number(formatUnits(v, 6)).toFixed(2);

  async function submit() {
    setError("");
    setBusy(true);
    const id = BigInt(order.id);
    try {
      if (order.status === "Shipped") {
        await withToast((cb) => vaultCall("dispute", [id], cb, order.vault), { confirm: w.toast.confirm, pending: w.toast.pending, done: w.toast.hold });
      }
      await withToast((cb) => vaultCall("proposeSplit", [id, held - refund], cb, order.vault), { confirm: w.toast.confirm, pending: w.toast.pending, done: w.toast.offer });
      // The reason and evidence, signed, so it can't be changed later (best effort: the money steps are done).
      try {
        const photoHash = photo ? (await api.uploadPhoto(link, photo)).photo : undefined;
        const said = details.trim();
        const text = `Problem: ${WORDS.en.reasons[reason]}. ${said}${said && !/[.!?]$/.test(said) ? "." : ""} Asking for $${money(refund)} of the $${money(held)} balance back.`.replace(/\s+/g, " ").trim();
        await api.addNote(link, await signNote(order.id, { kind: "note", text, ...(photoHash ? { photo: photoHash } : {}) }));
      } catch {
        /* the note is extra; the hold and offer already went through */
      }
      onDone?.();
    } catch (e) {
      const msg = e.shortMessage ?? e.message ?? "";
      if (!/reject|denied|cancel/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  }

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setPhoto(await shrinkPhoto(file));
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="block stack urgent">
      <h3>{w.title}</h3>
      <div className="chips wrap" role="radiogroup">
        {Object.entries(w.reasons).map(([k, label]) => (
          <button key={k} type="button" role="radio" aria-checked={reason === k} className={reason === k ? "chip on" : "chip"} onClick={() => setReason(k)}>{label}</button>
        ))}
      </div>
      <textarea rows={3} maxLength={600} value={details} onChange={(e) => setDetails(e.target.value)} placeholder={w.details} />
      <div className="row-gap">
        <label className="button secondary auto small-btn">
          {w.photo}
          <input type="file" accept="image/*" onChange={pick} style={{ display: "none" }} />
        </label>
        {photo ? <img className="note-photo" style={{ maxHeight: 80 }} src={`data:image/jpeg;base64,${photo}`} alt="" /> : null}
      </div>
      <label className="field">
        <span>{w.refund}</span>
        <input type="range" min="0" max="100" step="5" value={refundPct} onChange={(e) => setRefundPct(Number(e.target.value))} />
        <small className="num">{w.keep(money(held - refund), money(refund))}</small>
      </label>
      <p className="small muted">{order.v4 ? w.v4 : w.legacy} {w.steps}</p>
      {error ? <p className="note bad">{error}</p> : null}
      <div className="row">
        <button className="secondary" disabled={busy} onClick={onCancel}>{w.cancel}</button>
        <button className="danger" disabled={busy || !reason} onClick={submit}>{w.submit}</button>
      </div>
    </div>
  );
}
