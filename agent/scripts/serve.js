// Runs Arra on the VPS: the API + app on 127.0.0.1:PORT (Caddy in front), and
// the keeper every 10 minutes when KEEPER=1 and the agent key is in .env.
// Usage: npm start
import { fileURLToPath } from "node:url";
import { createApp, listen } from "../src/server.js";
import { publicClient, agentAccount, taggedWallet } from "../src/wallet.js";
import { ARRA_VAULT, USDT_FEE_ADAPTER } from "../src/config.js";
import { runKeeper } from "../src/keeper.js";
import { LogIndex } from "../src/history.js";
import { DripBook, dripSettings, runGasDrip } from "../src/gasDrip.js";

const PORT = Number(process.env.PORT ?? 8791);
const client = publicClient();
// Start reading vault history from the block it was deployed in.
const DEPLOY_TX = "0xf8d8403f3574d1776a2d440e90fadbe49bb3d7706c5d49bc436a3dc3001bbe86";
const fromBlock = process.env.VAULT_DEPLOY_BLOCK ?? (await client.getTransactionReceipt({ hash: DEPLOY_TX }).then((r) => r.blockNumber).catch(() => null));
const dataDir = process.env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url));
const drip = dripSettings();
const drips = drip.enabled ? new DripBook(`${dataDir}/drips.json`) : null;
const app = createApp({
  client,
  vault: ARRA_VAULT,
  history: new LogIndex({ client, vault: ARRA_VAULT, fromBlock }),
  dataDir,
  drips,
  staticDir: process.env.STATIC_DIR ?? fileURLToPath(new URL("../../app/dist", import.meta.url)),
});
await listen(app, PORT);
console.log(`Arra on http://127.0.0.1:${PORT}  vault ${ARRA_VAULT}`);

// Gas drip (GAS_DRIP=1): send a little CELO to suppliers of new orders whose
// wallets are empty, so they can accept. Checks every minute; strict limits in gasDrip.js.
if (drip.enabled) {
  const wallet = taggedWallet(agentAccount());
  const drop = () =>
    runGasDrip({ client, wallet, vault: ARRA_VAULT, book: drips, settings: drip, txOpts: { feeCurrency: USDT_FEE_ADAPTER } }).catch((e) =>
      console.error("gas drip error:", e.shortMessage ?? e.message),
    );
  drop();
  setInterval(drop, 60 * 1000);
  console.log(`Gas drip on: up to ${drip.dailyMax} suppliers a day get ${Number(drip.amount) / 1e18} CELO`);
}

if (process.env.KEEPER === "1") {
  const wallet = taggedWallet(agentAccount());
  const tick = () =>
    runKeeper({ client, wallet, vault: ARRA_VAULT, txOpts: { feeCurrency: USDT_FEE_ADAPTER } }).catch((e) =>
      console.error("keeper error:", e.shortMessage ?? e.message),
    );
  tick();
  setInterval(tick, 10 * 60 * 1000);
  console.log("Keeper on: checks deadlines every 10 minutes");
}
