import { useEffect, useState } from "react";
import { formatUnits } from "viem";
import { api } from "../api.js";
import { VAULT, EXPLORER, currentVault } from "../chain.js";
import * as chain from "../chain.js";
import Icon from "../Icon.jsx";
import { navigate } from "../App.jsx";

const fmtUsd = (n) => Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNgn = (n) => `₦${Math.round(n).toLocaleString("en-NG")}`;
const units = (v) => Number(formatUnits(BigInt(v), 6));
const go = (path) => (e) => {
  e.preventDefault();
  navigate(path);
};

// Wise-style live calculator: what the buyer pays in naira, what the supplier
// gets now, and what stays locked.
function Calculator() {
  const [amount, setAmount] = useState("50");
  const [cap, setCap] = useState(50);
  useEffect(() => {
    currentVault().then(() => setCap(Number(chain.MAX_ORDER) / 1e6));
  }, []);
  const [pct, setPct] = useState(30);
  const [fx, setFx] = useState(null);
  const total = /^\d+(\.\d{0,2})?$/.test(amount) ? Number(amount) : 0;
  const deposit = (total * pct) / 100;

  useEffect(() => {
    setFx(null);
    if (!(total >= 1)) return;
    const t = setTimeout(() => api.fxPreview(total.toFixed(2)).then(setFx).catch(() => setFx({ error: true })), 350);
    return () => clearTimeout(t);
  }, [total]);

  return (
    <div className="calc" aria-label="Order calculator">
      <label className="calc-row calc-input">
        <span>Order total</span>
        <div className="calc-amount">
          <span className="cur">$</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} aria-label="Order total in US dollars" />
          <span className="tag">USDT</span>
        </div>
      </label>
      <div className="calc-row">
        <span>Deposit</span>
        <div className="chips" role="radiogroup" aria-label="Deposit">
          {[20, 30, 50].map((p) => (
            <button key={p} role="radio" aria-checked={pct === p} className={pct === p ? "chip on" : "chip"} onClick={() => setPct(p)}>{p}%</button>
          ))}
        </div>
      </div>
      <dl className="calc-out">
        <div>
          <dt>You pay in naira</dt>
          <dd className="num">{fx && !fx.error ? fmtNgn(units(fx.cngn)) : fx?.error ? "Rate unavailable" : total >= 1 ? "…" : "—"}</dd>
        </div>
        <div>
          <dt>Supplier gets when they accept</dt>
          <dd className="num">${fmtUsd(deposit)}</dd>
        </div>
        <div className="hl">
          <dt>Locked until it ships</dt>
          <dd className="num">${fmtUsd(total - deposit)}</dd>
        </div>
      </dl>
      <p className="calc-note">
        {fx && !fx.error ? <>Live rate from Textile FX: <strong className="num">{fmtNgn(fx.ngnPerUsd)}</strong> per $1, fee included. </> : null}
        If it doesn't ship on time, the balance comes back to you automatically.
      </p>
      <a href="/new" className="button money" onClick={go("/new")}>Start this order</a>
      {total > cap ? <p className="calc-cap">While Arra is new, each order is capped at ${cap.toLocaleString("en-US")}.</p> : null}
    </div>
  );
}

function Stats() {
  const [s, setS] = useState(null);
  const [rate, setRate] = useState(null);
  useEffect(() => {
    api.stats().then(setS).catch(() => {});
    api.fxPreview("100").then((r) => setRate(r.ngnPerUsd)).catch(() => {});
  }, []);
  if (!s && !rate) return null;
  return (
    <section className="stats" aria-label="Live on Celo">
      <div><strong className="num">{s ? s.orders : "—"}</strong><span>orders on Celo mainnet</span></div>
      <div><strong className="num">${s ? fmtUsd(units(s.lockedNow)) : "—"}</strong><span>locked for suppliers right now</span></div>
      <div><strong className="num">${s ? fmtUsd(units(s.totalValue)) : "—"}</strong><span>order value protected</span></div>
      <div><strong className="num">{rate ? fmtNgn(rate) : "—"}</strong><span>per $1 on Textile FX, live</span></div>
    </section>
  );
}

const CASES = [
  {
    big: "Escrow",
    text: "is what foreign suppliers asked Nigerian importers for in 2023, instead of bank letters of credit.",
    src: "BusinessDay, Sep 2023",
    href: "https://businessday.ng/business-economy/article/trouble-looms-as-foreign-suppliers-reject-letters-of-credit/",
  },
  {
    big: "$3.05bn",
    text: "lost in 2025 to email fraud, much of it \"our bank details have changed\" messages to buyers.",
    src: "FBI IC3 2025 report",
    href: "https://www.mcdonaldhopkins.com/insights/news/the-sobering-truth-of-the-fbis-2025-internet-crime-complaint-center-report",
  },
  {
    big: "₦471 → ₦755",
    text: "per dollar in one day in June 2023. Importers who'd paid a deposit needed far more naira for the balance.",
    src: "AllAfrica",
    href: "https://allafrica.com/stories/202506100251.html",
  },
];

