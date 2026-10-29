import { useEffect, useMemo, useState } from "react";
import { formatUnits, isAddress, parseEther } from "viem";
import { api } from "../api.js";
import { lockOrder, usdtBalance, cngnBalance, convertNairaToUsdt, celoBalance, sendCelo, sendUsdt, GAS_ENOUGH } from "../chain.js";
import { withToast } from "../toast.jsx";
import { navigate } from "../App.jsx";
import { toast } from "../toast.jsx";
import Icon from "../Icon.jsx";

const MAX_ORDER = 50_000_000n; // $50 cap while Arra is new (set in the vault)
const DAY = 86400;

// What kind of deal: the wording and required fields adapt; the contract is the same.
const KINDS = {
  goods: {
    label: "Goods shipped to me", short: "Shipped goods", hint: "Imports and anything sent by sea, air or courier", icon: "ship",
    payee: "Supplier", payeeName: "Supplier's business name", namePh: "Guangzhou Hengli Textiles",
    product: "What are you buying?", productPh: "Men's cotton T-shirts, crew neck", qtyPh: "500", units: ["pieces", "cartons", "kg", "metres", "sets", "pairs", "dozen"],
    pricePh: "2.35", details: ["Size", "Colour", "Material", "Weight", "Model", "Per carton"],
    detailPh: { Size: "150 M, 200 L, 150 XL", Colour: "Navy, Pantone 19-4052", Material: "100% combed cotton, 180 gsm", Weight: "Under 15 kg per carton", Model: "SKU TS-180-NV", "Per carton": "50 pieces, each in a polybag" },
    checkLabel: "How you'll check the goods", checkPh: "Photos of 5 random cartons before shipping",
    dateLabel: "Ship by", notDone: "Not shipped by", depositHint: "Chinese suppliers usually ask for 30%.",
  },
  custom: {
    label: "Made to order", short: "Made to order", hint: "Tailoring, furniture, fabrication, event decor", icon: "sheet",
    payee: "Maker", payeeName: "Maker's business name", namePh: "Ade's Tailoring",
    product: "What's being made?", productPh: "Agbada, 3-piece, aso-oke", qtyPh: "1", units: ["piece", "set", "pair", "metres"],
    pricePh: "35", details: ["Measurements", "Colour", "Material", "Finish", "Fitting date"],
    detailPh: { Measurements: "Chest 42 in, length 56 in", Colour: "Navy with gold embroidery", Material: "Aso-oke", Finish: "Hand-stitched hems", "Fitting date": "20 November" },
    checkLabel: "How you'll check it", checkPh: "Fitting before collection",
    dateLabel: "Ready by", notDone: "Not delivered by", depositHint: "Makers often ask for half up front to buy materials.",
  },
  service: {
    label: "A service or project", short: "Service", hint: "Freelance work, building projects, events, repairs", icon: "code",
    payee: "Provider", payeeName: "Provider's name", namePh: "Tunde Studio",
    product: "What's being delivered?", productPh: "Logo and brand kit", qtyPh: "1", units: ["project", "hours", "days", "items"],
    pricePh: "40", details: ["Deliverables", "Revisions", "File format", "Meetings"],
    detailPh: { Deliverables: "3 logo concepts", Revisions: "2 rounds of changes", "File format": "SVG and PNG", Meetings: "Weekly 30-minute call" },
    checkLabel: "How you'll check it", checkPh: "Review call before final files",
    dateLabel: "Deliver by", notDone: "Not delivered by", depositHint: "Use the balance as milestones: release part at each stage.",
  },
};

// Plain-language shipping terms for imports (the code in brackets is what suppliers expect).
const TERMS = [
  ["FOB", "Supplier loads it onto the ship at their port"],
  ["CIF", "Supplier pays shipping and insurance to my port"],
  ["EXW", "I collect it from the supplier's factory"],
  ["DDP", "Delivered to my door, duties paid"],
];

