// The agent's keeper job: nobody should have to remember a deadline. When an
// order's clock runs out, the agent itself sends the tagged transaction that
// pays the supplier (no dispute in time) or refunds the buyer (not accepted or
// not shipped in time). The vault decides where money goes; the agent can only
// trigger it, never redirect it.
import { vaultAbi, readOrder, orderCount, dueAction } from "./vault.js";

export async function findDue(client, vault, now = Math.floor(Date.now() / 1000)) {
  const n = await orderCount(client, vault);
  const due = [];
  for (let id = 1; id <= n; id++) {
    const o = await readOrder(client, vault, id);
    const action = o && dueAction(o, now);
    if (action) due.push({ id, action, order: o });
  }
  return due;
}

/**
 * Sends one transaction per due order. `wallet` must be a taggedWallet.
 * `txOpts` carries feeCurrency on Celo. Returns what happened, per order.
 */
export async function runKeeper({ client, wallet, vault, now, txOpts = {}, log = console.log }) {
  const results = [];
  for (const { id, action } of await findDue(client, vault, now)) {
    try {
      // Simulate first so a race (someone else already settled it) costs nothing.
      await client.simulateContract({ account: wallet.account, address: vault, abi: vaultAbi, functionName: action, args: [BigInt(id)] });
      const hash = await wallet.writeContract({ address: vault, abi: vaultAbi, functionName: action, args: [BigInt(id)], ...txOpts });
      const receipt = await client.waitForTransactionReceipt({ hash });
      log(`keeper: order ${id} ${action} -> ${receipt.status} ${hash}`);
      results.push({ id, action, hash, status: receipt.status });
    } catch (e) {
      log(`keeper: order ${id} ${action} skipped: ${e.shortMessage ?? e.message}`);
      results.push({ id, action, error: e.shortMessage ?? e.message });
    }
  }
  return results;
}
