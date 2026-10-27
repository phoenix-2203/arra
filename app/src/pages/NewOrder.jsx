import { useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress } from "viem";
import { api } from "../api.js";
import { lockOrder, usdtBalance, cngnBalance, convertNairaToUsdt } from "../chain.js";
import { navigate } from "../App.jsx";

const MAX_ORDER = 50_000_000n; // $50 cap while Arra is new (set in the vault)
const DAY = 86400;

const blankSheet = {
  supplier: "",
  product: "",
  quantity: "",
  unit: "pieces",
  unitPriceUsd: "",
  specs: "",
  packaging: "",
  inspection: "",
  shipBy: "",
  incoterm: "",
};

// Form fields -> the order sheet the agent fingerprints.
function toSheet(f) {
  const s = {
    supplier: f.supplier.trim(),
    product: f.product.trim(),
    quantity: Number(f.quantity),
    unit: f.unit.trim(),
    unitPriceUsd: f.unitPriceUsd.trim(),
    specs: f.specs.split("\n").map((x) => x.trim()).filter(Boolean),
    packaging: f.packaging.trim(),
    shipBy: f.shipBy,
    incoterm: f.incoterm.trim(),
  };
  if (f.inspection.trim()) s.inspection = f.inspection.trim();
  return s;
}

const FIELD_NAMES = { product: "Product", quantity: "Quantity", unit: "Unit", unitPriceUsd: "Unit price", specs: "Specifications", packaging: "Packaging", shipBy: "Ship-by date", incoterm: "Delivery terms", inspection: "Inspection" };
const fieldName = (f) => FIELD_NAMES[f] ?? (f.startsWith("specs[") ? `Specification line ${Number(f.slice(6, -1)) + 1}` : f);

