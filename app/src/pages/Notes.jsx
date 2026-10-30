// Notes and evidence on an order, visible to both sides. Each note is signed by the
// poster's wallet (free, moves no money), so nobody can fake one. A proposed change to
// the terms counts as agreed once the other side taps Agree, which they also sign.
import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { signNote, shrinkPhoto } from "../chain.js";

const WORDS = {
  en: {
    title: "Notes and evidence",
    empty: "Nothing yet. Add photos of the goods, packing or receipts, or agree a change to the terms here, so there's one record both sides can point to.",
    buyer: "Buyer",
    supplier: "Supplier",
    change: "Proposed change to the terms",
    agreed: "Agreed by both sides",
    waiting: "Waiting for the other side to agree",
    agree: "Agree to this change",
    kindNote: "Note",
    kindChange: "Propose a change to the terms",
    placeholder: "What happened? Be specific: quantities, dates, what's wrong.",
    photo: "Add photo",
    post: "Sign and post",
    signing: "Confirm in your wallet (free, moves no money)…",
    signed: "Every note is signed by the poster's wallet, so nobody can change it or post as someone else.",
  },
  zh: {
    title: "备注与凭证",
    empty: "暂无内容。可在此上传货物、包装或单据照片，或协商修改条款，作为双方共同的记录。",
    buyer: "买家",
    supplier: "供应商",
    change: "提议修改条款",
    agreed: "双方已同意",
    waiting: "等待对方同意",
    agree: "同意此修改",
    kindNote: "备注",
    kindChange: "提议修改条款",
    placeholder: "发生了什么？请写明数量、日期和问题。",
    photo: "添加照片",
    post: "签名并发布",
    signing: "请在钱包中确认（免费，不会转账）…",
    signed: "每条备注都由发布者的钱包签名，任何人都无法篡改或冒名发布。",
  },
};

export default function Notes({ order, link, role, lang = "en" }) {
  const w = WORDS[lang] ?? WORDS.en;
  const [list, setList] = useState(null);
  const [text, setText] = useState("");
  const [kind, setKind] = useState("note");
  const [photo, setPhoto] = useState(null); // { base64, url }
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const party = role === "buyer" || role === "supplier";

  const load = useCallback(() => api.notes(link).then((r) => setList(r.notes)).catch(() => setList([])), [link]);
  useEffect(() => {
    load();
  }, [load]);

  async function post(body) {
    setError("");
    setBusy(w.signing);
    try {
      let photoHash;
      if (body.photo) photoHash = (await api.uploadPhoto(link, body.photo)).photo;
      const signed = await signNote(order.id, { ...body, ...(photoHash ? { photo: photoHash } : { photo: undefined }) });
      await api.addNote(link, signed);
      setText("");
      setPhoto(null);
      setKind("note");
      await load();
    } catch (e) {
      const msg = e.shortMessage ?? e.message ?? "";
      if (!/reject|denied|cancel/i.test(msg)) setError(msg);
    } finally {
      setBusy("");
    }
  }

  async function pick(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      const base64 = await shrinkPhoto(file);
      setPhoto({ base64, url: `data:image/jpeg;base64,${base64}` });
    } catch (err) {
      setError(err.message);
    }
  }

  const when = (ts) => new Date(ts * 1000).toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const shown = (list ?? []).filter((n) => n.kind !== "agree");

  return (
    <section className="stack">
      <h2>{w.title}</h2>
      {list && !shown.length ? <p className="small muted">{w.empty}</p> : null}
      {shown.length ? (
        <ol className="notes">
          {shown.map((n) => (
            <li key={n.id} className={`note-item ${n.kind === "change" ? "change" : ""}`}>
              <p className="small muted">
                <span className={`pill ${n.role === "buyer" ? "" : "act"}`}>{w[n.role]}</span> <span className="num">{when(n.at)}</span>
              </p>
              {n.kind === "change" ? <p className="small"><strong>{w.change}</strong></p> : null}
              {n.text ? <p className="note-text">{n.text}</p> : null}
              {n.photo && !/^0x0+$/.test(n.photo) ? (
                <a href={`/api/photos/${n.photo}.jpg`} target="_blank" rel="noreferrer"><img className="note-photo" src={`/api/photos/${n.photo}.jpg`} alt="" loading="lazy" /></a>
              ) : null}
              {n.kind === "change" ? (
                n.agreedBy ? (
                  <p className="small note-ok">{w.agreed}</p>
                ) : party && n.role !== role ? (
                  <button className="secondary auto small-btn" disabled={!!busy} onClick={() => post({ kind: "agree", text: "", replyTo: n.id })}>{w.agree}</button>
                ) : (
                  <p className="small muted">{w.waiting}</p>
                )
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {party ? (
        <div className="block stack">
          <div className="chips wrap" role="radiogroup">
            {[["note", w.kindNote], ["change", w.kindChange]].map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? "chip on" : "chip"} onClick={() => setKind(k)}>{label}</button>
            ))}
          </div>
          <textarea rows={3} value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} placeholder={w.placeholder} />
          {photo ? <img className="note-photo" src={photo.url} alt="" /> : null}
          <div className="row-gap">
            <label className="button secondary auto small-btn">
              {w.photo}
              <input type="file" accept="image/*" onChange={pick} style={{ display: "none" }} />
            </label>
            <button className="auto" disabled={!!busy || (!text.trim() && !photo)} onClick={() => post({ kind, text: text.trim(), photo: photo?.base64 })}>{w.post}</button>
          </div>
          <p className="small muted">{w.signed}</p>
          {busy ? <p className="note">{busy}</p> : null}
          {error ? <p className="note bad">{error}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
