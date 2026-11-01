// Checking a supplier: one verdict ("Looks established", "Be careful", "High risk") with
// the plain reasons behind it. Arra's agent reads the supplier's public page and searches
// X and Reddit for complaints (paid over x402 through buy on Celo, free for the buyer),
// then adds what Arra itself knows: who confirmed the page, the wallet's record, reviews.
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { EXPLORER } from "../chain.js";

export const PLATFORMS = [["instagram", "Instagram"], ["tiktok", "TikTok"], ["x", "X"]];
const LEVEL = {
  risk: { title: "High risk", sub: "Don't pay until this is cleared up." },
  careful: { title: "Be careful", sub: "Some warning signs. Read them before you pay." },
  good: { title: "Looks established", sub: "Nothing wrong found." },
  unknown: { title: "Not much to go on", sub: "Too little public information to judge." },
};
const MARK = { bad: "✗", warn: "!", good: "✓", info: "·" };
const n = (v) => (v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US"));
const ago = (t) => {
  if (!t) return null;
  const d = Math.floor((Date.now() / 1000 - t) / 86400);
  return d < 1 ? "today" : d < 60 ? `${d} day${d > 1 ? "s" : ""} ago` : d < 730 ? `${Math.floor(d / 30)} months ago` : `${Math.floor(d / 365)} years ago`;
};

/** "instagram.com/phoenix.store" → { platform: "instagram", handle: "phoenix.store" }. */
export function readHandle(raw, fallback) {
  const s = String(raw ?? "").trim();
  const m = s.match(/(instagram\.com|tiktok\.com|x\.com|twitter\.com)\/@?([A-Za-z0-9._]{1,40})/i);
  if (m) return { platform: /instagram/i.test(m[1]) ? "instagram" : /tiktok/i.test(m[1]) ? "tiktok" : "x", handle: m[2] };
  return { platform: fallback, handle: s.replace(/^@/, "") };
}

/**
 * Runs a check in two halves at once: their page (a few seconds) and the complaint search
 * (slower). The first answer shows straight away; the full verdict replaces it when the
 * search is done (that last call is answered from the server's cache).
 */
export async function verifyFast(base, onUpdate) {
  if (!base.handle) return onUpdate(await api.verify(base));
  const page = api.verify({ ...base, parts: ["profile"] });
  const search = api.verify({ ...base, parts: ["complaints"] }).catch(() => null);
  const first = await page;
  onUpdate({ ...first, searching: true });
  await search;
  onUpdate(await api.verify(base).catch(() => ({ ...first, searching: false })));
}

export function VerifyResult({ r, compactFacts = false }) {
  const v = r.verdict;
  const L = LEVEL[v.level];
  const p = r.profile && !r.profile.error && r.profile.found ? r.profile : null;
  const s = p?.summary;
  const posts = r.complaints && !r.complaints.error ? r.complaints.complaints : [];
  const paid = [r.profile?.paid, ...(r.complaints?.paid ?? [])].filter((x) => x?.txHash);
  const cost = paid.reduce((t, x) => t + Number(x.amount), 0) / 1e6;
  return (
    <div className={`verdict v-${v.level}`}>
      <div className="v-head">
        <span className="v-badge" aria-hidden="true">{v.level === "good" ? "✓" : v.level === "unknown" ? "?" : "!"}</span>
        <div>
          <p className="v-title">{L.title}</p>
          <p className="small">{L.sub}</p>
        </div>
      </div>
      {p ? (
        <div className="v-page">
          <p>
            <strong>{s.name ?? `@${p.handle}`}</strong>{" "}
            <a href={p.url} target="_blank" rel="noreferrer" className="small">@{p.handle} on {p.label}</a>
            {s.verified ? <span className="pill act" style={{ marginLeft: 8 }}>Verified</span> : null}
            {r.proof && r.proof.handle === p.handle && (!r.payTo || r.proof.address === r.payTo) ? <span className="pill ok-pill" style={{ marginLeft: 8 }}>Page confirmed</span> : null}
          </p>
          {!compactFacts ? (
            <dl className="sup-facts num">
              <div><dt>Followers</dt><dd>{n(s.followers)}</dd></div>
              <div><dt>Posts</dt><dd>{n(s.posts)}</dd></div>
              {s.lastPostAt ? <div><dt>Last post</dt><dd>{ago(s.lastPostAt)}</dd></div> : null}
              {s.createdAt ? <div><dt>Joined</dt><dd>{new Date(s.createdAt * 1000).toLocaleDateString("en-GB", { month: "short", year: "numeric" })}</dd></div> : null}
            </dl>
          ) : null}
        </div>
      ) : null}
      <ul className="v-reasons">
        {v.reasons.map((x) => (
          <li key={x.text} className={`t-${x.tone}`}><span aria-hidden="true">{MARK[x.tone]}</span>{x.text}</li>
        ))}
      </ul>
      {posts.length ? (
        <div className="v-posts">
          <p className="small"><strong>What people posted</strong></p>
          <ul>
            {posts.map((q) => (
              <li key={q.text}>
                <p className="small">“{q.text}”</p>
                <p className="tiny muted">
                  {q.source === "x" ? "X" : "Reddit"}{q.author ? ` · ${q.author}` : ""}{q.at ? ` · ${ago(q.at)}` : ""}
                  {q.url ? <> · <a href={q.url} target="_blank" rel="noreferrer">open</a></> : null}
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {r.searching ? <p className="small muted searching"><span className="pulse" aria-hidden="true" /> Searching X and Reddit for complaints…</p> : null}
      {r.profile?.error || r.complaints?.error ? <p className="tiny muted">Part of the check couldn't run just now: {r.profile?.error ?? r.complaints?.error}</p> : null}
      <p className="tiny muted">
        This lowers the risk; it can't prove a seller is honest. Your balance stays locked until they ship either way.
        {paid.length ? <> Checked by Arra's agent for ${cost.toFixed(3)}, paid over x402 on Celo: {paid.map((x, i) => <a key={x.txHash} href={`${EXPLORER}/tx/${x.txHash}`} target="_blank" rel="noreferrer">{i ? ", " : ""}receipt {i + 1}</a>)}.</> : r.profile?.cached ? " Checked earlier today." : null}
      </p>
    </div>
  );
}

/** The check inside a new order: one quiet line until it's needed. */
export default function SupplierVerify({ payTo = "", name = "", payee = "supplier", initial = null }) {
  const [open, setOpen] = useState(false);
  const [platform, setPlatform] = useState(initial?.platform ?? "instagram");
  const [handle, setHandle] = useState(initial?.handle ?? "");
  const [busy, setBusy] = useState(false);
  const [r, setR] = useState(null);
  const [error, setError] = useState("");
  const auto = useRef("");

  async function run(pf = platform, h = handle) {
    setError("");
    setBusy(true);
    try {
      await verifyFast({ platform: pf, handle: h, name, address: payTo || undefined }, (x) => {
        setR(x);
        setBusy(false);
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  // Run by itself when we already know the page: from "Check a supplier", or because
  // the supplier confirmed their page for the wallet that's about to be paid.
  useEffect(() => {
    const key = `${payTo}:${initial?.handle ?? ""}`;
    if (auto.current === key) return;
    auto.current = key;
    if (initial?.handle) {
      run(initial.platform, initial.handle);
      return;
    }
    if (!payTo) return;
    api.pageProofs(payTo).then(({ proofs }) => {
      if (proofs[0]) {
        setPlatform(proofs[0].platform);
        setHandle(proofs[0].handle);
        run(proofs[0].platform, proofs[0].handle);
      }
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payTo, initial?.handle]);

  const v = r?.verdict;
  const one = v?.reasons.find((x) => x.tone === "bad") ?? v?.reasons.find((x) => x.tone === "warn") ?? v?.reasons[0];
  if (busy) {
    return (
      <div className="v-line" aria-live="polite">
        <span className="pulse" aria-hidden="true" />
        <span>Checking {handle ? `@${readHandle(handle, platform).handle}` : `the ${payee}`}: reading their page and searching for complaints…</span>
        <span />
      </div>
    );
  }
  // High risk opens by itself; anything else stays one quiet line until tapped.
  if (r && !open && v.level !== "risk") {
    return (
      <button type="button" className={`v-line v-${v.level}`} onClick={() => setOpen(true)}>
        <span className="v-dot" aria-hidden="true" />
        <span><strong>{LEVEL[v.level].title}</strong>{r.handle ? ` · @${r.handle}` : ""}{one ? <span className="muted"> · {one.text}</span> : null}</span>
        <span className="v-more">Details</span>
      </button>
    );
  }
  if (r) {
    return (
      <div className="stack">
        <VerifyResult r={r} />
        <div className="row-gap">
          {v.level !== "risk" ? <button type="button" className="linkish" onClick={() => setOpen(false)}>Hide details</button> : null}
          <button type="button" className="linkish" onClick={() => { setR(null); setOpen(true); }}>Check a different page</button>
        </div>
      </div>
    );
  }
  return (
    <details className="more sup-check" open={open || !!error} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{`Check this ${payee} (free for you)`}</summary>
      <div className="stack">
        <p className="small muted">Found them on Instagram, TikTok or X? Arra's agent reads their page and searches for public complaints, before any money moves.</p>
        <div className="chips wrap" role="radiogroup" aria-label="Where they sell">
          {PLATFORMS.map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={platform === k} className={platform === k ? "chip on" : "chip"} onClick={() => setPlatform(k)}>{label}</button>
          ))}
        </div>
        <div className="with-btn">
          <input value={handle} onChange={(e) => { const x = readHandle(e.target.value, platform); setPlatform(x.platform); setHandle(e.target.value); }} placeholder="@username or profile link" autoCapitalize="off" spellCheck="false" />
          <button type="button" className="secondary small-btn" disabled={!handle.trim()} onClick={() => { setOpen(false); run(platform, readHandle(handle, platform).handle); }}>Check</button>
        </div>
        {error ? <p className="note bad">{error}</p> : null}
      </div>
    </details>
  );
}
