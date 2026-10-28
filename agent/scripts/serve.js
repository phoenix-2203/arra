// Runs Arra on the VPS: the API + app on 127.0.0.1:PORT (Caddy in front), and
// the keeper every 10 minutes when KEEPER=1 and the agent key is in .env.
// Usage: npm start
import { fileURLToPath } from "node:url";
import { createApp, listen } from "../src/server.js";
import { publicClient, agentAccount, taggedWallet } from "../src/wallet.js";
import { ARRA_VAULT, USDT_FEE_ADAPTER } from "../src/config.js";
import { runKeeper } from "../src/keeper.js";

const PORT = Number(process.env.PORT ?? 8791);
const client = publicClient();
const app = createApp({
  client,
  vault: ARRA_VAULT,
  dataDir: process.env.DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url)),
  staticDir: process.env.STATIC_DIR ?? fileURLToPath(new URL("../../app/dist", import.meta.url)),
});
await listen(app, PORT);
console.log(`Arra on http://127.0.0.1:${PORT}  vault ${ARRA_VAULT}`);

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
