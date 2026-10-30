import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, keccak256, parseEther, toBytes } from "viem";
import { api } from "../api.js";
import { vaultCall, toUnits, EXPLORER, celoBalance, usdtBalance, sendCelo, sendUsdt, isMiniPay, GAS_ENOUGH } from "../chain.js";
import { Cloth } from "../Adire.jsx";
import { withToast } from "../toast.jsx";
import TrackRecord from "../TrackRecord.jsx";
import { STRINGS, initialLang, saveLang } from "../i18n.js";
import { short, navigate } from "../App.jsx";

const usd = (v) => Number(formatUnits(BigInt(v), 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const day = (ts, lang) => new Date(ts * 1000).toLocaleDateString(lang === "zh" ? "zh-CN" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
// A supplier needs a tiny network fee (gas) to accept and update the order.
// The buyer can send some from their own wallet, right here.
function GasHelp({ o, role, account, t }) {
  const [bal, setBal] = useState(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState("");
  const g = t.gas;
  // Lower-case so an address with odd capital letters is still accepted.
  const supplier = o.supplier.toLowerCase();
  const refresh = useCallback(() => {
    const reads = [celoBalance(supplier), usdtBalance(supplier)];
    if (role === "buyer" && account) reads.push(celoBalance(account.toLowerCase()), usdtBalance(account.toLowerCase()));
    Promise.all(reads).then(([sc, su, mc = 0n, mu = 0n]) => setBal({ sc, su, mc, mu })).catch(() => {});
  }, [supplier, role, account]);
  useEffect(() => { refresh(); }, [refresh, o.status]);

  if (!bal || bal.sc >= GAS_ENOUGH) return null;
  const hasUsdt = bal.su >= 50_000n; // $0.05

  if (role === "supplier") {
    if (isMiniPay() && hasUsdt) return null; // MiniPay pays the fee from USDT
    return <p className="note">{hasUsdt ? g.supplierHasUsdt : g.supplierNone}</p>;
  }
  if (role !== "buyer") return null;

  async function give(kind, amount) {
    setSending(true);
    try {
      const hash = await withToast((cb) => (kind === "celo" ? sendCelo(supplier, amount, cb) : sendUsdt(supplier, amount, cb)), {
        confirm: t.toast.confirm,
        pending: t.toast.pending,
        done: g.done(kind === "celo" ? `${amount} CELO` : `$${amount} USDT`),
      });
      setSent(hash);
      setTimeout(refresh, 1500);
    } catch {
      /* the toast already says what happened */
    } finally {
      setSending(false);
    }
  }
  const celoOpts = ["0.02", "0.05", "0.1"];
  return (
    <div className="block stack gas-help">
      <h3>{g.title}</h3>
      <p className="small muted">{hasUsdt ? g.buyerHasUsdt : g.buyerNone}</p>
      {!sent ? (
        <>
          <div className="chips wrap">
            {celoOpts.map((a) => (
              <button key={a} type="button" className="chip" disabled={sending || bal.mc < parseEther(a) + parseEther("0.002")} onClick={() => give("celo", a)}>{g.sendCelo(a)}</button>
            ))}
            <button type="button" className="chip" disabled={sending || bal.mu < 100_000n} onClick={() => give("usdt", "0.10")}>{g.sendUsdt}</button>
          </div>
          <p className="small muted">{bal.mc < parseEther("0.022") ? g.noCelo : g.which}</p>
        </>
      ) : null}
      {sent ? <p className="note ok">{g.thanks}</p> : null}
    </div>
  );
}

const STEP_OF = { Pending: 1, Active: 2, Shipped: 3, Disputed: 3, Released: 4, Settled: 4, Refunded: 0 };

export default function Order({ id, wallet }) {
  const { account } = wallet;
  const [lang, setLang] = useState(initialLang);
  const t = STRINGS[lang];
  const [view, setView] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [shareLang, setShareLang] = useState("auto");
  const [lastTx, setLastTx] = useState("");
  const [partAmount, setPartAmount] = useState("");
  const [container, setContainer] = useState("");
  const [containerCheck, setContainerCheck] = useState(null);
  const [splitPct, setSplitPct] = useState(50);
  const [copied, setCopied] = useState(false);
  const [steps, setSteps] = useState(null);
  const isNew = new URLSearchParams(location.search).has("new");

  // A brand-new order can take a few seconds to reach every network node, so a
  // "not found" is retried quickly before we believe it.
  const misses = useRef(0);
  const load = useCallback(() => {
    api
      .order(id, account)
      .then((v) => {
        misses.current = 0;
        setError("");
        setView(v);
        // Swap an old number link for the order's private link in the address bar.
        if (v.link && id !== v.link) history.replaceState(null, "", `/o/${v.link}${location.search}`);
      })
      .catch((e) => {
        if (e.status === 404 && isNew && misses.current < 12) {
          misses.current += 1;
          setError(t.confirming);
          setTimeout(load, 2500);
        } else setError(e.status === 404 ? t.notFound : e.message);
      });
    api.timeline(id).then((r) => setSteps(r.steps)).catch(() => {});
  }, [id, account, isNew, t.notFound, t.confirming]);

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

  if (error && !view) return <p className={error === t.confirming ? "note" : "note bad"}>{error}</p>;
  if (!view) return <p className="muted">{t.loading}</p>;

  const { order: o, sheet, role, actions, now } = view;
  const s = sheet?.sheet;
  const goods = (s?.kind ?? "goods") === "goods";
  const statusLabel = o.status === "Shipped" && !goods ? t.statusDelivered : t.status[o.status];
  const held = BigInt(o.held);
  const final = ["Released", "Refunded", "Settled"].includes(o.status);
  const step = STEP_OF[o.status];
  const toSupplierSplit = (held * BigInt(splitPct)) / 100n;

  // One transaction, followed by a notification from "confirm" to "done", then
  // the page refreshes until the network shows the new state.
  async function run(name, args) {
    setError("");
    setBusy(t.working);
    const before = `${o.status}:${o.held}:${o.splitOffer?.toSupplier ?? ""}`;
    const amount = name === "releasePart" ? usd(args[1]) : null;
    try {
      const hash = await withToast((cb) => vaultCall(name, args, cb, o.vault), {
        confirm: t.toast.confirm,
        pending: t.toast.pending,
        done: t.toast.done[name] ? t.toast.done[name](amount) : t.done,
      });
      setLastTx(hash);
      setPartAmount("");
      setContainer("");
      for (let i = 0; i < 10; i++) {
        const v = await api.order(id, account).catch(() => null);
        if (v && `${v.order.status}:${v.order.held}:${v.order.splitOffer?.toSupplier ?? ""}` !== before) {
          setView(v);
          break;
        }
        await new Promise((r) => setTimeout(r, 1200));
      }
      api.timeline(id).then((r) => setSteps(r.steps)).catch(() => {});
    } catch (e) {
      if (!/reject|denied|cancel/i.test(e.shortMessage ?? e.message ?? "")) setError(e.shortMessage ?? e.message);
    } finally {
      setBusy("");
    }
  }

  const A = t.actions;
  // Mark shipped, then tell the server the container number (it checks it against the
  // fingerprint now onchain) so the buyer can see and track it.
  async function shipWithTracking(number) {
    await run("markShipped", [BigInt(o.id), keccak256(toBytes(number))]);
    for (let i = 0; i < 6; i++) {
      if (await api.tracking(view.link, number).then(() => true).catch(() => false)) return load();
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const checkEnds = o.shippedAt + o.disputeWindow;
  const daysLeft = Math.max(0, Math.ceil((checkEnds - now) / 86400));
  const bid = BigInt(o.id);
  const has = (a) => actions.includes(a);
  const shareUrl = `${location.origin}/o/${view.link}${shareLang === "auto" ? "" : `?lang=${shareLang}`}`;

  return (
    <div className="stack-lg" lang={lang}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h1 style={{ fontSize: 24 }}>#{o.id} {s?.product ?? ""}</h1>
        <span className="row-gap">
          <a className="linkish" href={`/o/${view.link}/receipt`} onClick={(e) => { e.preventDefault(); navigate(`/o/${view.link}/receipt`); }}>{t.receipt}</a>
          <button className="linkish" onClick={switchLang}>{t.lang}</button>
        </span>
      </div>

      <div className="split">
      <div className="stack-lg">
      <section className={`adire${o.status === "Released" ? " paid" : o.status === "Disputed" ? " alert" : ""}`} aria-live="polite">
        <Cloth />
        <p className="label">{final ? t.total : s?.supplier ? t.lockedFor(s.supplier) : t.locked}</p>
        <p className="amount">${usd(final ? o.total : o.held)}<small>USDT</small></p>
        <p className="state">{statusLabel}</p>
        <dl className="facts">
          <div><dt>{t.total}</dt><dd>${usd(o.total)}</dd></div>
          <div><dt>{t.deposit}</dt><dd>${usd(o.deposit)}</dd></div>
          {o.status === "Pending" ? <div><dt>{t.acceptBy}</dt><dd>{day(o.acceptBy, lang)}</dd></div> : null}
          {o.status === "Pending" || o.status === "Active" ? <div><dt>{goods ? t.shipBy : t.deliverBy}</dt><dd>{day(o.shipBy, lang)}</dd></div> : null}
          {o.status === "Shipped" ? <div><dt>{t.checkWindow}</dt><dd>{day(o.shippedAt + o.disputeWindow, lang)}</dd></div> : null}
        </dl>
      </section>

      {o.status !== "Refunded" ? (
        <ol className="steps" aria-label="Progress">
          {t.steps.map((label0, i) => ({ label: i === 2 && !goods ? t.stepDelivered : label0, i })).map(({ label, i }) => (
            <li key={label} className={i + 1 <= step ? (step === 4 ? "paid" : "done") : ""}>{label}</li>
          ))}
        </ol>
      ) : null}

      {lang === "en" && view.explanation ? <p>{view.explanation}</p> : null}

      {isNew && role === "buyer" && o.status === "Pending" ? (
        <div className="block stack">
          <h3>{t.share}</h3>
          <p className="small muted">They see the terms, the locked amount and an Accept button. Pick the language it opens in:</p>
          <div className="chips wrap">
            {[["auto", "Their phone's language"], ["en", "English"], ["zh", "中文 Chinese"]].map(([v, label]) => (
              <button key={v} type="button" className={`chip${shareLang === v ? " on" : ""}`} onClick={() => { setShareLang(v); setCopied(false); }}>{label}</button>
            ))}
          </div>
          <input readOnly value={shareUrl} onFocus={(e) => e.target.select()} className="num small" />
          <button className="secondary" onClick={() => navigator.clipboard?.writeText(shareUrl).then(() => setCopied(true))}>{copied ? t.copied : t.copy}</button>
        </div>
      ) : null}

      {["Pending", "Active", "Disputed"].includes(o.status) ? <GasHelp o={o} role={role} account={account} t={t} /> : null}

      {o.status === "Shipped" && goods ? (
        <div className={`block stack ${role === "buyer" && daysLeft <= 7 ? "urgent" : ""}`}>
          <h3>{role === "buyer" ? t.ship.buyerTitle(daysLeft) : t.ship.otherTitle(daysLeft)}</h3>
          <p className="small muted">{role === "buyer" ? t.ship.buyerBody : t.ship.otherBody}</p>
          {view.tracking ? (
            <div className="row-gap">
              <span className="num">{t.ship.container} <strong>{view.tracking.number}</strong></span>
              <a className="linkish" href={`https://www.google.com/search?q=${view.tracking.number}+container+tracking`} target="_blank" rel="noreferrer">{t.ship.track}</a>
              <a className="linkish" href="https://www.track-trace.com/container" target="_blank" rel="noreferrer">track-trace.com</a>
            </div>
          ) : <p className="small muted">{t.ship.noNumber}</p>}
          {role === "buyer" && has("dispute") ? <button className="secondary" disabled={!!busy} onClick={() => run("dispute", [bid])}>{t.ship.hold}</button> : null}
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
              <TrackRecord address={o.buyer} as="buyer" lang={lang} />
              <p className="small muted">{t.acceptNote}</p>
              <button className="money" disabled={!!busy} onClick={() => run("accept", [bid])}>{A.accept} (${usd(o.deposit)})</button>
            </>
          ) : null}

          {has("markShipped") && !goods ? (
            <div className="block stack">
              <label className="field">
                <span>{t.deliveryNote}</span>
                <input value={container} onChange={(e) => setContainer(e.target.value)} maxLength={140} />
                <small>{t.deliveryNoteHint}</small>
              </label>
              <button disabled={!!busy} onClick={() => run("markShipped", [bid, keccak256(toBytes(container.trim() || "delivered"))])}>{t.markDelivered}</button>
            </div>
          ) : null}

          {has("markShipped") && goods ? (
            <div className="block stack">
              <label className="field">
                <span>{t.containerLabel}</span>
                <input value={container} onChange={(e) => setContainer(e.target.value)} placeholder="CSQU 305438 3" autoCapitalize="characters" className="num" />
                <small>{t.containerHint}</small>
              </label>
              {containerCheck && !containerCheck.ok ? <p className="note bad">{containerCheck.reason}</p> : null}
              <button disabled={!!busy || !containerCheck?.ok} onClick={() => shipWithTracking(containerCheck.number)}>{A.markShipped}</button>
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

          {has("dispute") && !(goods && o.status === "Shipped") ? <button className="danger" disabled={!!busy} onClick={() => run("dispute", [bid])}>{A.dispute}</button> : null}
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
        <h2>{t.timelineTitle}</h2>
        {steps?.length ? (
          <ol className="timeline">
            {steps.map((st) => (
              <li key={st.tx + st.event} className={`tl-${st.event}`}>
                <span className="tl-dot" aria-hidden="true" />
                <div>
                  <p className="tl-what">
                    <span>{t.timeline[st.event] ?? st.event}</span>
                    {st.amount && st.event !== "SplitProposed" ? <span className="tl-amt num">${usd(st.amount)}</span> : null}
                  </p>
                  <p className="tl-when small muted num">
                    {new Date(st.at * 1000).toLocaleString(lang === "zh" ? "zh-CN" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                    <a className="tl-link" href={`${EXPLORER}/tx/${st.tx}`} target="_blank" rel="noreferrer">{t.viewTx}</a>
                  </p>
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="small muted">{t.timelineEmpty}</p>
        )}
      </section>
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
