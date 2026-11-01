// One real supplier check from the agent wallet, paid over x402 (buy gateway, Celo mainnet).
// Preview: npm run supplier-check -- instagram celoorg
// Send:    npm run supplier-check -- instagram celoorg --send     (costs about $0.005)
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentAccount, publicClient } from "../src/wallet.js";
import { supplierChecker, PLATFORMS, cleanHandle } from "../src/supplierCheck.js";
import { balances, SEND } from "./_common.js";

const [platform, handle] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!PLATFORMS[platform] || !cleanHandle(handle)) {
  console.log("Usage: npm run supplier-check -- <instagram|tiktok|x> <username> [--send]");
  process.exit(1);
}
const account = agentAccount();
const b = await balances(account.address);
console.log(`Supplier check: ${PLATFORMS[platform].label} @${cleanHandle(handle)}`);
console.log(`  Paid by  : ${account.address} (agent, ERC-8004 #9996)`);
console.log(`  Price    : about $0.005 (USDT, USA₮ or USDC; the gateway covers gas)`);
console.log(`  Agent has: $${b.usdt} USDT`);
if (!SEND) {
  console.log("\nPREVIEW ONLY. Nothing was paid.\nTo do it for real add --send");
  process.exit(0);
}
// A throwaway data folder, so the server's 24-hour cache doesn't answer instead.
let raw = null;
const c = supplierChecker({ account, client: publicClient(), dataDir: mkdtempSync(join(tmpdir(), "sc-")), fetchImpl: async (i, init) => {
  const res = await fetch(i, init);
  if (res.status !== 402) raw = await res.clone().text();
  return res;
} });
const r = await c.check(platform, handle);
console.log("\nResult:", JSON.stringify({ found: r.found, summary: r.summary, flags: r.flags, paid: r.paid }, null, 2));
if (r.paid?.txHash) console.log(`Settlement: https://celoscan.io/tx/${r.paid.txHash}`);
console.log("\nRaw answer (first 1500 characters, for checking the fields):\n" + (raw ?? "").slice(0, 1500));
