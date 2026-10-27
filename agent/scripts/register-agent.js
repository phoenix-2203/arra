// Registers Arra's ERC-8004 identity from the agent wallet (tagged, gas paid in USDT).
// Preview:  node scripts/register-agent.js
// Send:     node scripts/register-agent.js --send
import { parseEventLogs } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { agentAccount, taggedWallet, publicClient } from "../src/wallet.js";
import { IDENTITY_REGISTRY, USDT_FEE_ADAPTER, ATTRIBUTION_TAG } from "../src/config.js";
import { SEND, balances, previewOnly, celoscanTx } from "./_common.js";

const abi = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "agentURI", type: "string" }], outputs: [{ name: "agentId", type: "uint256" }] },
  { type: "event", name: "Registered", inputs: [{ name: "agentId", type: "uint256", indexed: true }, { name: "agentURI", type: "string", indexed: false }, { name: "owner", type: "address", indexed: true }] },
];

const AGENT_URI = process.env.AGENT_URI || "https://raw.githubusercontent.com/phoenix-2203/arra/main/agent.json";

const account = agentAccount();
const client = publicClient();
const b = await balances(account.address);

console.log("Register Arra's ERC-8004 identity");
console.log(`  From (owner) : ${account.address}`);
console.log(`  Registry     : ${IDENTITY_REGISTRY}`);
console.log(`  Agent card   : ${AGENT_URI}`);
console.log(`  Gas paid in  : USDT (balance ${b.usdt})`);
console.log(`  Tag          : ${ATTRIBUTION_TAG}`);

// Simulate first so a mistake costs nothing.
await client.simulateContract({ account, address: IDENTITY_REGISTRY, abi, functionName: "register", args: [AGENT_URI] });
console.log("  Simulation   : OK");

if (!SEND) {
  previewOnly("node scripts/register-agent.js");
  process.exit(0);
}

const wallet = taggedWallet(account);
const hash = await wallet.writeContract({
  address: IDENTITY_REGISTRY,
  abi,
  functionName: "register",
  args: [AGENT_URI],
  feeCurrency: USDT_FEE_ADAPTER,
});
console.log(`\nSent: ${celoscanTx(hash)}`);
const receipt = await client.waitForTransactionReceipt({ hash });
const [ev] = parseEventLogs({ abi, eventName: "Registered", logs: receipt.logs });
const tag = await verifyTx({ client, hash });
console.log(`Status       : ${receipt.status}`);
console.log(`Agent ID     : ${ev ? ev.args.agentId : "(not found, check explorer)"}`);
console.log(`Tag on tx    : ${tag ? tag.codes.join(", ") : "MISSING"}`);
console.log("\nNext: add the agent wallet and this Agent ID to your Loops House entry.");
