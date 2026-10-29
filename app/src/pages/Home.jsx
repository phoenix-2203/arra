// Dashboard (Mercury-style): balances, money in Arra, and orders split into
// Buying / Supplying, each with its status and the next thing to do.
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { api } from "../api.js";
import { usdtBalance, cngnBalance, hasWallet } from "../chain.js";
import { navigate, short } from "../App.jsx";
import { STRINGS } from "../i18n.js";
import Icon from "../Icon.jsx";

const t = STRINGS.en;
const u = (v) => Number(formatUnits(BigInt(v), 6));
const usd = (v) => `$${u(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const STEP = { Pending: 1, Active: 2, Shipped: 3, Disputed: 3, Released: 4, Settled: 4, Refunded: 4 };
const NEXT = {
  buyer: { Pending: "Send your supplier the order link", Active: "Being made. Balance stays locked until shipping", Shipped: "Check the goods, then pay the balance", Disputed: "Offer or accept a split", Released: "Nothing left to do", Settled: "Nothing left to do", Refunded: "The money is back in your wallet" },
  supplier: { Pending: "Accept to receive your deposit", Active: "Ship, then add the container number", Shipped: "Paid automatically when the check period ends", Disputed: "Offer or accept a split", Released: "Nothing left to do", Settled: "Nothing left to do", Refunded: "Order closed" },
};
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
    setError("");
    api.myOrders(account).then((r) => {
      setOrders(r.orders);
      if (!r.orders.some((o) => o.role === "buyer") && r.orders.some((o) => o.role === "supplier")) setTab("supplier");
    }).catch((e) => setError(e.message));
    usdtBalance(account).then(setUsdt).catch(() => {});
    cngnBalance(account).then(setCngn).catch(() => {});
  }, [account]);

  if (!account) {
    return (
      <div className="narrow stack-lg center-col">
        <h1>Your orders</h1>
        <p className="muted">Connect the wallet you use for Arra to see your orders and balances.</p>
        {hasWallet() ? <button onClick={wallet.connect}>Connect wallet</button> : <p className="note">Open this page inside MiniPay, or any wallet browser on Celo.</p>}
        {wallet.connectError ? <p className="note bad">{wallet.connectError}</p> : null}
      </div>
    );
  }

  const live = (o) => !["Released", "Settled", "Refunded"].includes(o.order.status);
  const mine = (role) => (orders ?? []).filter((o) => o.role === role);
  const lockedForSuppliers = mine("buyer").filter(live).reduce((s, o) => s + BigInt(o.order.held), 0n);
  const waitingForMe = mine("supplier").filter(live).reduce((s, o) => s + BigInt(o.order.held), 0n);
  const list = mine(tab);

  return (
    <div className="dash stack-lg">
      <div className="dash-head">
        <div>
          <h1>Your orders</h1>
          <p className="muted num">{short(account)}</p>
        </div>
        <div className="row-gap">
          <button className="secondary auto" onClick={() => navigate("/history")}><Icon name="clock" size={18} /> History</button>
          <button className="money auto" onClick={() => navigate("/new")}><Icon name="plus" size={18} /> New order</button>
        </div>
      </div>

      <section className="balances" aria-label="Balances">
        <div className="bal">
          <span>USDT in wallet</span>
          <strong className="num">{usdt !== null ? usd(usdt) : "…"}</strong>
        </div>
        <div className="bal">
          <span>Naira (cNGN) in wallet</span>
          <strong className="num">{cngn !== null ? `₦${Math.round(u(cngn)).toLocaleString("en-NG")}` : "…"}</strong>
        </div>
        <div className="bal hl">
          <span>Locked for your suppliers</span>
          <strong className="num">{orders ? usd(lockedForSuppliers) : "…"}</strong>
        </div>
        <div className="bal">
          <span>Waiting for you as a supplier</span>
          <strong className="num">{orders ? usd(waitingForMe) : "…"}</strong>
        </div>
      </section>

      <div className="tabs" role="tablist">
        {[["buyer", "Buying"], ["supplier", "Supplying"]].map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "tab on" : "tab"} onClick={() => setTab(k)}>
            {label} <span className="count num">{mine(k).length}</span>
          </button>
        ))}
      </div>

      {error ? <p className="note bad">{error}</p> : null}
      {orders === null && !error ? <p className="muted">Loading your orders…</p> : null}
      {orders && list.length === 0 ? (
        <div className="empty">
          <Icon name={tab === "buyer" ? "lock" : "signature"} size={30} />
          <p>{tab === "buyer" ? "No orders yet. Lock your first one in a few minutes." : "When a buyer sends you an Arra order, open their link and accept it from this wallet. It will show up here."}</p>
          {tab === "buyer" ? <button className="money auto" onClick={() => navigate("/new")}>Start an order</button> : null}
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
