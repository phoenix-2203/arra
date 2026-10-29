// Transaction history: every payment in or out of the connected wallet, across
// all its orders, newest first. Each row links to the order's receipt and to
// the transaction on Celoscan. Downloadable as CSV for bookkeeping.
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { api } from "../api.js";
import { hasWallet, EXPLORER } from "../chain.js";
import { navigate, short } from "../App.jsx";
import Icon from "../Icon.jsx";

const money = (v) => Number(formatUnits(BigInt(v), 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayKey = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
const time = (ts) => new Date(ts * 1000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const SIGN = { in: "+", out: "−", info: "" };

function toCsv(rows) {
  const head = ["Date (UTC)", "Order", "Product", "Your role", "What happened", "Direction", "Amount (USDT)", "Other party", "Transaction"];
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = rows.map((r) => [
    new Date(r.at * 1000).toISOString().replace("T", " ").slice(0, 19),
    r.orderId,
    r.product ?? "",
    r.role,
    r.label,
    r.flow === "info" ? "inside the order" : r.flow === "in" ? "received" : "paid",
    (r.flow === "out" ? "-" : "") + formatUnits(BigInt(r.amount), 6),
    r.counterpartyName ? `${r.counterpartyName} (${r.counterparty})` : r.counterparty,
    r.tx,
  ].map(esc).join(","));
  return [head.map(esc).join(","), ...lines].join("\n");
}

export default function History({ wallet }) {
  const { account } = wallet;
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    if (!account) return;
    setError("");
    api.activity(account).then(setData).catch((e) => setError(e.message));
  }, [account]);

  if (!account) {
    return (
      <div className="narrow stack-lg center-col">
        <h1>History</h1>
        <p className="muted">Connect your wallet to see every payment in and out of it.</p>
        {hasWallet() ? <button onClick={wallet.connect}>Connect wallet</button> : <p className="note">Open this page inside MiniPay, or any wallet browser on Celo.</p>}
      </div>
    );
  }

  const rows = (data?.rows ?? []).filter((r) => filter === "all" || r.flow === filter);
  const groups = [];
  for (const r of rows) {
    const k = dayKey(r.at);
    if (groups.at(-1)?.day !== k) groups.push({ day: k, rows: [] });
    groups.at(-1).rows.push(r);
  }

  function download() {
    const blob = new Blob([toCsv(data.rows)], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `arra-history-${account.slice(2, 8)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  return (
    <div className="dash stack-lg">
      <div className="dash-head">
        <div>
          <h1>History</h1>
          <p className="muted num">{short(account)}</p>
        </div>
        {data?.rows?.length ? <button className="secondary auto" onClick={download}>Download CSV</button> : null}
      </div>

      {data ? (
        <section className="balances two" aria-label="Totals">
          <div className="bal">
            <span>Received</span>
            <strong className="num pos">+${money(data.totals.in)}</strong>
          </div>
          <div className="bal">
            <span>Paid into orders</span>
            <strong className="num">−${money(data.totals.out)}</strong>
          </div>
        </section>
      ) : null}

      <div className="chips wrap" role="radiogroup" aria-label="Show">
        {[["all", "Everything"], ["in", "Money in"], ["out", "Money out"], ["info", "Inside orders"]].map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={filter === v} className={filter === v ? "chip on" : "chip"} onClick={() => setFilter(v)}>{label}</button>
        ))}
      </div>

      {error ? <p className="note bad">{error}</p> : null}
      {!data && !error ? <p className="muted">Loading your history…</p> : null}
      {data && rows.length === 0 ? (
        <div className="empty">
          <Icon name="clock" size={30} />
          <p>{data.rows.length ? "Nothing here with this filter." : "No payments yet. When you lock an order or get paid, it shows up here."}</p>
        </div>
      ) : null}

      {groups.map((g) => (
        <section key={g.day} className="stack">
          <h3 className="hist-day">{g.day}</h3>
          <ul className="hist">
            {g.rows.map((r) => (
              <li key={r.tx + r.event + r.role} className={`hist-row ${r.flow}`}>
                <span className="hist-icon" aria-hidden="true"><Icon name={r.flow === "in" ? "coins" : r.flow === "out" ? "lock" : "arrow"} size={18} /></span>
                <div className="hist-main">
                  <p className="hist-what">{r.label}</p>
                  <p className="small muted">
                    Order #{r.orderId}{r.product ? ` · ${r.product}` : ""} · {r.role === "buyer" ? "to" : "from"} {r.counterpartyName ?? short(r.counterparty)}
                  </p>
                  <p className="small hist-links">
                    <span className="muted num">{time(r.at)}</span>
                    <a href={`/o/${r.link}/receipt`} onClick={(e) => { e.preventDefault(); navigate(`/o/${r.link}/receipt`); }}>Receipt</a>
                    <a href={`${EXPLORER}/tx/${r.tx}`} target="_blank" rel="noreferrer">Celoscan</a>
                  </p>
                </div>
                <span className="hist-amt num">{SIGN[r.flow]}${money(r.amount)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {data?.rows?.length ? <p className="small muted">"Inside orders" are payments made from money you had already locked, like the deposit going to your supplier. They don't change your wallet again.</p> : null}
    </div>
  );
}
