// Local Anvil chain (fake money): the keeper refunds or pays out exactly when
// deadlines pass, and nextActions matches what the contract allows.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineChain, parseUnits, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { taggedWallet, publicClient } from "../src/wallet.js";
import { vaultAbi, vaultArtifact, readOrder, nextActions, explain } from "../src/vault.js";
import { findDue, runKeeper } from "../src/keeper.js";

const RPC = "http://127.0.0.1:8548";
const local = defineChain({ id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
// Anvil's public test keys (fake local ETH only).
const KEYS = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
];
const [agent, buyer, supplier] = KEYS.map((k) => privateKeyToAccount(k));
const mock = JSON.parse(readFileSync(new URL("../../contracts/out/ArraVault.t.sol/MockUSDT.json", import.meta.url)));

let anvil, client, vault, token;
const as = (account) => createWalletClient({ account, chain: local, transport: http(RPC) });
const send = async (account, address, abi, functionName, args) => {
  const hash = await as(account).writeContract({ address, abi, functionName, args });
  const r = await client.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", functionName);
};
const warp = async (seconds) => {
  await client.request({ method: "evm_increaseTime", params: [seconds] });
  await client.request({ method: "evm_mine", params: [] });
};
const now = async () => Number((await client.getBlock()).timestamp);

before(async () => {
  anvil = spawn(`${process.env.HOME}/.foundry/bin/anvil`, ["--port", "8548", "--silent"]);
  await new Promise((r) => setTimeout(r, 1500));
  client = publicClient(local, RPC);
  const w = as(agent);
  const t = await client.waitForTransactionReceipt({ hash: await w.deployContract({ abi: mock.abi, bytecode: mock.bytecode.object }) });
  token = t.contractAddress;
  const v = await client.waitForTransactionReceipt({
    hash: await w.deployContract({ abi: vaultAbi, bytecode: vaultArtifact.bytecode, args: [token, parseUnits("50", 6), agent.address] }),
  });
  vault = v.contractAddress;
  await send(agent, token, mock.abi, "mint", [buyer.address, parseUnits("100", 6)]);
  await send(buyer, token, mock.abi, "approve", [vault, parseUnits("100", 6)]);
});
after(() => anvil?.kill());

const balance = (who) => client.readContract({ address: token, abi: mock.abi, functionName: "balanceOf", args: [who] });

test("keeper refunds an order the supplier never accepted, then pays out a shipped one", async () => {
  const t0 = await now();
  // Order 1: never accepted.
  await send(buyer, vault, vaultAbi, "createOrder", [supplier.address, parseUnits("10", 6), 3000, BigInt(t0 + 86400), BigInt(t0 + 10 * 86400), 86400, `0x${"11".repeat(32)}`]);
  // Order 2: accepted and shipped.
  await send(buyer, vault, vaultAbi, "createOrder", [supplier.address, parseUnits("20", 6), 3000, BigInt(t0 + 86400), BigInt(t0 + 10 * 86400), 86400, `0x${"22".repeat(32)}`]);
  await send(supplier, vault, vaultAbi, "accept", [2n]);
  await send(supplier, vault, vaultAbi, "markShipped", [2n, `0x${"00".repeat(32)}`]);

  let o1 = await readOrder(client, vault, 1);
  assert.equal(o1.status, "Pending");
  assert.deepEqual(nextActions(o1, await now(), "supplier"), ["accept", "decline"]);
  assert.deepEqual(nextActions(o1, await now(), "buyer"), ["cancel"]);
  assert.match(explain(o1, await now()), /Waiting for the supplier/);
  assert.equal((await findDue(client, vault, await now())).length, 0, "nothing due yet");
  assert.equal(await readOrder(client, vault, 99), null);

  await warp(86400 + 60);
  const due = await findDue(client, vault, await now());
  assert.deepEqual(due.map((d) => [d.id, d.action]), [[1, "reclaim"], [2, "claim"]]);

  const keeper = taggedWallet(agent, local, RPC);
  const results = await runKeeper({ client, wallet: keeper, vault, now: await now(), log: () => {} });
  assert.deepEqual(results.map((r) => r.status), ["success", "success"]);

  o1 = await readOrder(client, vault, 1);
  const o2 = await readOrder(client, vault, 2);
  assert.equal(o1.status, "Refunded");
  assert.equal(o2.status, "Released");
  assert.equal(await balance(buyer.address), parseUnits("80", 6), "buyer got order 1 back, paid order 2");
  assert.equal(await balance(supplier.address), parseUnits("20", 6), "supplier got deposit + balance of order 2");
  assert.equal(await balance(agent.address), 0n, "the keeper never receives money");
  assert.equal((await findDue(client, vault, await now())).length, 0, "nothing left to do");
});

test("split offers show up as an action for the other side only", async () => {
  const t0 = await now();
  await send(agent, token, mock.abi, "mint", [buyer.address, parseUnits("10", 6)]);
  await send(buyer, token, mock.abi, "approve", [vault, parseUnits("10", 6)]);
  await send(buyer, vault, vaultAbi, "createOrder", [supplier.address, parseUnits("10", 6), 2000, BigInt(t0 + 86400), BigInt(t0 + 5 * 86400), 86400, `0x${"33".repeat(32)}`]);
  await send(supplier, vault, vaultAbi, "accept", [3n]);
  await send(supplier, vault, vaultAbi, "proposeSplit", [3n, parseUnits("6", 6)]);
  const o = await readOrder(client, vault, 3);
  assert.equal(o.splitOffer.toSupplier, "6000000");
  assert.ok(nextActions(o, await now(), "buyer").includes("acceptSplit"));
  assert.ok(!nextActions(o, await now(), "supplier").includes("acceptSplit"));
});

test("history: each order's steps in order, with times and transactions; homepage totals", async () => {
  const { LogIndex, vaultStats } = await import("../src/history.js");
  const idx = new LogIndex({ client, vault, fromBlock: 0n, chunk: 3n }); // tiny chunks to exercise paging
  const t1 = await idx.timeline(1);
  assert.deepEqual(t1.map((s) => s.event), ["OrderCreated", "BalanceRefunded"]);
  assert.equal(t1[0].amount, "10000000");
  const t2 = await idx.timeline(2);
  assert.deepEqual(t2.map((s) => s.event), ["OrderCreated", "OrderAccepted", "OrderShipped", "BalanceReleased"]);
  assert.equal(t2[1].amount, "6000000", "deposit paid on accept");
  assert.ok(t2.every((s, i) => i === 0 || s.at >= t2[i - 1].at), "times go forward");
  assert.match(t2[0].tx, /^0x[0-9a-f]{64}$/);
  const t3 = await idx.timeline(3);
  assert.deepEqual(t3.map((s) => s.event), ["OrderCreated", "OrderAccepted", "SplitProposed"]);
  assert.equal((await idx.timeline(99)).length, 0);

  const st = await vaultStats(client, vault);
  assert.equal(st.orders, 3);
  assert.equal(st.completed, 2);
  assert.equal(st.buyers, 1);
  assert.equal(st.suppliers, 1);
  assert.equal(st.totalValue, "40000000");
  assert.equal(st.lockedNow, "8000000", "order 3 keeps 80% of $10 locked");
});
