import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { api } from "../api.js";
import { usdtBalance, hasWallet } from "../chain.js";
import { Cloth } from "../Adire.jsx";
import { navigate, short } from "../App.jsx";
import { STRINGS } from "../i18n.js";

const t = STRINGS.en;

export default function Home({ wallet }) {
  const { account } = wallet;
  const [orders, setOrders] = useState(null);
  const [balance, setBalance] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!account) return;
    setError("");
    api.myOrders(account).then((r) => setOrders(r.orders)).catch((e) => setError(e.message));
    usdtBalance(account).then(setBalance).catch(() => {});
  }, [account]);

  if (!account) {
    return (
      <div className="split hero-split">
        <div className="stack-lg">
        <section className="adire hero">
          <Cloth />
          <p className="label">Importing from China?</p>
          <h1 style={{ marginTop: 8 }}>Pay the deposit. Keep the balance locked until it ships.</h1>
          <p className="lede" style={{ marginTop: 12 }}>
            Your supplier gets their deposit the moment they accept. The rest waits in an open contract they can see but can't touch until the goods ship. If they don't, it comes back to you automatically.
          </p>
        </section>
        <div className="stack">
          {hasWallet() ? (
            <button onClick={wallet.connect}>{t.connect}</button>
          ) : (
            <p className="note">Open this page inside MiniPay (or any wallet browser on Celo) to place an order.</p>
          )}
          {wallet.connectError ? <p className="note bad">{wallet.connectError}</p> : null}
        </div>
        </div>
        <section className="stack block how">
          <h2>How an order works</h2>
          <ol className="stack small" style={{ paddingLeft: 20, margin: 0 }}>
            <li>You write the order sheet with exact terms. Arra flags vague words like "good quality".</li>
            <li>You lock the full amount in USDT.</li>
            <li>Your supplier accepts from their own wallet and receives the deposit.</li>
            <li>They ship and enter the container number; Arra checks it's a real one.</li>
            <li>You check the goods, then pay the balance, in parts if you like. If there's a problem, either side offers a split and the other accepts.</li>
          </ol>
        </section>
      </div>
    );
  }

  return (
    <div className="stack-lg narrow">
      <div className="stack">
        <h1>Your orders</h1>
        {balance !== null ? <p className="muted num">Wallet: ${Number(formatUnits(balance, 6)).toFixed(2)} USDT</p> : null}
      </div>
      <button className="money" onClick={() => navigate("/new")}>Start a new order</button>
      {error ? <p className="note bad">{error}</p> : null}
      {orders === null && !error ? <p className="muted">Loading…</p> : null}
      {orders?.length === 0 ? <p className="muted">No orders yet. Orders you place, or that suppliers accept from this wallet, show up here.</p> : null}
      {orders?.length ? (
        <ul className="orders">
          {orders.map(({ order, sheet, role }) => (
            <li key={order.id}>
              <a href={`/o/${order.id}`} onClick={(e) => { e.preventDefault(); navigate(`/o/${order.id}`); }}>
                <span>
                  #{order.id} {sheet?.sheet?.product ?? (role === "buyer" ? `to ${short(order.supplier)}` : `from ${short(order.buyer)}`)}
                </span>
                <span className="amt">${order.usd.total}</span>
                <span className="st">
                  {role === "buyer" ? "You're buying" : "You're supplying"}. {t.status[order.status]}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
