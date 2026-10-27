// Shows the agent wallet address and balances. Sends nothing.
//   node scripts/check.js
import { agentAccount } from "../src/wallet.js";
import { ATTRIBUTION_TAG, ARRA_VAULT } from "../src/config.js";
import { balances, celoscanAddr } from "./_common.js";

const account = agentAccount();
const b = await balances(account.address);
console.log(`Agent wallet : ${account.address}`);
console.log(`Explorer     : ${celoscanAddr(account.address)}`);
console.log(`Balances     : ${b.usdt} USDT, ${b.celo} CELO`);
console.log(`Tag on all tx: ${ATTRIBUTION_TAG}`);
console.log(`Arra vault   : ${ARRA_VAULT || "(not deployed yet)"}`);
if (b.usdtRaw < 200_000n) console.log("\nTip: balance is low. About $1 of USDT on Celo covers hundreds of transactions.");
