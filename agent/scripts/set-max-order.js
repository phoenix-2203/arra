// Changes the per-order cap on the current vault (owner only; the owner is the agent
// wallet). The cap is a safety limit while the contract is unaudited. Changing it moves
// no money and doesn't touch existing orders. Tagged, gas paid in USDT.
// Preview:  npm run set-max -- 500
// Send:     npm run set-max -- 500 --send
import { formatUnits, parseUnits } from "viem";
import { agentAccount, taggedWallet, publicClient } from "../src/wallet.js";
import { USDT_FEE_ADAPTER, ARRA_VAULT } from "../src/config.js";
import { vaultAbi } from "../src/vault.js";
import { SEND, balances, previewOnly, celoscanTx, tagOf } from "./_common.js";
import { verifyTx } from "@celo/attribution-tags";

const usd = process.argv.slice(2).find((a) => /^\d+(\.\d{1,2})?$/.test(a));
if (!usd || Number(usd) < 1 || Number(usd) > 100000) {
  console.log("Say the new cap in dollars, e.g.  npm run set-max -- 500");
  process.exit(1);
}
const account = agentAccount();
const client = publicClient();
const read = (functionName) => client.readContract({ address: ARRA_VAULT, abi: vaultAbi, functionName });
const [owner, current] = await Promise.all([read("owner"), read("maxOrder")]);
const next = parseUnits(usd, 6);
const b = await balances(account.address);

console.log("Change the per-order cap");
console.log(`  Vault   : ${ARRA_VAULT}`);
console.log(`  Owner   : ${owner}`);
console.log(`  Now     : $${formatUnits(current, 6)}`);
console.log(`  New     : $${formatUnits(next, 6)}`);
// Pay the fee in USDT if the agent has a little, otherwise in CELO.
const feeOpts = b.usdtRaw >= 20_000n ? { feeCurrency: USDT_FEE_ADAPTER } : Number(b.celo) >= 0.01 ? {} : null;
console.log(`  Gas     : ${feeOpts?.feeCurrency ? "USDT" : feeOpts ? "CELO" : "nothing to pay with"} (agent has $${b.usdt} USDT, ${Number(b.celo).toFixed(4)} CELO)`);
if (!feeOpts) {
  console.log(`\nThe agent wallet needs a tiny amount for the network fee: send it about $0.10 USDT or 0.05 CELO on Celo:\n  ${account.address}\nThen run this again.`);
  process.exit(1);
}
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.log(`\nThis wallet (${account.address}) isn't the vault's owner. Stopping.`);
  process.exit(1);
}
if (current === next) {
  console.log("\nThe cap is already that. Nothing to do.");
  process.exit(0);
}
if (!SEND) {
  previewOnly(`npm run set-max -- ${usd}`);
  process.exit(0);
}
const h = await taggedWallet(account).writeContract({ address: ARRA_VAULT, abi: vaultAbi, functionName: "setMaxOrder", args: [next], ...feeOpts });
const r = await client.waitForTransactionReceipt({ hash: h });
console.log(`\n${r.status === "success" ? "Done" : "Failed"}: ${celoscanTx(h)}`);
// Public nodes can lag a block behind: wait a few seconds for the new value to show.
let now = await read("maxOrder");
for (let i = 0; i < 10 && now !== next; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  now = await read("maxOrder");
}
console.log(`Cap is now $${formatUnits(now, 6)}`);
const tag = await tagOf(verifyTx, client, h);
if (tag) console.log(`Attribution tag: ${JSON.stringify(tag)}`);
