// "Check a supplier": before writing an order, paste the page you found them on (and
// their wallet, if you have it). One verdict, the reasons, the posts behind it, then
// one tap to start an order with them, carrying the check along.
import { useState } from "react";
import { api } from "../api.js";
import { navigate } from "../App.jsx";
import Icon from "../Icon.jsx";
import { PLATFORMS, VerifyResult, readHandle } from "./SupplierVerify.jsx";

const looksLikeWallet = (s) => /^0x[0-9a-fA-F]{40}$/.test(s.trim());

export default function Check() {
  const params = new URLSearchParams(location.search);
  const [platform, setPlatform] = useState(params.get("platform") ?? "instagram");
  const [handle, setHandle] = useState(params.get("handle") ?? "");
  const [wallet, setWallet] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState(null);
  const [error, setError] = useState("");

  async function run(e) {
    e?.preventDefault();
    setError("");
    setR(null);
    setBusy(true);
    try {
      // A wallet pasted into the main box works too.
      const asWallet = looksLikeWallet(handle);
      const h = asWallet ? null : readHandle(handle, platform);
      setR(await api.verify({ platform: h?.platform, handle: h?.handle, address: asWallet ? handle.trim() : looksLikeWallet(wallet) ? wallet.trim() : undefined }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  function startOrder() {
    const q = new URLSearchParams();
    if (r.handle) (q.set("check", `${r.platform}:${r.handle}`));
    const name = r.profile?.summary?.name ?? r.name;
    if (name) q.set("supplier", name);
    navigate(`/new?${q}`);
  }

  return (
    <div className="narrow stack-lg">
      <div className="stack">
        <p className="eyebrow"><Icon name="shield" size={16} /> Before you pay anyone</p>
        <h1>Check a supplier</h1>
        <p className="muted">Paste the Instagram, TikTok or X page you found them on. Arra's agent reads it, searches X and Reddit for complaints, and tells you plainly what it found. Free for you.</p>
      </div>

      <form className="block stack" onSubmit={run}>
        <div className="chips wrap" role="radiogroup" aria-label="Where they sell">
          {PLATFORMS.map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={platform === k} className={platform === k ? "chip on" : "chip"} onClick={() => setPlatform(k)}>{label}</button>
          ))}
        </div>
        <label className="field">
          <span>Their page</span>
          <input value={handle} onChange={(e) => { setHandle(e.target.value); const x = readHandle(e.target.value, platform); if (x.platform !== platform) setPlatform(x.platform); }} placeholder="@phoenix.store or instagram.com/phoenix.store" autoCapitalize="off" spellCheck="false" autoFocus />
        </label>
        <details className="more plain">
          <summary>Have their wallet address? (optional)</summary>
          <label className="field">
            <span>Their wallet on Celo</span>
            <input value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x…" className="num" autoCapitalize="off" spellCheck="false" />
            <small>Adds their record and reviews on Arra, and checks that this wallet really belongs to the page.</small>
          </label>
        </details>
        <button className="money" disabled={busy || !handle.trim()}>{busy ? "Checking… (about 10 seconds)" : "Check"}</button>
        {error ? <p className="note bad">{error}</p> : null}
      </form>

      {r ? (
        <div className="stack">
          <VerifyResult r={r} />
          <button className={r.verdict.level === "risk" ? "secondary" : "money"} onClick={startOrder}>
            {r.verdict.level === "risk" ? "Start an order anyway (money stays locked)" : "Start an order with them"} <Icon name="arrow" size={18} />
          </button>
          <p className="small muted">Every Arra order keeps the balance locked until they ship, and refunds you automatically if they don't.</p>
        </div>
      ) : null}
    </div>
  );
}
