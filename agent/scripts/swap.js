// A real Textile FX swap on Celo from the agent wallet, tagged and paid in USDT.
// Preview (sends nothing):   npm run swap -- --usd 0.20
// Do it:                      npm run swap -- --usd 0.20 --send
// Direction: default sells USDT for cNGN. Add --to-usdt to sell cNGN for USDT
// (then --usd is the USDT amount you want to receive).
import { formatUnits, parseUnits, erc20Abi } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { agentAccount, taggedWallet, publicClient } from "../src/wallet.js";
import { USDT_FEE_ADAPTER } from "../src/config.js";
import { textileClient, signTakerProof, ngnPerUsd, CNGN, USDT, TextileError } from "../src/textile.js";
import { SEND, celoscanTx } from "./_common.js";

const args = process.argv.slice(2);
const usdArg = args[args.indexOf("--usd") + 1];
if (!args.includes("--usd") || !/^\d+(\.\d{1,6})?$/.test(usdArg ?? "")) {
  console.log("Usage: npm run swap -- --usd 0.20 [--to-usdt] [--send]");
  process.exit(1);
}
const toUsdt = args.includes("--to-usdt");
const side = toUsdt ? "buyUsdt" : "sellUsdt";
const usd = parseUnits(usdArg, 6);
const sellToken = toUsdt ? CNGN : USDT;
const fmt = (v) => formatUnits(BigInt(v), 6);

const account = agentAccount();
const client = publicClient();
const textile = textileClient();
const bal = (token) => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });

console.log("Textile FX swap on Celo");
console.log(`  Wallet       : ${account.address}`);
console.log(`  Direction    : ${toUsdt ? "cNGN -> USDT" : "USDT -> cNGN"}`);
console.log(`  Balances     : ${fmt(await bal(USDT))} USDT, ${fmt(await bal(CNGN))} cNGN`);

const amount = toUsdt ? { buyAmount: usd } : { sellAmount: usd };
// Textile's RFQ minimum is 1 whole token of whatever you sell (1,000,000 units at 6 decimals).
const MIN_SELL = 1_000_000n;
if (!toUsdt && usd < MIN_SELL) {
  console.log("\nTextile's minimum swap is 1 USDT, so use --usd 1 or more. Nothing was sent.");
  process.exit(1);
}
try {
  const p = (await textile.preview({ side, ...amount })).data;
  console.log(`  Preview      : ${toUsdt ? `${fmt(p.sellAmount)} cNGN -> ${fmt(p.buyAmount)} USDT` : `${fmt(p.sellAmount)} USDT -> ${fmt(p.buyAmount)} cNGN`}`);
  const rate = ngnPerUsd(p, side);
  if (rate) console.log(`  Rate         : about ₦${rate.toLocaleString("en-NG")} per $1 (fee included)`);
} catch (e) {
  console.log(`  Preview      : not available (${e.message})`);
  if (e.body?.availableSellAmount || e.body?.data?.availableSellAmount) console.log("  Depth        :", JSON.stringify(e.body));
}

if (!SEND) {
  console.log("\nPREVIEW ONLY. Nothing was signed or sent.");
  console.log(`To swap for real: npm run swap -- --usd ${usdArg}${toUsdt ? " --to-usdt" : ""} --send`);
  process.exit(0);
}

// Firm quote. First try without a proof (a recent one may still be valid),
// then sign the free TakerControl message and retry.
let res;
try {
  try {
    res = await textile.request({ side, ...amount, taker: account.address });
  } catch (e) {
    if (!(e instanceof TextileError && e.status === 401)) throw e;
    const takerProof = await signTakerProof(account, account.address);
    res = await textile.request({ side, ...amount, taker: account.address, takerProof });
  }
} catch (e) {
  if (!(e instanceof TextileError)) throw e;
  console.log(`\nTextile said no: ${e.message}. Nothing was sent.`);
  process.exit(1);
}
const d = res.data;
if (d.status !== "quoted") {
  console.log(`\nNo quote: ${d.reason ?? "unknown"}${d.availableSellAmount ? ` (available: ${fmt(d.availableSellAmount)})` : ""}`);
  process.exit(1);
}
const q = d.quote;
console.log(`\nFirm quote ${d.rfqId}`);
console.log(`  You pay      : ${fmt(q.takerPays)} ${toUsdt ? "cNGN" : "USDT"} (fee ${fmt(q.feeAmount)})`);
console.log(`  You receive  : ${fmt(q.buyAmount)} ${toUsdt ? "USDT" : "cNGN"}`);
console.log(`  Expires      : ${q.expiresAt}`);

const wallet = taggedWallet(account);
const fee = { feeCurrency: USDT_FEE_ADAPTER };

const allowance = await client.readContract({ address: sellToken, abi: erc20Abi, functionName: "allowance", args: [account.address, q.reactor] });
if (allowance < BigInt(q.takerPays)) {
  const a = d.transactions.approval;
  const h = await wallet.sendTransaction({ to: a.to, data: a.data, value: BigInt(a.value ?? 0), ...fee });
  await client.waitForTransactionReceipt({ hash: h });
  console.log(`  Approved     : ${celoscanTx(h)}`);
}
if (Date.now() > Date.parse(q.expiresAt)) {
  console.log("Quote expired before sending. Nothing swapped; run it again.");
  await textile.cancel(d.rfqId, d.claimToken).catch(() => {});
  process.exit(1);
}
const s = d.transactions.swap;
const hash = await wallet.sendTransaction({ to: s.to, data: s.data, value: BigInt(s.value ?? 0), ...fee });
console.log(`  Swap sent    : ${celoscanTx(hash)}`);
await textile.submit(d.rfqId, d.claimToken, hash).catch((e) => console.log(`  (report to Textile failed: ${e.message})`));
const receipt = await client.waitForTransactionReceipt({ hash });
const tag = await verifyTx({ client, hash });
console.log(`  Status       : ${receipt.status}`);
console.log(`  Tag on tx    : ${tag ? tag.codes.join(", ") : "MISSING"}`);
console.log(`  Balances now : ${fmt(await bal(USDT))} USDT, ${fmt(await bal(CNGN))} cNGN`);
