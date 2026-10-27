import { useCallback, useEffect, useState } from "react";
import { formatUnits, keccak256, toBytes } from "viem";
import { api } from "../api.js";
import { vaultCall, toUnits, EXPLORER } from "../chain.js";
import { Cloth } from "../Adire.jsx";
import { STRINGS, initialLang, saveLang } from "../i18n.js";
import { short } from "../App.jsx";

const usd = (v) => Number(formatUnits(BigInt(v), 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (ts, lang) => new Date(ts * 1000).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
const STEP_OF = { Pending: 1, Active: 2, Shipped: 3, Disputed: 3, Released: 4, Settled: 4, Refunded: 0 };

export default function Order({ id, wallet }) {
  const { account } = wallet;
  const [lang, setLang] = useState(initialLang);
  const t = STRINGS[lang];
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [lastTx, setLastTx] = useState("");
  const [partAmount, setPartAmount] = useState("");
  const [container, setContainer] = useState("");
  const [containerCheck, setContainerCheck] = useState(null);
  const [splitPct, setSplitPct] = useState(50);
  const [copied, setCopied] = useState(false);
  const isNew = new URLSearchParams(location.search).has("new");

  const load = useCallback(() => {
    api.order(id, account).then(setView).catch((e) => setError(e.status === 404 ? t.notFound : e.message));
  }, [id, account, t.notFound]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (!container) return setContainerCheck(null);
    const timer = setTimeout(() => api.checkContainer(container).then(setContainerCheck).catch(() => {}), 300);
    return () => clearTimeout(timer);
  }, [container]);

  const switchLang = () => {
    const next = lang === "en" ? "zh" : "en";
    setLang(next);
    saveLang(next);
  };

  if (error && !view) return <p className="note bad">{error}</p>;
  if (!view) return <p className="muted">{t.loading}</p>;

  const { order: o, sheet, role, actions, now } = view;
  const s = sheet?.sheet;
  const held = BigInt(o.held);
  const final = ["Released", "Refunded", "Settled"].includes(o.status);
  const step = STEP_OF[o.status];
  const toSupplierSplit = (held * BigInt(splitPct)) / 100n;

  async function run(name, args) {
    setError("");
    setBusy(t.working);
    try {
      setLastTx(await vaultCall(name, args));
      setPartAmount("");
      setContainer("");
      load();
    } catch (e) {
      setError(e.shortMessage ?? e.message);
    } finally {
      setBusy("");
    }
  }

  const A = t.actions;
  const bid = BigInt(o.id);
  const has = (a) => actions.includes(a);
  const shareUrl = `${location.origin}/o/${o.id}?lang=zh`;

  return (
    <div className="stack-lg" lang={lang}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 24 }}>#{o.id} {s?.product ?? ""}</h1>
        <button className="linkish" onClick={switchLang}>{t.lang}</button>
      </div>

      <div className="split">
      <div className="stack-lg">
      <section className={`adire${o.status === "Released" ? " paid" : o.status === "Disputed" ? " alert" : ""}`} aria-live="polite">
        <Cloth />
        <p className="label">{final ? t.total : s?.supplier ? t.lockedFor(s.supplier) : t.locked}</p>
        <p className="amount">${usd(final ? o.total : o.held)}<small>USDT</small></p>
        <p className="state">{t.status[o.status]}</p>
        <dl className="facts">
          <div><dt>{t.total}</dt><dd>${usd(o.total)}</dd></div>
          <div><dt>{t.deposit}</dt><dd>${usd(o.deposit)}</dd></div>
          {o.status === "Pending" ? <div><dt>{t.acceptBy}</dt><dd>{day(o.acceptBy, lang)}</dd></div> : null}
          {o.status === "Pending" || o.status === "Active" ? <div><dt>{t.shipBy}</dt><dd>{day(o.shipBy, lang)}</dd></div> : null}
          {o.status === "Shipped" ? <div><dt>{t.checkWindow}</dt><dd>{day(o.shippedAt + o.disputeWindow, lang)}</dd></div> : null}
        </dl>
      </section>

      {o.status !== "Refunded" ? (
        <ol className="steps" aria-label="Progress">
          {t.steps.map((label, i) => (
            <li key={label} className={i + 1 <= step ? (step === 4 ? "paid" : "done") : ""}>{label}</li>
          ))}
        </ol>
      ) : null}

      {lang === "en" && view.explanation ? <p>{view.explanation}</p> : null}

      {isNew && role === "buyer" && o.status === "Pending" ? (
        <div className="block stack">
          <h3>{t.share}</h3>
          <p className="small muted">It opens in Chinese for them, with the terms, the locked amount and an Accept button.</p>
          <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} className="num small" />
          <button className="secondary" onClick={() => navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true))}>{copied ? t.copied : t.copy}</button>
        </div>
      ) : null}

      <section className="stack">
        {account ? <p className="small muted">{t.youAre[role]}</p> : null}
        {!account && !final ? (
          <div className="stack">
            <p className="small muted">{t.connectToAct}</p>
            <button onClick={wallet.connect}>{t.connect}</button>
            {wallet.connectError ? <p className="note bad">{wallet.connectError}</p> : null}
          </div>
        ) : null}

        {o.splitOffer && !final ? (
          <p className="note">
            {t.splitOffer(usd(o.splitOffer.toSupplier), usd(held - BigInt(o.splitOffer.toSupplier)))}
            {account && o.splitOffer.proposer.toLowerCase() === account.toLowerCase() ? ` ${t.yourOffer}` : ""}
          </p>
        ) : null}

        <div className="actions">
          {has("accept") ? (
            <>
              <p className="small muted">{t.acceptNote}</p>
              <button className="money" disabled={!!busy} onClick={() => run("accept", [bid])}>{A.accept} (${usd(o.deposit)})</button>
            </>
          ) : null}

          {has("markShipped") ? (
            <div className="block stack">
              <label className="field">
                <span>{t.containerLabel}</span>
                <input value={container} onChange={(e) => setContainer(e.target.value)} placeholder="CSQU 305438 3" autoCapitalize="characters" className="num" />
                <small>{t.containerHint}</small>
              </label>
              {containerCheck && !containerCheck.ok ? <p className="note bad">{containerCheck.reason}</p> : null}
              <button disabled={!!busy || !containerCheck?.ok} onClick={() => run("markShipped", [bid, keccak256(toBytes(containerCheck.number))])}>{A.markShipped}</button>
            </div>
          ) : null}

          {has("acceptSplit") ? (
            <button className="money" disabled={!!busy} onClick={() => run("acceptSplit", [bid, BigInt(o.splitOffer.toSupplier)])}>{A.acceptSplit}</button>
          ) : null}

          {has("release") ? <button className={o.splitOffer && has("acceptSplit") ? "secondary" : "money"} disabled={!!busy} onClick={() => run("release", [bid])}>{A.release} (${usd(o.held)})</button> : null}

          {has("releasePart") ? (
            <div className="block stack">
              <label className="field">
                <span>{A.releasePart}</span>
                <input inputMode="decimal" value={partAmount} onChange={(e) => setPartAmount(e.target.value)} placeholder={`Up to ${usd(o.held)}`} className="num" />
                <small>For example when the bill of lading arrives, then the rest on delivery.</small>
              </label>
              <button className="secondary" disabled={!!busy || !/^\d+(\.\d{1,6})?$/.test(partAmount) || toUnits(partAmount) === 0n || toUnits(partAmount) > held} onClick={() => run("releasePart", [bid, toUnits(partAmount)])}>
                {A.releasePart}{partAmount ? ` ($${partAmount})` : ""}
              </button>
            </div>
          ) : null}

          {has("proposeSplit") ? (
            <div className="block stack">
              <label className="field">
                <span>{A.proposeSplit}</span>
                <input type="range" min="0" max="100" step="5" value={splitPct} onChange={(e) => setSplitPct(Number(e.target.value))} />
                <small className="num">{t.splitOffer(usd(toSupplierSplit), usd(held - toSupplierSplit))}</small>
              </label>
              <button className="secondary" disabled={!!busy} onClick={() => run("proposeSplit", [bid, toSupplierSplit])}>{A.proposeSplit}</button>
            </div>
          ) : null}

          {has("dispute") ? <button className="danger" disabled={!!busy} onClick={() => run("dispute", [bid])}>{A.dispute}</button> : null}
          {has("claim") ? <button disabled={!!busy} onClick={() => run("claim", [bid])}>{A.claim}</button> : null}
          {has("reclaim") ? <button disabled={!!busy} onClick={() => run("reclaim", [bid])}>{A.reclaim}</button> : null}
          {has("decline") ? <button className="danger" disabled={!!busy} onClick={() => run("cancel", [bid])}>{A.decline}</button> : null}
          {has("cancel") ? <button className="danger" disabled={!!busy} onClick={() => run("cancel", [bid])}>{A.cancel}</button> : null}
          {has("refundBuyer") ? <button className="danger" disabled={!!busy} onClick={() => run("cancel", [bid])}>{A.refundBuyer}</button> : null}
        </div>

        {busy ? <p className="note">{busy}</p> : null}
        {error ? <p className="note bad">{error}</p> : null}
        {lastTx ? <p className="note ok">{t.done}. <a href={`${EXPLORER}/tx/${lastTx}`} target="_blank" rel="noreferrer">{t.viewTx}</a></p> : null}
      </section>

      </div>
      <div className="stack-lg">
      <section className="stack">
        <h2>{t.terms}</h2>
        {s ? (
          <>
            <p className="small muted">{t.termsMatch}</p>
            <dl className="terms block">
              {["product", "quantity", "unitPriceUsd", "specs", "packaging", "inspection", "shipBy", "incoterm"].filter((k) => s[k] !== undefined).map((k) => (
                <div key={k}>
                  <dt>{t.fields[k]}</dt>
                  <dd>{Array.isArray(s[k]) ? <ul>{s[k].map((x) => <li key={x}>{x}</li>)}</ul> : k === "quantity" ? `${s.quantity} ${s.unit}` : s[k]}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : (
          <p className="small muted">{t.termsMissing}</p>
        )}
        <p className="small muted num">
          {t.parties(short(o.buyer), short(o.supplier))} <a href={`${EXPLORER}/address/${o.supplier}`} target="_blank" rel="noreferrer">Celoscan</a>
        </p>
      </section>
      </div>
      </div>
    </div>
  );
}