const STEPS = [
  ["lock", "Lock the money", "Write what you're buying and lock the total in USDT, or pay from naira at one firm Textile FX rate. It sits in a public contract, not with Arra."],
  ["signature", "Supplier accepts", "They open your link (in English or Chinese), accept from their own wallet and get the deposit at once. The balance stays locked."],
  ["check", "Pay when it's right", "When the goods ship or arrive, you pay the balance, all at once or in parts. If they never accept or never ship, it comes back to you automatically."],
];

const FEATURES = [
  ["coins", "Deposit paid on acceptance", "Suppliers get working capital the moment they accept, which is why they'll agree to use Arra."],
  ["clock", "Automatic refunds", "Not accepted or not shipped in time? The money goes back to you without asking anyone."],
  ["rate", "Rate locked on day one", "Pay from naira once, at a firm Textile FX rate. A weaker naira next month can't touch it."],
  ["signature", "The right wallet, proven", "Your supplier connects and accepts from their own wallet, so a look-alike address in a chat can't steal the payment."],
  ["split", "Problems settle, not stall", "Report a problem with a photo and offer a split. An offer ignored for 7 days goes through; nothing stays stuck."],
  ["alarm", "Bank-detail change alarm", "If a known supplier suddenly wants paying somewhere new, Arra stops you until you've confirmed by phone."],
];

const USES = [
  ["ship", "Imports from China", "The deposit goes to the factory when they accept; the balance waits for the container."],
  ["wallet", "Diaspora projects at home", "Fund a build or a business in Nigeria and release money stage by stage as the work is done, not on promises."],
  ["sheet", "Made-to-order", "Furniture, signage, fabrication, custom outfits. Half for materials up front, the rest when it's ready and checked."],
  ["clock", "Events", "Caterers, decorators, DJs, venues. Book with a deposit, pay the balance after the day, settle a split if something falls short."],
  ["code", "Freelance and agency work", "Milestones without a platform holding your money, for local clients or clients abroad."],
  ["signature", "Online vendors", "A safer alternative to pay-on-delivery. The fingerprinted order sheet settles \"what I ordered vs what I got\"."],
];

const FAQ = [
  ["Who holds the money?", "An open contract on Celo. Not Arra, not a bank, not the supplier. Its code is public and verified, and its rules decide where money goes: to the supplier when you release it, or back to you if the deadlines pass."],
  ["Can Arra take or freeze my money?", "No. The contract owner can only pause new orders or change the per-order limit. It has no way to move locked money."],
  ["What if the supplier never ships?", "If they don't accept by the accept-by date, all your money comes back. If they accept but don't ship by the ship-by date, the balance comes back. Arra's agent sends the refund automatically when the date passes."],
  ["What does it cost?", "Arra charges no fee. You pay the network fee (a fraction of a cent) and, if you pay in naira, Textile FX's 0.01% fee, which is already in the rate you see."],
  ["Does my supplier need crypto experience?", "They need a wallet on Celo, such as MiniPay. The order page opens in their language (English or Chinese), with the locked amount and one button to accept."],
  ["What about large orders?", "While Arra is new, each order has a safety cap (now $500). It goes up as the contract builds a track record and after an outside audit."],
];