export default function NewOrder({ wallet }) {
  const { account } = wallet;
  const [step, setStep] = useState(1);
  const [f, setF] = useState(blankSheet);
  const [supplierAddr, setSupplierAddr] = useState("");
  const [payee, setPayee] = useState(null);
  const [phoneConfirmed, setPhoneConfirmed] = useState(false);
  const [review, setReview] = useState(null);
  const [depositPct, setDepositPct] = useState(30);
  const [acceptDays, setAcceptDays] = useState(3);
  const [checkDays, setCheckDays] = useState(7);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [balance, setBalance] = useState(null);
  const [cngn, setCngn] = useState(null);
  const [payWith, setPayWith] = useState("usdt");
  const [fxRate, setFxRate] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    if (!account) return;
    usdtBalance(account).then(setBalance).catch(() => {});
    cngnBalance(account).then(setCngn).catch(() => {});
  }, [account]);

  // F9: check the payout address against this buyer's history.
  useEffect(() => {
    setPayee(null);
    setPhoneConfirmed(false);
    if (!account || !isAddress(supplierAddr) || !f.supplier.trim()) return;
    const t = setTimeout(() => api.checkPayee(account, f.supplier, supplierAddr).then(setPayee).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [account, supplierAddr, f.supplier]);

  // F7: live review of the sheet.
  const sheet = useMemo(() => toSheet(f), [f]);
  useEffect(() => {
    if (step !== 2 && step !== 3) return;
    const t = setTimeout(() => api.reviewSheet(sheet).then(setReview).catch((e) => setError(e.message)), 350);
    return () => clearTimeout(t);
  }, [sheet, step]);

  // Live naira price for whatever USDT the wallet is missing.
  const missing = review?.ready && balance !== null ? BigInt(review.totalUsdt) - balance : 0n;
  useEffect(() => {
    setFxRate(null);
    if (step !== 3 || payWith !== "naira" || missing <= 0n) return;
    const t = setTimeout(() => api.fxPreview(formatUnits(missing, 6)).then(setFxRate).catch((e) => setFxRate({ error: e.message })), 300);
    return () => clearTimeout(t);
  }, [step, payWith, missing]);

  if (!account) {
    return (
      <div className="stack">
        <h1>New order</h1>
        <p className="muted">Connect your wallet to start.</p>
        <button onClick={wallet.connect}>Connect wallet</button>
      </div>
    );
  }

  const total = review?.ready ? BigInt(review.totalUsdt) : 0n;
  const deposit = (total * BigInt(depositPct * 100)) / 10000n;
  const usd = (v) => Number(formatUnits(v, 6)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const now = Math.floor(Date.now() / 1000);
  const acceptBy = now + acceptDays * DAY;
  const shipBy = f.shipBy ? Math.floor(Date.parse(`${f.shipBy}T23:59:59Z`) / 1000) : 0;
  const datesOk = shipBy > acceptBy && shipBy <= now + 180 * DAY;
  const supplierOk = f.supplier.trim() && isAddress(supplierAddr) && supplierAddr.toLowerCase() !== account.toLowerCase() && payee && payee.status !== "invalid" && (payee.status !== "changed" || phoneConfirmed);
  const tooBig = total > MAX_ORDER;
  // F11: with naira, Arra converts only what the wallet is missing, at one firm Textile rate.
  const needUsdt = balance !== null && total > balance ? total - balance : 0n;
  const naira = payWith === "naira";
  const fxCngn = fxRate ? BigInt(fxRate.cngn) : null;
  const short = naira ? fxCngn !== null && cngn !== null && fxCngn > cngn : balance !== null && total > balance;
  const ngn = (v) => `₦${Number(formatUnits(v, 6)).toLocaleString("en-NG", { maximumFractionDigits: 0 })}`;

  async function lock() {
    setError("");
    setBusy("Saving the order sheet…");
    try {
      if (payee?.status === "changed") await api.confirmPayee(account, f.supplier, supplierAddr);
      const { ref } = await api.saveSheet(sheet);
      if (naira && needUsdt > 0n) {
        const words = {
          quote: "Getting a firm naira rate from Textile…",
          sign: "Sign the free message that proves this wallet is yours. It moves no money.",
          approve: "Allow the conversion to use your cNGN. Confirm in your wallet.",
          swap: "Convert naira to USDT at the locked rate. Confirm in your wallet.",
        };
        await convertNairaToUsdt(account, formatUnits(needUsdt, 6), api, (s) => setBusy(words[s]));
        setBalance(await usdtBalance(account));
      }
      const { id } = await lockOrder(
        { buyer: account, supplier: supplierAddr, total, depositBps: depositPct * 100, acceptBy, shipBy, disputeWindow: checkDays * DAY, ref },
        (s) => setBusy(s === "approve" ? "Step 1 of 2: allow Arra's vault to take the USDT. Confirm in your wallet." : "Step 2 of 2: lock the money. Confirm in your wallet."),
      );
      navigate(`/o/${id}?new=1`);
    } catch (e) {
      setError(e.shortMessage ?? e.message);
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="stack-lg narrow">
      <div className="stack">
        <h1>New order</h1>
        <ol className="stepper" aria-label="Steps">
          {["Supplier", "Order sheet", "Lock money"].map((s, i) => (
            <li key={s} className={step === i + 1 ? "on" : ""} aria-current={step === i + 1 ? "step" : undefined}>{i + 1} {s}</li>
          ))}
        </ol>
      </div>

      {step === 1 && (
        <section className="stack">
          <label className="field">
            <span>Supplier's business name</span>
            <input value={f.supplier} onChange={set("supplier")} placeholder="Guangzhou Hengli Textiles" autoComplete="organization" />
          </label>
          <label className="field">
            <span>Supplier's Celo wallet address</span>
            <input value={supplierAddr} onChange={(e) => setSupplierAddr(e.target.value.trim())} placeholder="0x…" spellCheck="false" autoCapitalize="off" className="num" />
            <small>They must accept the order from this same wallet, which proves it's theirs before any money reaches them.</small>
          </label>
          {supplierAddr && !isAddress(supplierAddr) ? <p className="note bad">That isn't a complete wallet address. It starts with 0x and has 42 characters.</p> : null}
          {isAddress(supplierAddr) && supplierAddr.toLowerCase() === account.toLowerCase() ? <p className="note bad">That's your own wallet. Use the supplier's.</p> : null}
          {payee?.status === "new" ? <p className="note">{payee.message}</p> : null}
          {payee?.status === "known" ? <p className="note ok">{payee.message}</p> : null}
          {payee?.status === "changed" ? (
            <div className="note bad stack">
              <p><strong>New address for a known supplier.</strong> {payee.message}</p>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input type="checkbox" checked={phoneConfirmed} onChange={(e) => setPhoneConfirmed(e.target.checked)} style={{ width: 20, marginTop: 3 }} />
                <span>I called them on a number I already had, and they confirmed this new address.</span>
              </label>
            </div>
          ) : null}
          <button disabled={!supplierOk} onClick={() => setStep(2)}>Next: order sheet</button>
        </section>
      )}

      {step === 2 && (
        <section className="stack">
          <p className="muted small">Write it so a stranger could check the goods against it. This exact sheet is fingerprinted into the order, so neither side can change it later.</p>
          <label className="field"><span>Product</span><input value={f.product} onChange={set("product")} placeholder="Men's cotton T-shirts, crew neck" /></label>
          <div className="row">
            <label className="field"><span>Quantity</span><input inputMode="numeric" value={f.quantity} onChange={set("quantity")} placeholder="500" /></label>
            <label className="field"><span>Unit</span><input value={f.unit} onChange={set("unit")} placeholder="pieces" /></label>
          </div>
          <label className="field"><span>Price per unit (USD)</span><input inputMode="decimal" value={f.unitPriceUsd} onChange={set("unitPriceUsd")} placeholder="2.35" /></label>
          <label className="field">
            <span>Specifications</span>
            <textarea value={f.specs} onChange={set("specs")} placeholder={"180 gsm, 100% combed cotton\nSizes: 150 M, 200 L, 150 XL\nColour: Pantone 19-4052 navy"} />
            <small>One per line. Use numbers: weight, size, material, colour code.</small>
          </label>
          <label className="field"><span>Packaging</span><input value={f.packaging} onChange={set("packaging")} placeholder="50 per carton, each in a polybag" /></label>
          <label className="field"><span>How you'll check the goods (optional)</span><input value={f.inspection} onChange={set("inspection")} placeholder="Photos of 5 random cartons before shipping" /></label>
          <div className="row">
            <label className="field"><span>Ship by</span><input type="date" value={f.shipBy} onChange={set("shipBy")} /></label>
            <label className="field"><span>Delivery terms</span><input value={f.incoterm} onChange={set("incoterm")} placeholder="FOB Guangzhou" /></label>
          </div>
          {review && !review.ready ? (
            <div className="note bad">
              <p style={{ marginBottom: 6 }}><strong>Fix these before locking money:</strong></p>
              <ul className="issues">
                {review.issues.map((i, k) => <li key={k}>{fieldName(i.field)}: {i.problem}</li>)}
              </ul>
            </div>
          ) : null}
          {review?.ready ? <p className="note ok">Clear and specific. Order total ${usd(BigInt(review.totalUsdt))}.</p> : null}
          <div className="row">
            <button className="secondary" onClick={() => setStep(1)}>Back</button>
            <button disabled={!review?.ready} onClick={() => setStep(3)}>Next: lock money</button>
          </div>
        </section>
      )}

      {step === 3 && review?.ready && (
        <section className="stack">
          <div className="block stack">
            <div className="row">
              <div><p className="muted small">Deposit to {f.supplier}</p><p className="num" style={{ fontSize: 22, fontWeight: 700 }}>${usd(deposit)}</p></div>
              <div><p className="muted small">Balance kept locked</p><p className="num" style={{ fontSize: 22, fontWeight: 700 }}>${usd(total - deposit)}</p></div>
            </div>
            <label className="field">
              <span>Deposit: {depositPct}%</span>
              <input type="range" min="0" max="90" step="5" value={depositPct} onChange={(e) => setDepositPct(Number(e.target.value))} />
              <small>Paid when they accept. Chinese suppliers usually ask for 30%. At least 10% always stays locked.</small>
            </label>
          </div>
          <fieldset className="block stack payfrom">
            <legend>Pay from</legend>
            <label className="choice">
              <input type="radio" name="payWith" checked={!naira} onChange={() => setPayWith("usdt")} />
              <span><strong>USDT in my wallet</strong><small className="num">{balance !== null ? `You have $${usd(balance)}` : "Checking balance…"}</small></span>
            </label>
            <label className="choice">
              <input type="radio" name="payWith" checked={naira} onChange={() => setPayWith("naira")} />
              <span><strong>Naira (cNGN), converted now</strong><small className="num">{cngn !== null ? `You have ${ngn(cngn)} cNGN` : "Checking balance…"}. One firm rate from Textile FX, locked for the whole order.</small></span>
            </label>
            {naira && needUsdt === 0n ? <p className="note ok">Your USDT already covers this order, so nothing needs converting.</p> : null}
            {naira && needUsdt > 0n && fxRate && !fxRate.error ? (
              <p className="note num">
                {ngn(BigInt(fxRate.cngn))} becomes ${usd(needUsdt)} USDT at about ₦{Math.round(fxRate.ngnPerUsd).toLocaleString("en-NG")} per $1, fee included. You'll confirm the final rate before anything moves.
              </p>
            ) : null}
            {naira && fxRate?.error ? <p className="note bad">Couldn't get a naira rate: {fxRate.error}</p> : null}
          </fieldset>
          <div className="row">
            <label className="field">
              <span>Supplier must accept within</span>
              <select value={acceptDays} onChange={(e) => setAcceptDays(Number(e.target.value))}>
                {[1, 2, 3, 5, 7, 14].map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Your time to check goods</span>
              <select value={checkDays} onChange={(e) => setCheckDays(Number(e.target.value))}>
                {[1, 3, 7, 14, 21, 30].map((d) => <option key={d} value={d}>{d} day{d > 1 ? "s" : ""}</option>)}
              </select>
            </label>
          </div>
          <ul className="small muted stack" style={{ paddingLeft: 18, margin: 0 }}>
            <li>Not accepted in {acceptDays} day{acceptDays > 1 ? "s" : ""}: all ${usd(total)} comes back to you.</li>
            <li>Not shipped by {f.shipBy}: the ${usd(total - deposit)} balance comes back to you.</li>
            <li>No problem raised within {checkDays} day{checkDays > 1 ? "s" : ""} of shipping: the balance pays the supplier.</li>
          </ul>
          {!datesOk ? <p className="note bad">The ship-by date must be after the accept deadline and within 180 days.</p> : null}
          {tooBig ? <p className="note bad">While Arra is new, orders are capped at $50. Lower the quantity or split it into several orders.</p> : null}
          {short && !tooBig && !naira ? <p className="note bad">Your wallet has ${usd(balance)} USDT; this order needs ${usd(total)}. Choose naira above to convert the rest.</p> : null}
          {short && !tooBig && naira ? <p className="note bad">You need {ngn(fxCngn)} cNGN for this order and have {ngn(cngn)}.</p> : null}
          {error ? <p className="note bad">{error}</p> : null}
          {busy ? <p className="note">{busy}</p> : null}
          <div className="row">
            <button className="secondary" disabled={!!busy} onClick={() => setStep(2)}>Back</button>
            <button className="money" disabled={!!busy || !datesOk || tooBig || short} onClick={lock}>{naira && needUsdt > 0n && fxCngn ? `Convert ${ngn(fxCngn)} and lock $${usd(total)}` : `Lock $${usd(total)}`}</button>
          </div>
        </section>
      )}
    </div>
  );
}
