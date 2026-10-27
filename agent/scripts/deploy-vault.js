// Deploys the ArraVault on Celo mainnet from the agent wallet (tagged, gas paid in USDT).
// The agent wallet becomes the owner, which can only pause new orders or change the size cap.
// Preview:  node scripts/deploy-vault.js
// Send:     node scripts/deploy-vault.js --send
import { readFileSync } from "node:fs";
import { encodeDeployData, formatUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { agentAccount, taggedWallet, publicClient } from "../src/wallet.js";
import { USDT, USDT_FEE_ADAPTER, MAX_ORDER_USDT, ATTRIBUTION_TAG } from "../src/config.js";
import { SEND, balances, previewOnly, celoscanTx, celoscanAddr } from "./_common.js";

const artifact = JSON.parse(
  readFileSync(new URL("../abi/ArraVault.json", import.meta.url))
);
const account = agentAccount();
const client = publicClient();
const args = [USDT, MAX_ORDER_USDT, account.address];
const b = await balances(account.address);

console.log("Deploy ArraVault");
console.log(`  From / owner : ${account.address}`);
console.log(`  Token        : USDT ${USDT}`);
console.log(`  Max per order: $${formatUnits(MAX_ORDER_USDT, 6)}`);
console.log(`  Gas paid in  : USDT (balance ${b.usdt})`);
console.log(`  Tag          : ${ATTRIBUTION_TAG}`);

// The estimate must name the fee currency too; otherwise the node checks the
// CELO balance (zero here) and reports "gas required exceeds allowance (0)".
const gas = await client.estimateGas({
  account,
  data: encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }),
  feeCurrency: USDT_FEE_ADAPTER,
});
console.log(`  Est. gas     : ${gas}`);
try {
  // Celo returns the gas price in the fee currency when asked (18-decimal units).
  const price = BigInt(await client.request({ method: "eth_gasPrice", params: [USDT_FEE_ADAPTER] }));
  const cost = (gas * price) / 10n ** 12n; // 18 -> 6 decimals
  console.log(`  Est. cost    : about $${formatUnits(cost, 6)} in USDT`);
  if (cost * 2n > b.usdtRaw) console.log("  Warning      : balance may be too low; add a little USDT before sending.");
} catch {
  console.log("  Est. cost    : (couldn't fetch the USDT gas price; usually a few cents)");
}

if (!SEND) {
  previewOnly("node scripts/deploy-vault.js");
  process.exit(0);
}

const wallet = taggedWallet(account);
const hash = await wallet.deployContract({
  abi: artifact.abi,
  bytecode: artifact.bytecode,
  args,
  feeCurrency: USDT_FEE_ADAPTER,
});
console.log(`\nSent: ${celoscanTx(hash)}`);
const receipt = await client.waitForTransactionReceipt({ hash });
const tag = await verifyTx({ client, hash });
console.log(`Status       : ${receipt.status}`);
console.log(`Vault address: ${receipt.contractAddress}  ${celoscanAddr(receipt.contractAddress)}`);
console.log(`Tag on tx    : ${tag ? tag.codes.join(", ") : "MISSING"}`);
console.log(`\nNext: add this line to agent/.env\nARRA_VAULT=${receipt.contractAddress}`);
