import { formatUnits } from "viem";
import { publicClient } from "../src/wallet.js";
import { USDT, USDT_DECIMALS } from "../src/config.js";

export const SEND = process.argv.includes("--send");

export const erc20Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
];

export async function balances(address) {
  const client = publicClient();
  const [celo, usdt] = await Promise.all([
    client.getBalance({ address }),
    client.readContract({ address: USDT, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
  ]);
  return { celo: formatUnits(celo, 18), usdt: formatUnits(usdt, USDT_DECIMALS), usdtRaw: usdt };
}

export function previewOnly(what) {
  console.log(`\nPREVIEW ONLY. Nothing was sent.\nTo do it for real: ${what} --send\n`);
}

export const celoscanTx = (h) => `https://celoscan.io/tx/${h}`;
export const celoscanAddr = (a) => `https://celoscan.io/address/${a}`;
