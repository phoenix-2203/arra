# Arra's FX strategy: a treasury agent for importers

Arra is entered in the **Open Corridors: Textile FX** track as a *"treasury agent that manages a business's currency exposure"* ([track wording](https://www.loops.house/agents-on-open-rails)). This document covers:

- the exposure Arra manages
- the rules its agent follows
- how its returns are measured
- the results so far, from real 2026 data and real Textile fills.

Arra is a **taker** on Textile, not a market maker. It never holds a position of its own; every naira it converts belongs to the buyer and goes straight into that buyer's escrowed order.

---

## 1. The exposure

A small importer buys in dollars but earns in naira. The usual deal is a **30% deposit now and the 70% balance weeks later**, before shipping. Between those two dates the importer is **short dollars**: they owe a fixed dollar balance, paid from naira at whatever the rate is on the day.

That gap is real, even in a calm year. Official (NFEM) rates published by the CBN:

| Window (2026) | Days | Rate at deposit | Rate at balance | Move | On a $7,000 balance |
|---|---|---|---|---|---|
| 17 → 30 March | 13 | ₦1,345 ([Nairametrics](https://nairametrics.com/2026/03/18/naira-strengthens-to-n1345-hits-highest-level-in-one-month/)) | ₦1,383.58 ([Nigerian News Direct](https://nigeriannewsdirect.com/naira-depreciates-to-%E2%82%A61383-58-as-interbank-turnover-declines-2/)) | **+2.87%** | **₦270,060 more** |
| 15 → 24 June | 9 | ₦1,356 | ₦1,389 ([Nairametrics](https://nairametrics.com/2026/07/01/naira-closes-june-at-n1376-despite-intra-month-volatility/)) | **+2.43%** | **₦231,000 more** |
| 6 → 26 October | 20 | ₦1,331.50 ([Nairametrics](https://nairametrics.com/2026/10/07/naira-strengthens-to-n1331-as-fx-turnover-swings-above-600-million/)) | ₦1,367.61 ([WithinNigeria](https://www.withinnigeria.com/2026/10/27/dollar-to-naira-today-october-27-2026-naira-trades-near-%E2%82%A61368-at-nfem-as-black-market-sells-at-%E2%82%A61385-%E2%82%A61390/?amp=1)) | **+2.71%** | **₦252,770 more** |
| 1 January → 17 March | 75 | ₦1,445.99 ([AllAfrica](https://allafrica.com/stories/202601020184.html)) | ₦1,345 | −6.98% | ₦706,930 less |
| 30 June → 7 September | 69 | ₦1,376 | ₦1,320 ([Nairametrics](https://nairametrics.com/2026/09/08/naira-firms-at-n1320-as-nfem-turnover-plunges-to-five-month-low/)) | −4.07% | ₦392,000 less |
| 26 → 29 October | 3 | ₦1,367.61 | ₦1,346.91 ([WithinNigeria](https://www.withinnigeria.com/2026/10/31/dollar-to-naira-today-october-31-2026-nfem-rate-%E2%82%A61346-91-black-market-%E2%82%A61385/)) | −1.51% | ₦144,900 less |

**What this shows, honestly:**

- Waiting is a bet, and it cuts both ways.
- Over 2026 as a whole the naira firmed (₦1,445.99 in January, about ₦1,347 at the end of October). In those windows an importer who waited paid less.
- But within weeks, the size of an ordinary deposit-to-balance gap, the naira moved **2.4–2.9% against the importer three separate times**.
- The importer's selling price and margin are usually fixed when they take the order. A swing that size can wipe out much of the profit on a deal.

Arra's position: **an importer's job is trading goods, not guessing the naira.** So Arra removes the bet instead of placing it.

## 2. The rules the agent follows

**Rule 1: Convert the whole order once, on day one.**
- When a buyer pays from naira, Arra asks Textile for one **firm quote for the exact USDT the order needs**: deposit and balance together, not just the deposit.
- The USDT goes straight into the escrow vault.
- From that moment the importer's naira cost is fixed. The balance can't get more expensive, and the money is still protected: it is released to the supplier only when they ship, and refunded automatically if they don't.
- This is the same result a bank forward contract gives, which small importers rarely get.

**Rule 2: Only convert what's missing.**
- Arra reads the wallet first.
- USDT the buyer already holds is used as-is, and only the shortfall is converted.
- Textile's minimum is $1, so a smaller gap converts $1 and the change stays in the buyer's wallet as USDT.

**Rule 3: Never convert at an unfair price (the rate guard).** Before the buyer is asked to sign anything, the agent:
1. Gets Textile's firm quote (naira per dollar, Textile's 0.01% fee included).
2. Gets an **independent mid-market rate**: the median of two free public feeds, [ExchangeRate-API](https://www.exchangerate-api.com/) and [currency-api](https://github.com/fawazahmed0/exchange-api). The second feed has a mirror. Both are cached for 10 minutes; if both feeds are down, the last good value is kept for up to 48 hours. If the feeds are more than 5% apart, that's flagged.
3. Works out the **premium**: `premium = quote ÷ reference − 1`, in basis points.
4. **Refuses the quote if the premium is above the buyer's limit.** The limit is 1%, 3% (the default) or 5%, picked on the order screen. A refused quote is cancelled on Textile, nothing moves, and the buyer is told the rate, the market rate and the gap in plain words.
5. Records every quote, taken or refused, in the FX ledger (section 3).

Why the default is 3%:
- A small trader's real alternative is the street (parallel) market, not the official window.
- On 29 October 2026, street dealers sold dollars at ₦1,385–1,390 against an official ₦1,346.91 ([WithinNigeria](https://www.withinnigeria.com/2026/10/31/dollar-to-naira-today-october-31-2026-nfem-rate-%E2%82%A61346-91-black-market-%E2%82%A61385/)). That's **2.8–3.2% above**.
- A 3% limit means Arra never converts at a worse rate than the street would give.
- Buyers who want to wait for a tighter price can choose 1%.

**When there's no reference at all** (both feeds down for two days), the guard lets the quote through and says so on screen. The buyer still sees Textile's exact rate and confirms it in their own wallet. Blocking every naira payment because a free feed is down would hurt buyers more than it protects them.

Code: [`agent/src/fxGuard.js`](../agent/src/fxGuard.js). Where it's used: `POST /api/fx/preview` and `POST /api/fx/quote` in [`agent/src/server.js`](../agent/src/server.js). Tests: [`agent/test/fxGuard.test.js`](../agent/test/fxGuard.test.js), plus the guard cases in `server.test.js`.

## 3. How returns are measured

Every conversion is recorded in `data/fx-ledger.jsonl` with:

- the quote's naira-per-dollar rate
- the reference rate at that moment
- the premium, and the buyer's limit
- whether it was taken or refused
- and, once filled, the transaction hash.

`GET /api/fx/returns` turns the ledger into two numbers for the conversions that actually filled:

| Measure | Formula | What it answers |
|---|---|---|
| **Execution cost** | dollars × (quote rate − reference rate at fill) | How much above the fair mid rate did the buyer pay to convert today? (Lower is better; this is the cost of the strategy.) |
| **Lock value** | dollars × (reference rate now − reference rate at fill) | What would the same dollars cost at today's rate, compared with the day Arra locked them? (Positive means locking saved the buyer naira.) |

It also reports the average premium (weighted by dollars) and every refused quote. Two notes:
- Refused quotes are counted separately: they cost nothing, because nothing moved.
- Rows are public but carry no wallet addresses.

To check the guard against live prices from any machine (it sends nothing and needs no wallet):

```bash
cd agent && npm run fx-guard -- --usd 100          # default 3% limit
npm run fx-guard -- --usd 500 --max 1              # 1% limit
```

## 4. Results so far

**Execution, on Arra's real mainnet fill.**
- Order: the first naira-paid order, on 30 October 2026, Textile FX fill [`0xc9e673…673c`](https://celoscan.io/tx/0xc9e673ac56ea2fde09f3f5c356b53ee906784491701be78955420b5c17d0673c), tagged with builder codes `arra` and `celo_00cfddd372fa`.
- It paid about **₦1,374 per $1**, fee included.

| Compared with | Rate | Premium | On a $7,000 balance |
|---|---|---|---|
| Official NFEM rate (CBN, 29 Oct) | ₦1,346.91 | +2.0% | ₦189,630 more than the official rate |
| Street rate, dealers selling (29 Oct) | ₦1,385 | **−0.8%** | **₦77,000 less than the street** |

That fill sits inside the default 3% limit; the guard would have taken it. A buyer on the 1% limit would have been told to wait.

**The lock, on the windows in section 1.** For a $7,000 balance, converting on day one instead of on the balance date:
- **saved ₦231,000–₦270,060** in each of the three windows where the naira weakened
- **cost ₦144,900–₦706,930** in each of the three where it firmed.

That spread is the uncertainty Arra removes. The importer knows their naira cost the day they agree the deal.

**Limits of these results (stated plainly):**
- Only two small (~$1) mainnet fills so far. Both were Arra's own tests, made before the ledger existed, so they're listed here by hand. The ledger and `GET /api/fx/returns` start counting from this release.
- Official rates are daily CBN figures reported by the press, not tick data. Street rates are dealer quotes reported by the press, not a market feed. Both are the best public numbers available.
- The independent feeds give a mid-market rate close to the official one. That's deliberately strict: the guard measures Textile against the best rate, not the street rate.

## 5. What comes next

- **Split timing, buyer's choice:** convert the deposit now and leave the balance as naira until the buyer locks it, with an alert when the guard sees a good price. Only for buyers who want to manage the bet themselves; locking everything stays the default.
- **Bank to escrow:** naira from a bank account via Textile Ramp, as soon as it delivers cNGN on Celo (checked live: today only BNB Chain and Base).
- **More corridors:** the same rules for cedi and shilling stablecoins on Textile, with no change to the vault.