const blankSheet = {
  kind: "goods",
  supplier: "",
  product: "",
  quantity: "",
  unit: "pieces",
  unitPriceUsd: "",
  details: [{ label: "Size", value: "" }, { label: "Material", value: "" }],
  packaging: "",
  inspection: "",
  shipBy: "",
  term: "FOB",
  port: "",
  handover: "",
};

// Form fields -> the order sheet the agent fingerprints.
function toSheet(f) {
  const s = {
    kind: f.kind,
    supplier: f.supplier.trim(),
    product: f.product.trim(),
    quantity: Number(f.quantity),
    unit: f.unit.trim(),
    unitPriceUsd: f.unitPriceUsd.trim(),
    specs: f.details.filter((d) => d.value.trim()).map((d) => (d.label ? `${d.label}: ${d.value.trim()}` : d.value.trim())),
    shipBy: f.shipBy,
  };
  if (f.kind === "goods") {
    const [code, words] = TERMS.find(([c]) => c === f.term) ?? TERMS[0];
    s.incoterm = `${code}${f.port.trim() ? ` ${f.port.trim()}` : ""} (${words.toLowerCase()})`;
  } else if (f.handover.trim()) s.incoterm = f.handover.trim();
  if (f.packaging.trim()) s.packaging = f.packaging.trim();
  if (f.inspection.trim()) s.inspection = f.inspection.trim();
  return s;
}

const FIELD_NAMES = { product: "What you're buying", quantity: "Quantity", unit: "Unit", unitPriceUsd: "Price each", specs: "Details", packaging: "Packaging", shipBy: "Date", incoterm: "Shipping terms", inspection: "How you'll check" };
const fieldName = (f) => FIELD_NAMES[f] ?? (f.startsWith("specs[") ? `Detail ${Number(f.slice(6, -1)) + 1}` : f);
const isoIn = (days) => new Date(Date.now() + days * DAY * 1000).toISOString().slice(0, 10);