export default function Landing({ wallet }) {
  return (
    <div className="landing">
      <section className="hero">
        <div className="hero-copy">
          <h1 className="display">Pay the deposit. Keep the balance locked until it ships.</h1>
          <p className="lede-lg">
            Escrow for any deal paid with a deposit and a balance, from phones and solar panels shipped from China to a table made in Lagos. Your supplier gets the deposit the moment they accept. The rest waits in an open contract until the goods ship, and comes back to you if they don't.
          </p>
          <div className="hero-cta">
            <a href="/new" className="button money" onClick={go("/new")}>Start an order</a>
            <a href="#how" className="button secondary">See how it works</a>
          </div>
          <ul className="trust-row">
            <li><Icon name="shield" size={18} /> Contract verified on Sourcify</li>
            <li><Icon name="id" size={18} /> Agent #9996 on Celo</li>
            <li><Icon name="rate" size={18} /> Rates from Textile FX</li>
          </ul>
        </div>
        <Calculator />
      </section>

      <Stats />

      <section className="band">
        <h2 className="section-title">The deposit is the easy part. The balance is where it goes wrong.</h2>
        <div className="cases">
          {CASES.map((c) => (
            <figure key={c.big} className="case">
              <strong>{c.big}</strong>
              <p>{c.text}</p>
              <figcaption><a href={c.href} target="_blank" rel="noreferrer">{c.src}</a></figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section className="band returns" id="returns">
        <h2 className="section-title">Lock the rate, keep your margin</h2>
        <p className="lede-lg" style={{ marginBottom: 22 }}>Importers pay the deposit today and the balance weeks later. If the naira falls in between, the same balance costs far more. Arra converts the whole order at one firm Textile FX rate on day one, so the price you agreed is the price you pay.</p>
        <div className="ret-grid">
          <div className="ret-card">
            <p className="label">A real case: a $10,000 order, $7,000 balance</p>
            <dl>
              <div><dt>Balance at the 13 Jun 2023 rate (₦471)</dt><dd className="num">₦3,297,000</dd></div>
              <div><dt>Same balance on 31 Jul 2023 (₦756.94)</dt><dd className="num">₦5,298,580</dd></div>
              <div className="hl"><dt>Extra the importer had to find</dt><dd className="num">₦2,001,580 (+61%)</dd></div>
            </dl>
            <p className="small muted">Rates: <a href="https://allafrica.com/stories/202506100251.html" target="_blank" rel="noreferrer">AllAfrica</a>, <a href="https://nairametrics.com/2023/08/01/end-of-july-exchange-rate-parallel-market-depreciates-by-11-5-gains-1-6-on-ie-window/" target="_blank" rel="noreferrer">Nairametrics (FMDQ)</a>. With Arra the balance was converted once, on day one: no extra.</p>
          </div>
          <div className="ret-card">
            <p className="label">Why it matters</p>
            <ul className="ret-list">
              <li><strong className="num">−40.9%</strong> The naira's fall against the dollar in 2024 alone (<a href="https://nairametrics.com/2024/12/31/exchange-rate-ends-2024-at-n1535-1-marking-a-40-9-depreciation" target="_blank" rel="noreferrer">Nairametrics</a>).</li>
              <li><strong className="num">0.01%</strong> Textile FX's fee, already in the rate you see.</li>
              <li><strong className="num">$0</strong> Arra's fee. You pay a network fee of a fraction of a cent.</li>
            </ul>
            <p className="small muted">Rates can also move in your favour; locking removes the gamble either way, the way a bank forward contract would, which small importers rarely get.</p>
          </div>
        </div>
      </section>

      <section className="band" id="how">
        <h2 className="section-title">How it works</h2>
        <ol className="flow">
          {STEPS.map(([icon, title, body]) => (
            <li key={title}>
              <span className="flow-icon"><Icon name={icon} /></span>
              <h3>{title}</h3>
              <p>{body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="band">
        <h2 className="section-title">Built around how these deals really fail</h2>
        <div className="features">
          {FEATURES.map(([icon, title, body]) => (
            <article key={title} className="feature">
              <Icon name={icon} size={26} />
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="band supplier-band" lang="zh">
        <div className="zh-card">
          <p className="zh-big">已为您锁定 <span className="num">$350.00</span></p>
          <p>接单后立即收到定金。尾款存放在公开合约中，发货后支付。</p>
          <span className="button money" aria-hidden="true">接单并收取定金</span>
        </div>
        <div lang="en">
          <h2 className="section-title">Your supplier sees it in Chinese</h2>
          <p className="lede-lg">Send one link. It opens in English or Simplified Chinese with the locked amount, the exact terms and an Accept button. Suppliers ask for deposits because they can't see the buyer's money. Now they can.</p>
        </div>
      </section>

      <section className="band" id="uses">
        <h2 className="section-title">Not just imports. Any deal with a deposit and a balance.</h2>
        <p className="lede-lg" style={{ marginBottom: 26 }}>Arra was built for importers, but the same contract protects any deal where one side pays something now and the rest on delivery. Choose the kind of deal when you start an order and the wording adapts.</p>
        <div className="features">
          {USES.map(([icon, title, body]) => (
            <article key={title} className="feature">
              <Icon name={icon} size={26} />
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="band" id="security">
        <h2 className="section-title">Open, checkable, and nobody in the middle</h2>
        <div className="features three">
          <article className="feature">
            <Icon name="code" size={26} />
            <h3>Public, verified contract</h3>
            <p>The vault's code is published and matches what's deployed, byte for byte. <a href={`https://repo.sourcify.dev/42220/${VAULT}`} target="_blank" rel="noreferrer">Check it on Sourcify</a>.</p>
          </article>
          <article className="feature">
            <Icon name="shield" size={26} />
            <h3>Money can't be taken</h3>
            <p>No admin key can move locked funds. Thousands of automated runs check that money only ever reaches the buyer or the supplier.</p>
          </article>
          <article className="feature">
            <Icon name="id" size={26} />
            <h3>A registered agent</h3>
            <p>Arra's agent has an onchain identity (ERC-8004 #9996) and only triggers refunds and payouts the contract already allows.</p>
          </article>
        </div>
      </section>

      <section className="band" id="faq">
        <h2 className="section-title">Questions</h2>
        <div className="faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
              <summary>{q}</summary>
              <p>{a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="band final">
        <h2 className="display small">Your next order, without the worry.</h2>
        <div className="hero-cta center">
          <a href="/new" className="button money" onClick={go("/new")}>Start an order</a>
          {wallet.account ? <a href="/app" className="button secondary" onClick={go("/app")}>Your orders</a> : null}
        </div>
        <p className="small muted">
          <a href={`${EXPLORER}/address/${VAULT}`} target="_blank" rel="noreferrer">Vault on Celoscan</a>
        </p>
      </section>
    </div>
  );
}
