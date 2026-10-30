// The supplier's side of an invite: connect the wallet you want to be paid in.
// The address goes straight to the buyer's order form, so nobody copies it by hand.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { hasWallet } from "../chain.js";
import { short } from "../App.jsx";
import { STRINGS, initialLang, saveLang } from "../i18n.js";

export default function Invite({ code, wallet }) {
  const [lang, setLang] = useState(initialLang);
  const t = STRINGS[lang].invite;
  const [inv, setInv] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.invite(code).then(setInv).catch((e) => setError(e.message));
  }, [code]);

  async function claim() {
    setError("");
    setBusy(true);
    try {
      setInv(await api.claimInvite(code, wallet.account));
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

  return (
    <div className="narrow stack-lg" lang={lang}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 26 }}>{t.title(inv.name)}</h1>
        <button className="linkish" onClick={switchLang}>{STRINGS[lang].lang}</button>
      </div>
      <p className="muted">{t.intro(short(inv.buyer))}</p>

      {inv.address ? (
        <div className={`note ${mine ? "ok" : ""}`}>
          {mine ? t.done : t.taken}
          <p className="num" style={{ marginTop: 8, wordBreak: "break-all" }}><strong>{inv.address}</strong></p>
        </div>
      ) : inv.expired ? (
        <p className="note bad">{t.expired}</p>
      ) : !wallet.account ? (
        <div className="stack">
          {hasWallet() ? <button className="money" onClick={wallet.connect}>{t.connect}</button> : <p className="note">{t.noWallet}</p>}
          {wallet.connectError ? <p className="note bad">{wallet.connectError}</p> : null}
        </div>
      ) : (
        <div className="stack">
          <p className="small">{t.confirm}</p>
          <p className="num block" style={{ wordBreak: "break-all" }}><strong>{wallet.account}</strong></p>
          <button className="money" disabled={busy} onClick={claim}>{t.use}</button>
        </div>
      )}
      {error ? <p className="note bad">{error}</p> : null}
      <ul className="small muted stack" style={{ paddingLeft: 18, margin: 0 }}>
        <li>{t.why1}</li>
        <li>{t.why2}</li>
      </ul>
    </div>
  );
}
