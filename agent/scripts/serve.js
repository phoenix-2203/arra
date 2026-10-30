// Runs Arra on the VPS: the API + app on 127.0.0.1:PORT (Caddy in front), and
// the keeper every 10 minutes when KEEPER=1 and the agent key is in .env.
// Every vault version is served as one Arra (see src/vaults.js).
// Usage: npm start
import { fileURLToPath } from "node:url";
import { createApp, listen } from "../src/server.js";
import { publicClient, agentAccount, taggedWallet } from "../src/wallet.js";
import { VAULTS, USDT, USDT_FEE_ADAPTER } from "../src/config.js";
import { runKeeper } from "../src/keeper.js";
import { VaultSet } from "../src/vaults.js";

const PORT = Number(process.env.PORT ?? 8791);
const client = publicClient();

// Read each vault's history from the block it was deployed in.
const blockOf = (tx) => (tx ? client.getTransactionReceipt({ hash: tx }).then((r) => r.blockNumber).catch(() => null) : null);
const vaults = new VaultSet({
  client,
  vaults: await Promise.all(VAULTS.map(async (v) => ({ address: v.address, firstId: v.firstId, fromBlock: await blockOf(v.deployTx) }))),
});

// Read history in the background at start-up, so the first visitor to History or
// an order timeline doesn't wait; then keep it fresh every minute.
const warm = () => vaults.sync().catch((e) => console.error("history sync:", e.shortMessage ?? e.message));
warm();
setInterval(warm, 60 * 1000);

const app = createApp({
  client,
  vaults,
  dataDir: process.env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url)),
  staticDir: process.env.STATIC_DIR ?? fileURLToPath(new URL("../../app/dist", import.meta.url)),
});
await listen(app, PORT);
console.log(`Arra on http://127.0.0.1:${PORT}  new orders -> ${vaults.current}  (vaults: ${vaults.addresses.join(", ")})`);

if (process.env.KEEPER === "1") {
  const wallet = taggedWallet(agentAccount());
  // The keeper watches every vault: old orders still get their refunds and payouts.
  const tick = async () => {
    for (const vault of vaults.addresses) {
      await runKeeper({ client, wallet, vault, txOpts: { feeCurrency: USDT_FEE_ADAPTER }, feeToken: USDT }).catch((e) =>
        console.error(`keeper error (${vault}):`, e.shortMessage ?? e.message),
      );
    }
  };
  tick();
  // KEEPER_EVERY_MIN=1 while recording a demo; 10 minutes is plenty normally.
  const every = Math.max(1, Number(process.env.KEEPER_EVERY_MIN ?? 10));
  setInterval(tick, every * 60 * 1000);
  console.log(`Keeper on: checks deadlines every ${every} minute${every > 1 ? "s" : ""} on ${vaults.addresses.length} vault(s)`);
}
