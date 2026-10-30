// Runs against a local Anvil chain (no real money). Proves that every kind of
// transaction the agent sends (deploy, contract call, plain transfer) ends with
// Arra's ERC-8021 attribution tag.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineChain, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fromDataSuffix, toDataSuffix } from "@celo/attribution-tags";
import { taggedWallet, publicClient } from "../src/wallet.js";
import { ATTRIBUTION_TAG } from "../src/config.js";

const RPC = "http://127.0.0.1:8547";
const local = defineChain({
  id: 31337,
  name: "anvil",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});
// Anvil's well-known public test key (holds only fake local ETH).
const TEST_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SUFFIX = toDataSuffix(ATTRIBUTION_TAG).slice(2).toLowerCase();

const art = (name, file) =>
  JSON.parse(readFileSync(new URL(`../../contracts/out/${file}/${name}.json`, import.meta.url)));

let anvil;
before(async () => {
  anvil = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ["--port", "8547", "--silent"]);
  await new Promise((r) => setTimeout(r, 1500));
});
after(() => anvil?.kill());

const tagOf = (input) => fromDataSuffix(input)?.codes ?? [];

test("deploy, writeContract and plain transfers all carry the Arra tag", async () => {
  const account = privateKeyToAccount(TEST_KEY);
  const wallet = taggedWallet(account, local, RPC);
  const client = publicClient(local, RPC);

  const token = art("MockUSDT", "ArraVault.t.sol");
  const vault = art("ArraVault", "ArraVault.sol");

  // 1. deploy
  const h1 = await wallet.deployContract({ abi: token.abi, bytecode: token.bytecode.object });
  const r1 = await client.waitForTransactionReceipt({ hash: h1 });
  const tx1 = await client.getTransaction({ hash: h1 });
  assert.ok(tx1.input.toLowerCase().endsWith(SUFFIX), "deploy is tagged");
  assert.deepEqual(tagOf(tx1.input), [ATTRIBUTION_TAG]);

  const h2 = await wallet.deployContract({
    abi: vault.abi,
    bytecode: vault.bytecode.object,
    args: [r1.contractAddress, parseUnits("50", 6), account.address, 5n, 10_000n],
  });
  const r2 = await client.waitForTransactionReceipt({ hash: h2 });
  assert.equal(r2.status, "success", "vault deploys with the suffix appended");
  // the trailing tag must not corrupt the constructor arguments
  const read = (functionName) =>
    client.readContract({ address: r2.contractAddress, abi: vault.abi, functionName });
  assert.equal((await read("token")).toLowerCase(), r1.contractAddress.toLowerCase());
  assert.equal(await read("nextId"), 5n, "all constructor arguments survive the tag");
  assert.equal(await read("keeperFee"), 10_000n);
  assert.equal(await read("maxOrder"), parseUnits("50", 6));
  assert.equal(await read("owner"), account.address);
  assert.deepEqual(tagOf((await client.getTransaction({ hash: h2 })).input), [ATTRIBUTION_TAG]);

  // 2. contract call (the suffix must not break execution)
  const h3 = await wallet.writeContract({
    address: r1.contractAddress,
    abi: token.abi,
    functionName: "mint",
    args: [account.address, parseUnits("10", 6)],
  });
  const r3 = await client.waitForTransactionReceipt({ hash: h3 });
  assert.equal(r3.status, "success");
  assert.deepEqual(tagOf((await client.getTransaction({ hash: h3 })).input), [ATTRIBUTION_TAG]);

  // 3. plain value transfer with no data
  const h4 = await wallet.sendTransaction({ to: r2.contractAddress === account.address ? r1.contractAddress : "0x000000000000000000000000000000000000dEaD", value: 1n });
  await client.waitForTransactionReceipt({ hash: h4 });
  assert.deepEqual(tagOf((await client.getTransaction({ hash: h4 })).input), [ATTRIBUTION_TAG]);
});
