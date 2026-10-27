// Confirms a transaction carries Arra's attribution tag. Sends nothing.
//   node scripts/verify-tag.js 0xTXHASH
import { verifyTx } from "@celo/attribution-tags";
import { publicClient } from "../src/wallet.js";
import { ATTRIBUTION_TAG } from "../src/config.js";
import { celoscanTx } from "./_common.js";

const hash = process.argv[2];
if (!/^0x[0-9a-fA-F]{64}$/.test(hash || "")) {
  console.error("Usage: node scripts/verify-tag.js 0xTXHASH");
  process.exit(1);
}
const result = await verifyTx({ client: publicClient(), hash });
const ok = result?.codes?.includes(ATTRIBUTION_TAG);
console.log(`${celoscanTx(hash)}\nTag found: ${result ? result.codes.join(", ") : "none"}`);
console.log(ok ? "OK: this transaction is credited to Arra." : "PROBLEM: Arra's tag is missing. Stop and tell Claude.");
process.exit(ok ? 0 : 2);