function Chips({ value, options, onChange, label }) {
  return (
    <div className="chips wrap" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? "chip on" : "chip"} onClick={() => onChange(v)}>{text}</button>
      ))}
    </div>
  );
}

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
  // Gas for the supplier: sent from the buyer's own wallet right after the order is locked.
  const [supGas, setSupGas] = useState(null);
  const [myCelo, setMyCelo] = useState(null);
  const [gasPick, setGasPick] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const K = KINDS[f.kind];
  const setKind = (k) => setF({ ...f, kind: k, unit: KINDS[k].units[0], details: KINDS[k].details.slice(0, 2).map((label) => ({ label, value: "" })) });
  const setDetail = (i, value) => setF({ ...f, details: f.details.map((d, j) => (j === i ? { ...d, value } : d)) });
  const addDetail = (label) => setF({ ...f, details: [...f.details, { label, value: "" }] });
  const removeDetail = (i) => setF({ ...f, details: f.details.filter((_, j) => j !== i) });
  const liveTotal = /^\d+$/.test(f.quantity) && /^\d+(\.\d{1,6})?$/.test(f.unitPriceUsd) ? Number(f.quantity) * Number(f.unitPriceUsd) : null;

  useEffect(() => {
    if (!account) return;
    usdtBalance(account).then(setBalance).catch(() => {});
    cngnBalance(account).then(setCngn).catch(() => {});
    celoBalance(account.toLowerCase()).then(setMyCelo).catch(() => {});
  }, [account]);

  // Does the supplier's wallet have anything to pay network fees with?
  useEffect(() => {
    setSupGas(null);
    setGasPick(null);
    if (!isAddress(supplierAddr, { strict: false })) return;
    celoBalance(supplierAddr.toLowerCase()).then(setSupGas).catch(() => {});
  }, [supplierAddr]);

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

  // If the delivery date is close, shorten the accept window automatically so the
  // supplier's accept deadline always comes before the delivery date.
  useEffect(() => {
    if (!f.shipBy) return;
    const ship = Date.parse(`${f.shipBy}T23:59:59Z`) / 1000;
    const now = Date.now() / 1000;
    const fits = [7, 3, 1].filter((d) => now + d * DAY < ship);
    if (fits.length && now + acceptDays * DAY >= ship) setAcceptDays(fits[0]);
  }, [f.shipBy]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const needsGas = supGas !== null && supGas < GAS_ENOUGH;
  const canCelo = (a) => myCelo !== null && myCelo >= parseEther(a) + parseEther("0.002");
  const gasDefault = canCelo("0.02") ? "0.02" : !naira && balance !== null && balance >= total + 100_000n ? "usdt" : "none";
  const gas = needsGas ? gasPick ?? gasDefault : "none";
  const gasUsdt = gas === "usdt" ? 100_000n : 0n;
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
        // Some network nodes lag a second or two behind; wait until the USDT shows up.
        setBusy("Converted. Waiting for the USDT to show in your wallet…");
        let b = await usdtBalance(account);
        for (let i = 0; i < 15 && b < total; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          b = await usdtBalance(account);
        }
        setBalance(b);
      }
      // One notification per wallet confirmation, so the buyer always knows what's happening.
      let current = null;
      const { id } = await lockOrder(
        { buyer: account, supplier: supplierAddr, total, depositBps: depositPct * 100, acceptBy, shipBy, disputeWindow: checkDays * DAY, ref },
        (s) => {
          if (current) current.update({ kind: "ok", title: "USDT allowed", spinner: false });
          setBusy(s === "approve" ? "Step 1 of 2: allow Arra's vault to take the USDT. Confirm in your wallet." : "Step 2 of 2: lock the money. Confirm in your wallet.");
          current = toast({ title: s === "approve" ? "Step 1 of 2: allow the USDT. Confirm in your wallet" : `Step 2 of 2: lock $${usd(total)}. Confirm in your wallet`, spinner: true });
        },
        (s, hash) => current?.update({ title: s === "approve" ? "Allowing USDT…" : `Locking $${usd(total)}…`, hash }),
      ).catch((e) => {
        const msg = e.shortMessage ?? e.message ?? "";
        current?.update({ kind: "bad", title: /reject|denied|cancel/i.test(msg) ? "Cancelled. Nothing was locked." : "Didn't go through", body: /reject|denied|cancel/i.test(msg) ? null : msg, spinner: false });
        throw e;
      });
      current?.update({ kind: "ok", title: `Order #${id} locked. $${usd(total)} is safe in the vault`, body: "Send your supplier the link on the next screen.", spinner: false });
      // Gas from the buyer's wallet. If it fails, the order still stands and the
      // order page offers the same top-up again.
      if (gas !== "none") {
        setBusy("Sending your supplier a little gas. Confirm in your wallet.");
        const to = supplierAddr.toLowerCase();
        await withToast((cb) => (gas === "usdt" ? sendUsdt(to, "0.10", cb) : sendCelo(to, gas, cb)), {
          confirm: "Send gas to your supplier. Confirm in your wallet",
          pending: "Sending gas…",
          done: `Sent ${gas === "usdt" ? "$0.10 USDT" : `${gas} CELO`} to your supplier for fees`,
        }).catch(() => {});
      }
      navigate(`/o/${id}?new=1`);
    } catch (e) {
      setError(e.shortMessage ?? e.message);
    } finally {
      setBusy("");
    }
  }

  const unusedDetails = K.details.filter((d) => !f.details.some((x) => x.label === d));

  return (
    <div className="stack-lg narrow">
      <div className="stack">
        <h1>New order</h1>
        <ol className="stepper" aria-label="Steps">
          {["Who you pay", "What you're buying", "Lock money"].map((t, i) => (
            <li key={t} className={step === i + 1 ? "on" : step > i + 1 ? "done" : ""} aria-current={step === i + 1 ? "step" : undefined}>{i + 1} {t}</li>
          ))}
        </ol>
      </div>

      {step === 1 && (
        <section className="stack">
          <div className="kind-cards" role="radiogroup" aria-label="What kind of deal?">
            {Object.entries(KINDS).map(([k, v]) => (
              <button key={k} type="button" role="radio" aria-checked={f.kind === k} className={f.kind === k ? "kind-card on" : "kind-card"} onClick={() => setKind(k)}>
                <Icon name={v.icon} size={22} />
                <strong>{v.short}</strong>
                <small>{v.hint}</small>
              </button>
            ))}
          </div>
          <label className="field">
            <span>{K.payeeName}</span>
            <input value={f.supplier} onChange={set("supplier")} placeholder={K.namePh} autoComplete="organization" />
          </label>
          <label className="field">
            <span>{K.payee}'s wallet address on Celo</span>
            <div className="with-btn">
              <input value={supplierAddr} onChange={(e) => setSupplierAddr(e.target.value.trim())} placeholder="0x…" spellCheck="false" autoCapitalize="off" className="num" />
              {navigator.clipboard?.readText ? (
                <button type="button" className="secondary small-btn" onClick={() => navigator.clipboard.readText().then((t) => setSupplierAddr(t.trim())).catch(() => {})}>Paste</button>
              ) : null}
            </div>
            <small>Ask them to send it to you. They'll accept the order from this same wallet, which proves it's really theirs.</small>
          </label>
          {supplierAddr && !isAddress(supplierAddr) ? <p className="note bad">That isn't a complete wallet address. It starts with 0x and has 42 characters.</p> : null}
          {isAddress(supplierAddr) && supplierAddr.toLowerCase() === account.toLowerCase() ? <p className="note bad">That's your own wallet. Use the {K.payee.toLowerCase()}'s.</p> : null}
          {payee?.status === "new" ? <p className="note">{payee.message}</p> : null}
          {payee?.status === "known" ? <p className="note ok">{payee.message}</p> : null}
          {payee?.status === "changed" ? (
            <div className="note bad stack">
              <p><strong>New address for a known {K.payee.toLowerCase()}.</strong> {payee.message}</p>
              <label style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                <input type="checkbox" checked={phoneConfirmed} onChange={(e) => setPhoneConfirmed(e.target.checked)} style={{ width: 20, marginTop: 3 }} />
                <span>I called them on a number I already had, and they confirmed this new address.</span>
              </label>
            </div>
          ) : null}
          <button disabled={!supplierOk} onClick={() => setStep(2)}>Next</button>
        </section>
      )}

      {step === 2 && (
        <section className="stack">
          <label className="field"><span>{K.product}</span><input value={f.product} onChange={set("product")} placeholder={K.productPh} /></label>
          <div className="qty-row">
            <label className="field"><span>How many</span><input inputMode="numeric" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value.replace(/[^\d]/g, "") })} placeholder={K.qtyPh} /></label>
            <label className="field"><span>Unit</span>
              <select value={f.unit} onChange={set("unit")}>{K.units.map((u) => <option key={u} value={u}>{u}</option>)}</select>
            </label>
            <label className="field"><span>Price each ($)</span><input inputMode="decimal" value={f.unitPriceUsd} onChange={(e) => setF({ ...f, unitPriceUsd: e.target.value.replace(/[^\d.]/g, "") })} placeholder={K.pricePh} /></label>
          </div>
          {liveTotal !== null ? <p className="live-total num">Total <strong>${liveTotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></p> : null}

          <div className="field">
            <span className="field-label">Details the {K.payee.toLowerCase()} must match</span>
            <div className="details">
              {f.details.map((d, i) => (
                <div key={i} className="detail-row">
                  <span className="detail-label">{d.label || "Detail"}</span>
                  <input value={d.value} onChange={(e) => setDetail(i, e.target.value)} placeholder={K.detailPh[d.label] ?? "Be specific: numbers, colours, materials"} aria-label={d.label || "Detail"} />
                  <button type="button" className="detail-x" aria-label={`Remove ${d.label || "detail"}`} onClick={() => removeDetail(i)}>×</button>
                </div>
              ))}
            </div>
            <div className="chips wrap add-chips">
              {unusedDetails.map((d) => <button key={d} type="button" className="chip" onClick={() => addDetail(d)}>+ {d}</button>)}
              <button type="button" className="chip" onClick={() => addDetail("")}>+ Other</button>
            </div>
            <small>Use numbers and exact words. "Good quality" can't be checked; "180 gsm cotton" can.</small>
          </div>

          <div className="field">
            <span className="field-label">{K.dateLabel}</span>
            <Chips label={K.dateLabel} value={[7, 14, 30, 60].map(isoIn).includes(f.shipBy) ? f.shipBy : null} onChange={(v) => setF({ ...f, shipBy: v })} options={[[isoIn(7), "1 week"], [isoIn(14), "2 weeks"], [isoIn(30), "1 month"], [isoIn(60), "2 months"]]} />
            <input type="date" value={f.shipBy} onChange={set("shipBy")} aria-label={`${K.dateLabel}, exact date`} />
          </div>

          {f.kind === "goods" ? (
            <div className="field">
              <span className="field-label">Who pays for shipping?</span>
              <div className="term-list" role="radiogroup" aria-label="Shipping terms">
                {TERMS.map(([code, words]) => (
                  <label key={code} className={f.term === code ? "term on" : "term"}>
                    <input type="radio" name="term" checked={f.term === code} onChange={() => setF({ ...f, term: code })} />
                    <span>{words}</span><em>{code}</em>
                  </label>
                ))}
              </div>
            </div>
          ) : null}

          <details className="more">
            <summary>More details (optional)</summary>
            <div className="stack">
              {f.kind === "goods" ? <label className="field"><span>Port or city</span><input value={f.port} onChange={set("port")} placeholder="Guangzhou" /></label> : null}
              {f.kind === "custom" ? <label className="field"><span>Collection or delivery</span><input value={f.handover} onChange={set("handover")} placeholder="Delivered to Lekki Phase 1" /></label> : null}
              {f.kind !== "service" ? <label className="field"><span>Packaging</span><input value={f.packaging} onChange={set("packaging")} placeholder="50 per carton, each in a polybag" /></label> : null}
              <label className="field"><span>{K.checkLabel}</span><input value={f.inspection} onChange={set("inspection")} placeholder={K.checkPh} /></label>
            </div>
          </details>

          {review && !review.ready && (f.product || f.quantity || f.unitPriceUsd) ? (
            <div className="note bad">
              <p style={{ marginBottom: 6 }}><strong>Almost there:</strong></p>
              <ul className="issues">
                {review.issues.map((i, k) => <li key={k}>{fieldName(i.field)}: {i.problem === "missing" ? "please fill this in" : i.problem}</li>)}
              </ul>
            </div>
          ) : null}
          {review?.ready ? <p className="note ok">Clear and specific. This sheet will be fingerprinted with the order, so neither side can change it later.</p> : null}
          <div className="row">
            <button className="secondary" onClick={() => setStep(1)}>Back</button>
            <button disabled={!review?.ready} onClick={() => setStep(3)}>Next</button>
          </div>
        </section>
      )}

      {step === 3 && review?.ready && (
        <section className="stack">
          <div className="block stack summary">
            <p className="muted small">{f.quantity} {f.unit} of {f.product}, from {f.supplier}</p>
            <div className="row">
              <div><p className="muted small">Deposit when they accept</p><p className="num big-num">${usd(deposit)}</p></div>
              <div><p className="muted small">Kept locked until {f.kind === "goods" ? "shipping" : "delivery"}</p><p className="num big-num hl">${usd(total - deposit)}</p></div>
            </div>
            <div className="field">
              <span className="field-label">Deposit</span>
              <Chips label="Deposit" value={depositPct} onChange={setDepositPct} options={[[0, "None"], [20, "20%"], [30, "30%"], [50, "50%"]]} />
              <small>{K.depositHint}</small>
            </div>
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

          {needsGas ? (
            <div className="block stack">
              <div className="field">
                <span className="field-label">Gas for your {K.payee.toLowerCase()}</span>
                <small>Their wallet has no CELO for network fees, so they can't accept yet. Send a little from your wallet with this order. 0.02 CELO covers dozens of actions.</small>
                <div className="chips wrap" role="radiogroup" aria-label="Gas">
                  {[["0.02", "0.02 CELO", canCelo("0.02")], ["0.05", "0.05 CELO", canCelo("0.05")], ["usdt", "$0.10 USDT", !naira], ["none", "Don't send", true]].map(([v, text, ok]) => (
                    <button key={v} type="button" role="radio" aria-checked={gas === v} disabled={!ok} className={gas === v ? "chip on" : "chip"} onClick={() => setGasPick(v)}>{text}</button>
                  ))}
                </div>
                <small>{myCelo !== null && !canCelo("0.02") ? "You have no CELO, so CELO options are off. USDT works as gas only if they use MiniPay or Valora. " : "CELO works in every wallet. USDT works as gas only in MiniPay and Valora. "}It's sent right after the order is locked, as its own small transaction.</small>
              </div>
            </div>
          ) : null}

          <div className="block stack">
            <div className="field">
              <span className="field-label">{K.payee} must accept within</span>
              <Chips label="Accept within" value={acceptDays} onChange={setAcceptDays} options={[[1, "1 day"], [3, "3 days"], [7, "7 days"]]} />
            </div>
            <div className="field">
              <span className="field-label">Your time to check it after {f.kind === "goods" ? "shipping" : "delivery"}</span>
              <Chips label="Check period" value={checkDays} onChange={setCheckDays} options={[[3, "3 days"], [7, "7 days"], [14, "14 days"]]} />
            </div>
            <ul className="small muted stack" style={{ paddingLeft: 18, margin: 0 }}>
              <li>Not accepted in {acceptDays} day{acceptDays > 1 ? "s" : ""}: all ${usd(total)} comes back to you.</li>
              <li>{K.notDone} {new Date(`${f.shipBy}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}: the ${usd(total - deposit)} balance comes back to you.</li>
              <li>No problem raised within {checkDays} days: the balance pays the {K.payee.toLowerCase()}.</li>
            </ul>
          </div>

          {!datesOk && shipBy > 0 && shipBy <= acceptBy ? (
            <p className="note bad">
              The {K.payee.toLowerCase()} has until {new Date(acceptBy * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} to accept, but the {K.dateLabel.toLowerCase()} date is {new Date(shipBy * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}. Choose a shorter accept time above, or go back and pick a later date.
            </p>
          ) : null}
          {!datesOk && shipBy > acceptBy ? <p className="note bad">The {K.dateLabel.toLowerCase()} date must be within 180 days.</p> : null}
          {!datesOk && !shipBy ? <p className="note bad">Go back and pick a {K.dateLabel.toLowerCase()} date.</p> : null}
          {tooBig ? <p className="note bad">While Arra is new, orders are capped at $50. Lower the quantity or split it into several orders.</p> : null}
          {short && !tooBig && !naira ? <p className="note bad">Your wallet has ${usd(balance)} USDT; this order needs ${usd(total)}. Choose naira above to convert the rest.</p> : null}
          {!short && !tooBig && !naira && gasUsdt > 0n && balance !== null && total + gasUsdt > balance ? <p className="note bad">The order plus $0.10 gas is more than your ${usd(balance)} USDT. Pick a CELO option or "Don't send".</p> : null}
          {short && !tooBig && naira ? <p className="note bad">You need {ngn(fxCngn)} cNGN for this order and have {ngn(cngn)}.</p> : null}
          {error ? <p className="note bad">{error}</p> : null}
          {busy ? <p className="note">{busy}</p> : null}
          <div className="row">
            <button className="secondary" disabled={!!busy} onClick={() => setStep(2)}>Back</button>
            <button className="money" disabled={!!busy || !datesOk || tooBig || short || (!naira && balance !== null && total + gasUsdt > balance)} onClick={lock}>{naira && needUsdt > 0n && fxCngn ? `Convert ${ngn(fxCngn)} and lock $${usd(total)}` : `Lock $${usd(total)}`}{gas !== "none" ? " + send gas" : ""}</button>
          </div>
        </section>
      )}
    </div>
  );
}
