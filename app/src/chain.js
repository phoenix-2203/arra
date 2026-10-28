// Wallet + vault calls from the browser. Works in MiniPay (fees in USDT, no
// CELO needed) and in other wallets. Every transaction carries Arra's
// attribution tag so the activity is credited to the project.
import { createPublicClient, createWalletClient, custom, http, parseUnits, parseEventLogs } from "viem";
import { celo } from "viem/chains";
import { withAttribution } from "@celo/attribution-tags";
import vaultAbi from "./vaultAbi.json";

export const VAULT = "0x3da5f9d36d1ae8769a9460a7788a21c8041c7bb3";
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
export const USDT_FEE_ADAPTER = "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72";
export const TAG = "celo_00cfddd372fa";
export const EXPLORER = "https://celoscan.io";
export const toUnits = (usd) => parseUnits(String(usd), 6);

const erc20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

export const reader = createPublicClient({ chain: celo, transport: http() });
export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum;
export const isMiniPay = () => hasWallet() && !!window.ethereum.isMiniPay;

let wallet;
export async function connect() {
  if (!hasWallet()) throw new Error("No wallet found. Open Arra inside MiniPay or a wallet browser.");
  const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4ec" }] });
  } catch {
    /* MiniPay is always on Celo; other wallets may refuse, the send will then say why */
  }
  wallet = createWalletClient({ account: address, chain: celo, transport: custom(window.ethereum) }).extend(withAttribution(TAG));
  return address;
}

// MiniPay chooses the fee currency itself (users never hold CELO) and only takes
// legacy transactions, so inside MiniPay we send plain requests with no fee fields,
// as in its own examples. Other wallets pay fees in CELO as usual.
const feeOpts = () => ({});

async function write(address, abi, functionName, args) {
  if (!wallet) throw new Error("Connect your wallet first.");
  await reader.simulateContract({ account: wallet.account, address, abi, functionName, args });
  const hash = await wallet.writeContract({ address, abi, functionName, args, ...feeOpts() });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The transaction failed onchain.");
  return hash;
}

export const usdtBalance = (who) => reader.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [who] });

export async function lockOrder({ buyer, supplier, total, depositBps, acceptBy, shipBy, disputeWindow, ref }, onStep = () => {}) {
  const allowance = await reader.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [buyer, VAULT] });
  if (allowance < total) {
    onStep("approve");
    await write(USDT, erc20, "approve", [VAULT, total]);
  }
  onStep("lock");
  if (!wallet) throw new Error("Connect your wallet first.");
  const args = [supplier, total, depositBps, BigInt(acceptBy), BigInt(shipBy), disputeWindow, ref];
  await reader.simulateContract({ account: wallet.account, address: VAULT, abi: vaultAbi, functionName: "createOrder", args });
  const hash = await wallet.writeContract({ address: VAULT, abi: vaultAbi, functionName: "createOrder", args, ...feeOpts() });
  const receipt = await reader.waitForTransactionReceipt({ hash });
  // Read the id from the event, not the simulation, in case someone else ordered at the same moment.
  const [created] = parseEventLogs({ abi: vaultAbi, eventName: "OrderCreated", logs: receipt.logs });
  return { id: Number(created.args.id), hash };
}

// One function per button. Names match the contract.
export const vaultCall = (functionName, args) => write(VAULT, vaultAbi, functionName, args);

// ---- Naira payment (F11): cNGN -> exactly the USDT the order needs, on Textile FX ----
export const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
export const cngnBalance = (who) => reader.readContract({ address: CNGN, abi: erc20, functionName: "balanceOf", args: [who] });

const takerControl = (taker, nonce, issuedAt) => ({
  domain: { name: "Textile Taker Control", version: "1", chainId: 42220 },
  types: {
    TakerControl: [
      { name: "taker", type: "address" },
      { name: "chainId", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "issuedAt", type: "uint256" },
    ],
  },
  primaryType: "TakerControl",
  message: { taker, chainId: 42220n, nonce, issuedAt: BigInt(issuedAt) },
});

/** Free signature that proves wallet ownership to Textile. Moves no money. */
async function signTakerProof(taker) {
  const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  const issuedAt = Date.now();
  const signature = await wallet.signTypedData({ account: taker, ...takerControl(taker, nonce, issuedAt) });
  return { nonce, issuedAt, signature };
}

/**
 * Converts cNGN into exactly `usd` USDT in the buyer's wallet at one firm rate.
 * onStep: "quote" | "sign" | "approve" | "swap". Returns { hash, ngnPerUsd, takerPays }.
 */
export async function convertNairaToUsdt(taker, usd, api, onStep = () => {}) {
  if (!wallet) throw new Error("Connect your wallet first.");
  onStep("quote");
  let q;
  try {
    q = await api.fxQuote(taker, usd);
  } catch (e) {
    if (e.status !== 401) throw e;
    if (isMiniPay()) {
      throw new Error("Paying from naira needs a one-time wallet signature that MiniPay doesn't support yet. Pay with USDT here, or open Arra in another Celo wallet to pay from naira.");
    }
    onStep("sign");
    q = await api.fxQuote(taker, usd, await signTakerProof(taker));
  }
  if (q.status !== "quoted") throw new Error(q.reason === "no_makers_online" ? "No naira liquidity right now. Try again in a minute." : "Textile couldn't price this amount right now. Try a different amount or try again shortly.");
  const allowance = await reader.readContract({ address: CNGN, abi: erc20, functionName: "allowance", args: [taker, q.reactor] });
  if (allowance < BigInt(q.takerPays)) {
    onStep("approve");
    const a = q.transactions.approval;
    const h = await wallet.sendTransaction({ to: a.to, data: a.data, value: BigInt(a.value ?? 0), ...feeOpts() });
    await reader.waitForTransactionReceipt({ hash: h });
  }
  if (Date.now() > Date.parse(q.expiresAt)) throw new Error("The rate expired before you confirmed. Tap again for a fresh rate.");
  onStep("swap");
  const s = q.transactions.swap;
  const hash = await wallet.sendTransaction({ to: s.to, data: s.data, value: BigInt(s.value ?? 0), ...feeOpts() });
  api.fxSubmit(q.rfqId, hash).catch(() => {});
  const receipt = await reader.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error("The conversion failed onchain. Nothing was locked.");
  return { hash, ngnPerUsd: q.ngnPerUsd, takerPays: q.takerPays };
}
