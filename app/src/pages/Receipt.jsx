// Printable receipt for one order: who, what, how much, every payment with its
// onchain transaction, and the terms fingerprint. "Save as PDF" uses the
// browser's print dialog, so it works on phones and desktops with no extra code.
import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { api } from "../api.js";
import { EXPLORER, VAULT } from "../chain.js";
import { navigate } from "../App.jsx";
import { STRINGS } from "../i18n.js";
import { moneyRows } from "./receiptRows.js";

const t = STRINGS.en;
const money = (v) => `$${Number(formatUnits(BigInt(v), 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const when = (ts) => new Date(ts * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
const date = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

export default function Receipt({ id, wallet }) {
  const { account } = wallet;
  const [view, setView] = useState(null);
  const [steps, setSteps] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api.order(id, account).then((v) => {
      setView(v);
      if (v.link && id !== v.link) history.replaceState(null, "", `/o/${v.link}/receipt`);
    }).catch((e) => setError(e.status === 404 ? t.notFound : e.message));
    api.timeline(id).then((r) => setSteps(r.steps ?? [])).catch(() => setSteps([]));
  }, [id, account]);

  if (error) return <p className="note bad">{error}</p>;
  if (!view || !steps) return <p className="muted">Preparing the receipt…</p>;

  const { order: o, sheet, role } = view;
  const s = sheet?.sheet;
  const created = steps.find((x) => x.event === "OrderCreated");
  const rows = moneyRows(steps, o);
  const paidToSupplier = rows.filter((r) => r.to === "supplier").reduce((a, r) => a + BigInt(r.amount), 0n);
  const backToBuyer = rows.filter((r) => r.to === "buyer").reduce((a, r) => a + BigInt(r.amount), 0n);
  const keeperFee = rows.filter((r) => r.to === "keeper").reduce((a, r) => a + BigInt(r.amount), 0n);
  const number = `ARRA-${String(o.id).padStart(6, "0")}`;
  const statusText = o.status === "Shipped" && s && (s.kind ?? "goods") !== "goods" ? t.statusDelivered : t.status[o.status];

  return (
    <div className="stack-lg">
      <div className="row no-print receipt-tools">
        <button className="secondary auto" onClick={() => navigate(`/o/${view.link}`)}>Back to order</button>
        <button className="money auto" onClick={() => window.print()}>Save as PDF</button>
      </div>

      <article className="receipt" aria-label={`Receipt ${number}`}>
        <header className="rc-head">
          <div>
            <p className="rc-brand">arra</p>
            <p className="rc-sub">Escrow on Celo</p>
          </div>
          <div className="rc-meta">
            <p className="rc-title">Receipt</p>
            <p className="num">{number}</p>
            <p>Issued {date(Math.floor(Date.now() / 1000))}</p>
          </div>
        </header>

        <section className="rc-parties">
          <div>
            <p className="rc-label">Buyer{role === "buyer" ? " (you)" : ""}</p>
            <p className="num rc-addr">{o.buyer}</p>
          </div>
          <div>
            <p className="rc-label">Supplier{role === "supplier" ? " (you)" : ""}</p>
            {s?.supplier ? <p>{s.supplier}</p> : null}
            <p className="num rc-addr">{o.supplier}</p>
          </div>
        </section>

        <section className="rc-facts">
          <div><p className="rc-label">Order date</p><p>{created ? date(created.at) : "—"}</p></div>
          <div><p className="rc-label">Status</p><p>{statusText}</p></div>
          <div><p className="rc-label">Currency</p><p>USDT on Celo</p></div>
        </section>

        <table className="rc-table">
          <thead>
            <tr><th>Item</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Amount</th></tr>
          </thead>
          <tbody>
            <tr>
              <td>
                {s?.product ?? `Order #${o.id}`}
                {s?.specs?.length ? <span className="rc-specs">{s.specs.join(" · ")}</span> : null}
                {s?.incoterm ? <span className="rc-specs">{s.incoterm}</span> : null}
              </td>
              <td className="r num">{s ? `${s.quantity} ${s.unit}` : "1"}</td>
              <td className="r num">{s ? `$${s.unitPriceUsd}` : "—"}</td>
              <td className="r num">{money(o.total)}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colSpan="3">Order total</td><td className="r num">{money(o.total)}</td></tr>
            <tr><td colSpan="3">Paid to the supplier</td><td className="r num">{money(paidToSupplier)}</td></tr>
            {backToBuyer > 0n ? <tr><td colSpan="3">Returned to the buyer</td><td className="r num">{money(backToBuyer)}</td></tr> : null}
            {keeperFee > 0n ? <tr><td colSpan="3">Agent fee (automatic refund or payout)</td><td className="r num">{money(keeperFee)}</td></tr> : null}
            <tr className="rc-strong"><td colSpan="3">Still held in the vault</td><td className="r num">{money(o.held)}</td></tr>
          </tfoot>
        </table>

        <section>
          <p className="rc-label">Payments</p>
          <ol className="rc-pay">
            {rows.map((r) => (
              <li key={r.tx + r.what}>
                <div>
                  <p>{r.what}</p>
                  <p className="rc-small">{when(r.at)}{r.tx ? <> · <a className="num" href={`${EXPLORER}/tx/${r.tx}`} target="_blank" rel="noreferrer">{r.tx.slice(0, 10)}…{r.tx.slice(-8)}</a></> : null}</p>
                </div>
                <p className="num">{money(r.amount)}</p>
              </li>
            ))}
          </ol>
        </section>

        <footer className="rc-foot">
          <p>Every payment above is a public transaction on the Celo network and can be checked on Celoscan. The money was held by the Arra vault contract ({o.vault ?? VAULT}), not by Arra.</p>
          <p>Terms fingerprint: <span className="num rc-addr">{o.ref}</span>{s ? " The agreed terms match this fingerprint." : ""}</p>
          <p>{location.host}/o/{view.link}</p>
        </footer>
      </article>
    </div>
  );
}
