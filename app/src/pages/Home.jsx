// Dashboard (Mercury-style): balances, money in Arra, and orders split into
// Buying / Supplying, each with its status and the next thing to do.
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { api } from "../api.js";
import { usdtBalance, cngnBalance, hasWallet } from "../chain.js";
import { navigate, short } from "../App.jsx";
import { STRINGS } from "../i18n.js";
import Icon from "../Icon.jsx";
import { nextDeadline } from "../calendar.js";

const t = STRINGS.en;
const u = (v) => Number(formatUnits(BigInt(v), 6));
const usd = (v) => `$${u(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STEP = { Pending: 1, Active: 2, Shipped: 3, Disputed: 3, Released: 4, Settled: 4, Refunded: 4 };
const NEXT = {
  buyer: { Pending: "Send your supplier the order link", Active: "Being made. Balance stays locked until shipping", Shipped: "Check the goods, then pay the balance", Disputed: "Offer or accept a split", Released: "Nothing left to do", Settled: "Nothing left to do", Refunded: "The money is back in your wallet" },
  supplier: { Pending: "Accept to receive your deposit", Active: "Ship, then add the container number", Shipped: "Paid automatically when the check period ends", Disputed: "Offer or accept a split", Released: "Nothing left to do", Settled: "Nothing left to do", Refunded: "Order closed" },
};
// For someone with no orders yet: the whole idea in three steps.
export function HowSteps() {
  return (
    <ol className="how3">
      <li><strong>Lock the money</strong><span>Write what you're buying and lock the total in USDT or naira. It sits in a public contract, not with Arra.</span></li>
      <li><strong>Supplier accepts</strong><span>They open your link, accept from their wallet and get the deposit at once. The rest stays locked.</span></li>
      <li><strong>Pay when it's right</strong><span>When the goods ship or arrive, you pay the balance. If they never accept or never ship, it comes back to you automatically.</span></li>
    </ol>
  );
}

const ACTION_NEEDED = { buyer: ["Shipped", "Disputed"], supplier: ["Pending", "Active", "Disputed"] };

export default function Home({ wallet }) {
  const { account } = wallet;
  const [orders, setOrders] = useState(null);
  const [usdt, setUsdt] = useState(null);
  const [cngn, setCngn] = useState(null);
  const [tab, setTab] = useState("buyer");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!account) return;
    let current = true; // a wallet switch mustn't show the previous wallet's orders
    setError("");
    setOrders(null);
    api.myOrders(account).then((r) => {
      if (!current) return;
      setOrders(r.orders);
      if (!r.orders.some((o) => o.role === "buyer") && r.orders.some((o) => o.role === "supplier")) setTab("supplier");
    }).catch((e) => setError(e.message));
    usdtBalance(account).then(setUsdt).catch(() => {});
    cngnBalance(account).then(setCngn).catch(() => {});
    return () => { current = false; };
  }, [account]);

  if (!account) {
    return (
      <div className="narrow stack-lg center-col">
        <h1>Your orders</h1>
        <p className="muted">Connect the wallet you use for Arra to see your orders, or start your first one.</p>
        {hasWallet() ? <button onClick={wallet.connect}>Connect wallet</button> : <p className="note">Open this page inside MiniPay, or any wallet browser on Celo.</p>}
        {wallet.connectError ? <p className="note bad">{wallet.connectError}</p> : null}
        <HowSteps />
      </div>
    );
  }

  const live = (o) => !["Released", "Settled", "Refunded"].includes(o.order.status);
  const mine = (role) => (orders ?? []).filter((o) => o.role === role);
  const lockedForSuppliers = mine("buyer").filter(live).reduce((s, o) => s + BigInt(o.order.held), 0n);
  const waitingForMe = mine("supplier").filter(live).reduce((s, o) => s + BigInt(o.order.held), 0n);
  const list = mine(tab);
  const none = orders !== null && orders.length === 0;
  const both = mine("buyer").length > 0 && mine("supplier").length > 0;

  return (
    <div className="dash stack-lg">
      <div className="dash-head">
        <div>
          <h1>Your orders</h1>
          <p className="muted num">{short(account)}</p>
        </div>
        <button className="money auto" onClick={() => navigate("/new")}><Icon name="plus" size={18} /> New order</button>
      </div>

      <section className="balances" aria-label="Balances">
        <div className="bal">
          <span>USDT in wallet</span>
          <strong className="num">{usdt !== null ? usd(usdt) : "…"}</strong>
        </div>
        {cngn !== null && cngn > 0n ? (
          <div className="bal">
            <span>Naira (cNGN) in wallet</span>
            <strong className="num">₦{Math.round(u(cngn)).toLocaleString("en-NG")}</strong>
          </div>
        ) : null}
        {lockedForSuppliers > 0n ? (
          <div className="bal hl">
            <span>Locked for your suppliers</span>
            <strong className="num">{usd(lockedForSuppliers)}</strong>
          </div>
        ) : null}
        {waitingForMe > 0n ? (
          <div className="bal">
            <span>Waiting for you as a supplier</span>
            <strong className="num">{usd(waitingForMe)}</strong>
          </div>
        ) : null}
      </section>

      {error ? <p className="note bad">{error}</p> : null}
      {orders === null && !error ? <p className="muted">Loading your orders…</p> : null}

      {none ? (
        <div className="stack">
          <h2>How it works</h2>
          <HowSteps />
          <button className="money" onClick={() => navigate("/new")}>Start your first order</button>
          <p className="small muted">Supplying? When a buyer sends you an Arra link, open it and accept from this wallet. It will show up here.</p>
        </div>
      ) : null}

      {both ? (
        <div className="tabs" role="tablist">
          {[["buyer", "Buying"], ["supplier", "Supplying"]].map(([k, label]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "tab on" : "tab"} onClick={() => setTab(k)}>
              {label} <span className="count num">{mine(k).length}</span>
            </button>
          ))}
        </div>
      ) : null}

      {list.length ? (
        <ul className="order-list">
          {list.map(({ order: o, link, sheet, role }) => {
            const needs = ACTION_NEEDED[role].includes(o.status);
            const pct = (STEP[o.status] / 4) * 100;
            return (
              <li key={o.id}>
                <a href={`/o/${link}`} onClick={(e) => { e.preventDefault(); navigate(`/o/${link}`); }}>
                  <div className="ol-top">
                    <span className="ol-title">#{o.id} {sheet?.sheet?.product ?? (role === "buyer" ? `to ${short(o.supplier)}` : `from ${short(o.buyer)}`)}</span>
                    <span className="ol-amt num">{usd(o.total)}</span>
                  </div>
                  <div className={`ol-bar ${o.status === "Refunded" ? "grey" : ""}`}><span style={{ width: `${pct}%` }} /></div>
                  <div className="ol-meta">
                    <span className={`pill ${needs ? "act" : ""}`}>{t.status[o.status]}</span>
                    <span className="muted">{NEXT[role][o.status]}</span>
                    {nextDeadline(o) ? <span className={`due ${needs ? "act" : ""}`}>{nextDeadline(o)}</span> : null}
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
