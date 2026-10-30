// The supplier's side of an invite. Like Escrow.com and Alibaba Trade Assurance, both
// sides agree the terms before any money moves: the supplier reads the buyer's draft
// order, connects the wallet they want to be paid in, and taps Agree or suggests a
// change. The wallet address goes straight to the buyer, so nobody copies it by hand.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { hasWallet } from "../chain.js";
import { short } from "../App.jsx";
import { STRINGS, initialLang, saveLang } from "../i18n.js";

const FIELDS = ["product", "quantity", "unitPriceUsd", "specs", "packaging", "inspection", "shipBy", "incoterm"];

export default function Invite({ code, wallet }) {
  const [lang, setLang] = useState(initialLang);
  const S = STRINGS[lang];
  const t = S.invite;
  const [inv, setInv] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [text, setText] = useState("");

  // Keep up with the buyer: the draft may arrive or change while this page is open.
  useEffect(() => {
    const load = () => api.invite(code).then(setInv).catch((e) => setError(e.message));
    load();
    const t2 = setInterval(load, 5000);
    return () => clearInterval(t2);
  }, [code]);

  async function act(fn) {
    setError("");
    setBusy(true);
    try {
      setInv(await fn());
      setSuggesting(false);
      setText("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const switchLang = () => {
    const next = lang === "en" ? "zh" : "en";
    setLang(next);
    saveLang(next);
  };

  if (error && !inv) return <p className="note bad">{error}</p>;
  if (!inv) return <p className="muted">…</p>;
  const mine = inv.address && wallet.account && inv.address.toLowerCase() === wallet.account.toLowerCase();
  const takenByOther = inv.address && wallet.account && !mine;
  const d = inv.draft;
  const total = d ? (Number(d.quantity) * Number(d.unitPriceUsd)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : null;
  const agreed = inv.agreedRef && inv.agreedRef === inv.draftRef;

  return (
    <div className="narrow stack-lg" lang={lang}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 26 }}>{t.title(inv.name)}</h1>
        <button className="linkish" onClick={switchLang}>{S.lang}</button>
      </div>
      <p className="muted">{t.intro(short(inv.buyer))}</p>

      <ol className="mini-steps">
        <li className="done">{t.s1}</li>
        <li className={agreed ? "done" : "on"}>{t.s2}</li>
        <li>{t.s3}</li>
        <li>{t.s4}</li>
      </ol>

      {d ? (
        <section className="stack">
          <h2>{t.terms}</h2>
          <dl className="terms block">
            {FIELDS.filter((k) => d[k] !== undefined && d[k] !== "").map((k) => (
              <div key={k}>
                <dt>{S.fields[k]}</dt>
                <dd>{Array.isArray(d[k]) ? <ul>{d[k].map((x) => <li key={x}>{x}</li>)}</ul> : k === "quantity" ? `${d.quantity} ${d.unit}` : d[k]}</dd>
              </div>
            ))}
            <div><dt>{t.total}</dt><dd className="num"><strong>${total}</strong></dd></div>
          </dl>
        </section>
      ) : (
        <p className="note">{t.noDraft}</p>
      )}

      {takenByOther ? <p className="note bad">{t.taken}</p> : null}
      {inv.expired ? <p className="note bad">{t.expired}</p> : null}

      {agreed && mine ? (
        <div className="note ok">
          {t.agreedDone}
          <p className="num" style={{ marginTop: 8, wordBreak: "break-all" }}><strong>{inv.address}</strong></p>
        </div>
      ) : inv.changeRequest && mine && !agreed ? (
        <p className="note">{t.suggested(inv.changeRequest.text)}</p>
      ) : null}

      {!takenByOther && !inv.expired && !(agreed && mine) ? (
        !wallet.account ? (
          <div className="stack">
            {hasWallet() ? <button className="money" onClick={wallet.connect}>{t.connect}</button> : <p className="note">{t.noWallet}</p>}
            {wallet.connectError ? <p className="note bad">{wallet.connectError}</p> : null}
          </div>
        ) : (
          <div className="stack">
            <p className="small">{t.confirm}</p>
            <p className="num block" style={{ wordBreak: "break-all" }}><strong>{wallet.account}</strong></p>
            {d ? (
              <>
                <button className="money" disabled={busy} onClick={() => act(() => api.agreeInvite(code, wallet.account, inv.draftRef))}>{t.agree}</button>
                {suggesting ? (
                  <div className="stack">
                    <textarea rows={3} value={text} maxLength={600} onChange={(e) => setText(e.target.value)} placeholder={t.suggestPh} />
                    <button className="secondary" disabled={busy || !text.trim()} onClick={() => act(() => api.suggestInvite(code, wallet.account, text))}>{t.send}</button>
                  </div>
                ) : (
                  <button className="secondary" disabled={busy} onClick={() => setSuggesting(true)}>{t.suggest}</button>
                )}
              </>
            ) : !mine ? (
              <button className="money" disabled={busy} onClick={() => act(() => api.claimInvite(code, wallet.account))}>{t.use}</button>
            ) : (
              <p className="note ok">{t.done}</p>
            )}
          </div>
        )
      ) : null}
      {error ? <p className="note bad">{error}</p> : null}
      <ul className="small muted stack" style={{ paddingLeft: 18, margin: 0 }}>
        <li>{t.why1}</li>
        <li>{t.why2}</li>
      </ul>
    </div>
  );
}
