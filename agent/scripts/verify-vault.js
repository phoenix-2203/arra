// Publishes the vault's source code so anyone can read and check it.
// 1. Sourcify (no account needed). Blockscout explorers pick it up from there.
// 2. Celoscan, only if CELOSCAN_API_KEY is set in .env (a free Etherscan.io
//    account key works for Celoscan; it is not a wallet secret, but keep it private).
// Usage: npm run verify-vault              (the newest vault in src/config.js VAULTS)
//        npm run verify-vault -- 0x5a1f…   (any listed vault, by address)
import { readFileSync } from "node:fs";
import { encodeAbiParameters } from "viem";
import { VAULTS, USDT, MAX_ORDER_USDT, KEEPER_FEE_USDT } from "../src/config.js";

const OWNER = "0xF4Fa62d294E5BcB514D27612998D7459c5D97053";
const wanted = process.argv.find((a) => /^0x[0-9a-fA-F]{40}$/.test(a))?.toLowerCase();
const index = wanted ? VAULTS.findIndex((v) => v.address.toLowerCase() === wanted) : VAULTS.length - 1;
if (index < 0) {
  console.log(`${wanted} isn't one of Arra's vaults in src/config.js.`);
  process.exit(1);
}
const entry = VAULTS[index];
// The source each version was built from: 0 = v2, 1 = v3, 2+ = current.
const INPUTS = ["../abi/ArraVault.v2.input.json", "../abi/ArraVault.v3.input.json"];
const DEPLOY_TX = entry.deployTx;
// v2 (the first vault) took 3 constructor arguments; v3 adds the first order number and the keeper fee.
const isV2 = entry.address.toLowerCase() === "0x3da5f9d36d1ae8769a9460a7788a21c8041c7bb3";
const COMPILER = "0.8.28+commit.7893614a";
const CONTRACT = "src/ArraVault.sol:ArraVault";
const CHAIN_ID = 42220;

const address = entry.address;
const stdJsonInput = JSON.parse(readFileSync(new URL(INPUTS[index] ?? "../abi/ArraVault.input.json", import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log(`Verify ArraVault at ${address}\n`);

// ---- Sourcify ------------------------------------------------------------
try {
  const res = await fetch(`https://sourcify.dev/server/v2/verify/${CHAIN_ID}/${address}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stdJsonInput, compilerVersion: COMPILER, contractIdentifier: CONTRACT, creationTransactionHash: DEPLOY_TX }),
  });
  const body = await res.json();
  if (res.status === 409) {
    console.log("Sourcify  : already verified");
  } else if (!body.verificationId) {
    console.log("Sourcify  : failed", res.status, JSON.stringify(body));
  } else {
    let job;
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      job = await (await fetch(`https://sourcify.dev/server/v2/verify/${body.verificationId}`)).json();
      if (job.isJobCompleted) break;
    }
    if (job?.contract?.match || job?.contract?.runtimeMatch) {
      console.log(`Sourcify  : verified (${job.contract.match || job.contract.runtimeMatch} match)`);
    } else {
      console.log("Sourcify  : not verified", JSON.stringify(job?.error ?? job));
    }
  }
  console.log(`            https://repo.sourcify.dev/${CHAIN_ID}/${address}`);
  console.log(`            https://celo.blockscout.com/address/${address}?tab=contract`);
} catch (e) {
  console.log("Sourcify  : error", e.message);
}

// ---- Celoscan (optional) ---------------------------------------------------
const key = process.env.CELOSCAN_API_KEY;
if (!key) {
  console.log("\nCeloscan  : skipped (add CELOSCAN_API_KEY to .env to also verify there)");
  process.exit(0);
}
const constructorArgs = (
  isV2
    ? encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "address" }], [USDT, MAX_ORDER_USDT, OWNER])
    : encodeAbiParameters(
        [{ type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "uint128" }],
        [USDT, MAX_ORDER_USDT, OWNER, BigInt(entry.firstId), KEEPER_FEE_USDT],
      )
).slice(2);
const api = `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}`;
const form = new URLSearchParams({
  apikey: key,
  module: "contract",
  action: "verifysourcecode",
  contractaddress: address,
  sourceCode: JSON.stringify(stdJsonInput),
  codeformat: "solidity-standard-json-input",
  contractname: CONTRACT,
  compilerversion: `v${COMPILER}`,
  constructorArguements: constructorArgs, // (sic) Etherscan's spelling
});
const submit = await (await fetch(api, { method: "POST", body: form })).json();
if (submit.status !== "1") {
  console.log("\nCeloscan  :", submit.result);
  process.exit(0);
}
for (let i = 0; i < 20; i++) {
  await sleep(3000);
  const s = await (await fetch(`${api}&module=contract&action=checkverifystatus&guid=${submit.result}&apikey=${key}`)).json();
  if (!/pending/i.test(s.result)) {
    console.log("\nCeloscan  :", s.result);
    break;
  }
}
console.log(`            https://celoscan.io/address/${address}#code`);
