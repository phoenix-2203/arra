// "Check their public profile": Arra's agent pays a fraction of a cent (over x402, through
// buy on Celo) to read the supplier's Instagram, TikTok or X page, and shows what a careful
// buyer would look for before sending money to a stranger.
import { useState } from "react";
import { api } from "../api.js";
import { EXPLORER } from "../chain.js";

const PLATFORMS = [["instagram", "Instagram"], ["tiktok", "TikTok"], ["x", "X"]];
const n = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US"));
const ago = (t) => {
  if (!t) return null;
  const d = Math.floor((Date.now() / 1000 - t) / 86400);
  return d < 1 ? "today" : d < 60 ? `${d} day${d > 1 ? "s" : ""} ago` : `${Math.floor(d / 30)} months ago`;
};

export default function SupplierCheck({ payee = "supplier" }) {
  const [platform, setPlatform] = useState("instagram");
  const [handle, setHandle] = useState("");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState(null);
  const [error, setError] = useState("");

  async function check() {
    setError("");
    setBusy(true);
    try {
      setR(await api.supplierCheck(platform, handle));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const s = r?.summary;
  return (
    <details className="more sup-check">
      <summary>Check their public profile (free for you)</summary>
      <div className="stack">
        <p className="small muted">Found this {payee} on Instagram, TikTok or X? Arra's agent reads their public page and tells you what to look out for, before any money moves.</p>
        <div className="chips wrap" role="radiogroup" aria-label="Where they sell">
          {PLATFORMS.map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={platform === k} className={platform === k ? "chip on" : "chip"} onClick={() => { setPlatform(k); setR(null); }}>{label}</button>
          ))}
        </div>
        <div className="with-btn">
          <input value={handle} onChange={(e) => { setHandle(e.target.value); setR(null); }} placeholder="@username or profile link" autoCapitalize="off" spellCheck="false" />
          <button type="button" className="secondary small-btn" disabled={busy || !handle.trim()} onClick={check}>{busy ? "Checking…" : "Check"}</button>
        </div>
        {error ? <p className="note bad">{error}</p> : null}
        {r ? (
          <div className={`block stack ${r.flags.length ? "urgent" : ""}`}>
            {r.found ? (
              <>
                <p><strong>{s.name ?? `@${r.handle}`}</strong> <a href={r.url} target="_blank" rel="noreferrer" className="small">@{r.handle} on {r.label}</a>{s.verified ? <span className="pill act" style={{ marginLeft: 8 }}>Verified</span> : null}</p>
                <dl className="sup-facts num">
                  <div><dt>Followers</dt><dd>{n(s.followers)}</dd></div>
                  <div><dt>Posts</dt><dd>{n(s.posts)}</dd></div>
                  {s.lastPostAt ? <div><dt>Last post</dt><dd>{ago(s.lastPostAt)}</dd></div> : null}
                  {s.createdAt ? <div><dt>Joined</dt><dd>{new Date(s.createdAt * 1000).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</dd></div> : null}
                </dl>
                {s.bio ? <p className="small muted">"{s.bio}"</p> : null}
              </>
            ) : null}
            {r.flags.length ? (
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{r.flags.map((f) => <li key={f}>{f}</li>)}</ul>
            ) : <p className="small note-ok">Nothing unusual on their public page. Still check the terms and confirm their wallet on a call.</p>}
            <p className="small muted">A public page can be faked, so this is one signal, not a guarantee; the locked money and the refund rules are what protect you. {r.paid?.txHash ? <>Checked by Arra's agent, paid over x402 on Celo: <a href={`${EXPLORER}/tx/${r.paid.txHash}`} target="_blank" rel="noreferrer">receipt</a>.</> : r.cached ? "Checked earlier today." : null}</p>
          </div>
        ) : null}
      </div>
    </details>
  );
}
