// Deploys a new ArraVault (v3: $0.01 keeper fee) on Celo mainnet from the agent wallet
// (tagged, gas paid in USDT), continuing the order numbers of the vault before it.
//   1. Pauses NEW orders on the previous vault. Its existing orders are untouched and
//      finish normally (pausing can't block refunds, payouts or anything else).
//   2. Reads where its numbering stopped.
//   3. Deploys the new vault starting at the next number, so no two orders share one.
// The agent wallet is the owner of both; the owner can only pause new orders or change
// the size cap, never move funds.
// Preview:  npm run deploy
// Send:     npm run deploy -- --send
import { readFileSync } from "node:fs";
import { encodeDeployData, formatUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { agentAccount, taggedWallet, publicClient } from "../src/wallet.js";
import { USDT, USDT_FEE_ADAPTER, MAX_ORDER_USDT, ATTRIBUTION_TAG, VAULTS, KEEPER_FEE_USDT } from "../src/config.js";
import { vaultAbi } from "../src/vault.js";
import { SEND, balances, previewOnly, celoscanTx, celoscanAddr, readSoon } from "./_common.js";

const artifact = JSON.parse(readFileSync(new URL("../abi/ArraVault.json", import.meta.url)));
const account = agentAccount();
const client = publicClient();
const previous = VAULTS.at(-1).address;
const read = (functionName, opts = {}) => client.readContract({ address: previous, abi: vaultAbi, functionName, ...opts });
const [owner, paused, nextId] = await Promise.all([read("owner"), read("paused"), read("nextId")]);
const b = await balances(account.address);

console.log("Deploy ArraVault v3 (keeper fee)");
console.log(`  From / owner   : ${account.address}`);
console.log(`  Previous vault : ${previous} (${paused ? "already paused" : "taking orders"}, next order #${nextId})`);
console.log(`  Token          : USDT ${USDT}`);
console.log(`  Max per order  : $${formatUnits(MAX_ORDER_USDT, 6)}`);
console.log(`  Keeper fee     : $${formatUnits(KEEPER_FEE_USDT, 6)} (only when the agent triggers a due refund or payout)`);
console.log(`  Gas paid in    : USDT (balance ${b.usdt})`);
console.log(`  Tag            : ${ATTRIBUTION_TAG}`);
if (owner.toLowerCase() !== account.address.toLowerCase()) {
  console.log(`\nThe previous vault's owner is ${owner}, not this wallet, so it can't be paused from here. Stopping.`);
  process.exit(1);
}
if (b.usdtRaw < 100_000n) {
  console.log("\nThe agent wallet needs a little USDT for fees (about $0.10 is plenty). Stopping.");
  process.exit(1);
}

// Estimate with the fee currency named, or the node checks CELO (zero) and refuses.
const gas = await client.estimateGas({
  account,
  data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [USDT, MAX_ORDER_USDT, account.address, nextId, KEEPER_FEE_USDT] }),
  feeCurrency: USDT_FEE_ADAPTER,
});
try {
  const price = BigInt(await client.request({ method: "eth_gasPrice", params: [USDT_FEE_ADAPTER] }));
  console.log(`  Est. cost      : about $${formatUnits((gas * price) / 10n ** 12n, 6)} in USDT, plus a fraction of a cent to pause`);
} catch {
  console.log("  Est. cost      : a few cents in USDT");
}

if (!SEND) {
  previewOnly("npm run deploy --");
  process.exit(0);
}

const wallet = taggedWallet(account);

// 1. Pause new orders on the previous vault (if not already).
let pausedAt;
if (!paused) {
  const h = await wallet.writeContract({ address: previous, abi: vaultAbi, functionName: "setPaused", args: [true], feeCurrency: USDT_FEE_ADAPTER });
  const r = await client.waitForTransactionReceipt({ hash: h });
  console.log(`\nPaused new orders on the previous vault: ${r.status} ${celoscanTx(h)}`);
  if (r.status !== "success") process.exit(1);
  pausedAt = r.blockNumber;
}

// 2. Read the numbering as of the pause (an order may have slipped in just before it).
//    After the pause it can't change any more.
const firstId = await readSoon((blockNumber) => read("nextId", blockNumber ? { blockNumber } : {}), pausedAt);
console.log(`New vault's first order will be #${firstId}`);

// 3. Deploy.
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args: [USDT, MAX_ORDER_USDT, account.address, firstId, KEEPER_FEE_USDT],
  feeCurrency: USDT_FEE_ADAPTER,
});
console.log(`Sent: ${celoscanTx(hash)}`);
const receipt = await client.waitForTransactionReceipt({ hash });
const tag = await verifyTx({ client, hash }).catch(() => null);
console.log(`Status         : ${receipt.status}`);
console.log(`New vault      : ${receipt.contractAddress}  ${celoscanAddr(receipt.contractAddress)}`);
console.log(`Tag on tx      : ${tag ? tag.codes.join(", ") : "check on Celoscan"}`);
console.log(`\nSend these three lines to Claude to switch Arra over:`);
console.log(`address  ${receipt.contractAddress}`);
console.log(`firstId  ${firstId}`);
console.log(`deployTx ${hash}`);
