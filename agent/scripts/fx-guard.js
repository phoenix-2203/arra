// Arra's rate guard against live prices. Sends nothing and needs no wallet.
//   npm run fx-guard                 # $100 order, default 3% limit
//   npm run fx-guard -- --usd 500 --max 1
import { textileClient, ngnPerUsd } from "../src/textile.js";
import { referenceRate, guard, DEFAULT_MAX_BPS } from "../src/fxGuard.js";

const args = process.argv.slice(2);
const val = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const usd = val("--usd", "100");
const maxBps = Math.round(Number(val("--max", DEFAULT_MAX_BPS / 100)) * 100);
const naira = (v) => `₦${Number(v).toLocaleString("en-NG", { maximumFractionDigits: 2 })}`;

const ref = await referenceRate().get();
console.log("Independent reference (naira per $1, mid rate)");
if (!ref) console.log("  Unavailable: both sources failed. The guard would let quotes through and say so.");
else {
  for (const s of ref.sources) console.log(`  ${s.name.padEnd(17)}: ${naira(s.ngnPerUsd)}${s.asOf ? `  (as of ${new Date(s.asOf * 1000).toISOString().slice(0, 10)})` : ""}`);
  console.log(`  Reference used   : ${naira(ref.ngnPerUsd)}${ref.disagree ? "  (sources disagree by more than 5%)" : ""}`);
}

const buyAmount = BigInt(Math.round(Number(usd) * 1e6));
const { data } = await textileClient().preview({ buyAmount });
const rate = ngnPerUsd({ sellAmount: data.sellAmount, buyAmount: data.buyAmount ?? buyAmount });
const g = guard({ ngnPerUsd: rate, ref, maxBps });
console.log(`\nTextile FX for $${usd} USDT`);
console.log(`  Price            : ${naira(Number(data.sellAmount) / 1e6)} cNGN, ${naira(rate)} per $1 (fee included)`);
if (g.checked) console.log(`  Above reference  : ${(g.premiumBps / 100).toFixed(2)}% (limit ${(g.maxBps / 100).toFixed(2)}%)`);
console.log(`  Guard            : ${g.ok ? "would TAKE this quote" : "would REFUSE this quote; nothing would move"}`);
