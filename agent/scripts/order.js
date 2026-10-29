// Act on an Arra order from the agent wallet (useful when this wallet is the
// supplier, or to trigger a due refund/payout). Tagged, gas paid in USDT.
// Preview:  npm run order -- <command> <orderId> [options]
// Do it:    add --send
//
// Commands:
//   show <id>                          where the order stands, and what this wallet can do
//   accept <id>                        supplier accepts and receives the deposit
//   decline <id>                       supplier declines / cancels (money back to buyer)
//   ship <id> --container CSQU3054383  supplier marks shipped (container number is checked)
//   deliver <id> [--note "text"]       supplier marks delivered (services, made-to-order)
//   split <id> --to-supplier 0.80      propose a split ($ to the supplier, rest to buyer)
//   accept-split <id>                  accept the other side's split offer
//   claim <id> | reclaim <id>          trigger a due payout / refund (anyone can)
import { keccak256, toBytes, parseUnits } from "viem";
import { verifyTx } from "@celo/attribution-tags";
import { agentAccount, taggedWallet, publicClient } from "../src/wallet.js";
import { ARRA_VAULT, USDT_FEE_ADAPTER } from "../src/config.js";
import { vaultAbi, readOrder, nextActions, explain } from "../src/vault.js";
import { checkContainerNumber } from "../src/container.js";
import { SEND, celoscanTx, readSoon, tagOf } from "./_common.js";

const [cmd, idArg] = process.argv.slice(2).filter((a) => !a.startsWith("--") || a === "--send").filter((a) => a !== "--send");
const opt = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const usage = () => {
  console.log("Usage: npm run order -- <show|accept|decline|ship|deliver|split|accept-split|claim|reclaim> <orderId> [--send]");
  process.exit(1);
};
if (!cmd || !/^\d+$/.test(idArg ?? "")) usage();

const id = BigInt(idArg);
const account = agentAccount();
const client = publicClient();
const o = await readOrder(client, ARRA_VAULT, id);
if (!o) {
  console.log(`Order ${id} doesn't exist.`);
  process.exit(1);
}
const now = Math.floor(Date.now() / 1000);
const me = account.address.toLowerCase();
const role = me === o.buyer.toLowerCase() ? "buyer" : me === o.supplier.toLowerCase() ? "supplier" : "anyone";
const can = nextActions(o, now, role);

console.log(`Order #${o.id}: ${o.status}`);
console.log(`  Total ${o.usd.total} USDT, deposit ${o.usd.deposit}, still locked ${o.usd.held}`);
console.log(`  ${explain(o, now)}`);
console.log(`  This wallet is the ${role}. It can: ${can.length ? can.join(", ") : "nothing right now"}`);
if (o.splitOffer) console.log(`  Split on the table: $${Number(o.splitOffer.toSupplier) / 1e6} to the supplier, offered by ${o.splitOffer.proposer}`);
if (cmd === "show") process.exit(0);

let fn, args;
switch (cmd) {
  case "accept": fn = "accept"; args = [id]; break;
  case "decline": fn = "cancel"; args = [id]; break;
  case "claim": fn = "claim"; args = [id]; break;
  case "reclaim": fn = "reclaim"; args = [id]; break;
  case "accept-split":
    if (!o.splitOffer) { console.log("There's no split offer to accept."); process.exit(1); }
    fn = "acceptSplit"; args = [id, BigInt(o.splitOffer.toSupplier)]; break;
  case "split": {
    const amt = opt("to-supplier");
    if (!/^\d+(\.\d{1,6})?$/.test(amt ?? "")) { console.log("Add --to-supplier 0.80 (dollars to the supplier)."); process.exit(1); }
    fn = "proposeSplit"; args = [id, parseUnits(amt, 6)]; break;
  }
  case "ship": {
    const c = checkContainerNumber(opt("container"));
    if (!c.ok) { console.log(c.reason); process.exit(1); }
    console.log(`  Container ${c.number} passes the ISO 6346 check.`);
    fn = "markShipped"; args = [id, keccak256(toBytes(c.number))]; break;
  }
  case "deliver": fn = "markShipped"; args = [id, keccak256(toBytes(opt("note") ?? "delivered"))]; break;
  default: usage();
}

// Simulate first: if the contract would refuse, say so and send nothing.
try {
  await client.simulateContract({ account, address: ARRA_VAULT, abi: vaultAbi, functionName: fn, args });
} catch (e) {
  const why = {
    WrongStatus: "the order isn't at the stage where that's possible",
    NotSupplier: "only the supplier's wallet can do that",
    NotBuyer: "only the buyer's wallet can do that",
    NotParty: "only the buyer or the supplier can do that (and not on their own offer)",
    TooLate: "the deadline for that has passed",
    TooEarly: "the deadline hasn't passed yet",
    BadAmount: "that amount isn't possible (more than what's locked, or zero)",
    NoOffer: "there's no split offer to accept",
    OfferMismatch: "the split offer changed; check it again",
  };
  const name = e.cause?.data?.errorName ?? e.data?.errorName;
  console.log(`\nThe vault would refuse "${cmd}" right now: ${why[name] ?? e.shortMessage ?? e.message}. Nothing was sent.`);
  process.exit(1);
}
if (!SEND) {
  console.log(`\nPREVIEW ONLY. "${cmd}" would succeed. Nothing was sent.`);
  console.log(`To do it: npm run order -- ${process.argv.slice(2).join(" ")} --send`);
  process.exit(0);
}
const wallet = taggedWallet(account);
const hash = await wallet.writeContract({ address: ARRA_VAULT, abi: vaultAbi, functionName: fn, args, feeCurrency: USDT_FEE_ADAPTER });
console.log(`\nSent: ${celoscanTx(hash)}`);
const receipt = await client.waitForTransactionReceipt({ hash });
const tag = await tagOf(verifyTx, client, hash);
const after = await readSoon((blockNumber) => client.readContract({ address: ARRA_VAULT, abi: vaultAbi, functionName: "getOrder", args: [id], ...(blockNumber ? { blockNumber } : {}) }), receipt.blockNumber);
console.log(`Status    : ${receipt.status}`);
console.log(`Tag on tx : ${tag ? tag.codes.join(", ") : "MISSING"}`);
console.log(`Order now : ${["None", "Pending", "Active", "Shipped", "Disputed", "Released", "Refunded", "Settled"][Number(after.status)]}, ${Number(after.held) / 1e6} USDT still locked`);
