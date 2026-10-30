// Wallet + vault calls from the browser. Works in MiniPay (fees in USDT, no
// CELO needed) and in other wallets. Every transaction carries Arra's
// attribution tag so the activity is credited to the project.
import { createPublicClient, createWalletClient, custom, http, parseUnits, parseEther, parseEventLogs } from "viem";
import { celo } from "viem/chains";
import { withAttribution } from "@celo/attribution-tags";
import vaultAbi from "./vaultAbi.json";
import legacyVaultAbi from "./vaultAbi.v3.json";

// Where new orders go. The server says which vault is current (after an upgrade,
// older orders stay in older vaults and their pages use that order's vault).
export let VAULT = "0x5a1f66d1e8e905efb176a5f647d0b51d8a979422";
export let KEEPER_FEE = 0n;
// v4 vaults: check period from arrival, deadlines can move later, disputes end by themselves.
export let VAULT_V4 = false;
let health;
export function currentVault() {
  health ??= fetch("/api/health")
    .then((r) => r.json())
    .then((h) => {
      if (h.vault) VAULT = h.vault;
      KEEPER_FEE = BigInt(h.keeperFee ?? 0);
      VAULT_V4 = !!h.v4;
      return VAULT;
    })
    .catch(() => VAULT);
  return health;
}
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
export const USDT_FEE_ADAPTER = "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72";
export const TAG = "celo_00cfddd372fa";
export const EXPLORER = "https://celoscan.io";
export const toUnits = (usd) => parseUnits(String(usd), 6);

const erc20 = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

// Celo confirms in about a second, so check for receipts every ~0.8 s (viem's default is 4 s).
export const reader = createPublicClient({ chain: celo, transport: http(undefined, { retryCount: 4, retryDelay: 400 }), pollingInterval: 800 });

// Right after a transaction, a public node can be a block behind and wrongly
// predict the next one would fail. Re-check a few times before believing it.
async function simulateSoon(params, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await reader.simulateContract(params);
    } catch (e) {
      // Paused vault: new orders are moving to a newer vault (an upgrade). Say so plainly.
      const name = e?.cause?.data?.errorName ?? e?.data?.errorName;
      if (name === "IsPaused") throw new Error("Arra is moving new orders to its upgraded vault right now. Nothing was sent. Please try again in a few minutes.");
      if (i >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
}
export const hasWallet = () => typeof window !== "undefined" && !!window.ethereum;
export const isMiniPay = () => hasWallet() && !!window.ethereum.isMiniPay;

let wallet;
export async function connect() {
  if (!hasWallet()) throw new Error("No wallet found. Open Arra inside MiniPay or a wallet browser.");
  const [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
  await onCelo().catch(() => {});
  setSigner(address);
  return address;
}

const CELO_PARAMS = {
  chainId: "0xa4ec",
  chainName: "Celo",
  nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 },
  rpcUrls: ["https://forno.celo.org"],
  blockExplorerUrls: ["https://celoscan.io"],
};

/** Puts the wallet on Celo, adding the network first if the wallet doesn't know it (e.g. MetaMask). */
async function onCelo() {
  if (isMiniPay()) return; // always on Celo
  const id = await window.ethereum.request({ method: "eth_chainId" }).catch(() => null);
  if (id && parseInt(id, 16) === 42220) return;
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa4ec" }] });
  } catch (e) {
    if (e?.code === 4902 || /unrecognized|not added|unknown chain/i.test(e?.message ?? "")) {
      await window.ethereum.request({ method: "wallet_addEthereumChain", params: [CELO_PARAMS] });
    } else if (e?.code === 4001) {
      throw new Error("Switch your wallet to the Celo network to continue.");
    }
  }
  const now = await window.ethereum.request({ method: "eth_chainId" }).catch(() => null);
  if (now && parseInt(now, 16) !== 42220) throw new Error("Your wallet is on another network. Switch it to Celo, then try again.");
}

/** (Re)builds the signer for this address, e.g. after the wallet switches account. */
export function setSigner(address) {
  wallet = address && hasWallet() ? createWalletClient({ account: address, chain: celo, transport: custom(window.ethereum) }).extend(withAttribution(TAG)) : null;
}

// Some mobile wallets connect on page load without the app's Connect button, so
// the page knows the address but the signer was never set up. Set it up on
// demand from whatever account the wallet is using now.
async function ensureWallet() {
  if (!hasWallet()) throw new Error("No wallet found. Open Arra inside MiniPay or a wallet browser.");
  let [address] = await window.ethereum.request({ method: "eth_accounts" }).catch(() => []);
  if (!address) [address] = await window.ethereum.request({ method: "eth_requestAccounts" });
  if (!address) throw new Error("Connect your wallet first.");
  if (!wallet || wallet.account.address.toLowerCase() !== address.toLowerCase()) setSigner(address);
  await onCelo();
  return wallet;
}

// MiniPay chooses the fee currency itself (users never hold CELO) and only takes
// legacy transactions, so inside MiniPay we send plain requests with no fee fields,
// as in its own examples. Other wallets pay fees in CELO as usual.
const feeOpts = () => ({});

async function write(address, abi, functionName, args, { onSent } = {}) {
  await ensureWallet();
  await simulateSoon({ account: wallet.account, address, abi, functionName, args });
  const hash = await wallet.writeContract({ address, abi, functionName, args, ...feeOpts() });
  onSent?.(hash);
  const receipt = await reader.waitForTransactionReceipt({ hash, retryCount: 20 });
  if (receipt.status !== "success") throw new Error("The transaction failed onchain.");
  return hash;
}

// ---- Gas help: a supplier needs a tiny network fee to accept ----
export const celoBalance = (who) => reader.getBalance({ address: who });
// Below this, a wallet that pays fees in CELO can't reliably send a transaction.
export const GAS_ENOUGH = parseEther("0.002");

/** Sends a little CELO to someone so they can pay network fees. */
export async function sendCelo(to, amount, { onSent } = {}) {
  await ensureWallet();
  const hash = await wallet.sendTransaction({ to, value: parseEther(String(amount)), ...feeOpts() });
  onSent?.(hash);
  const receipt = await reader.waitForTransactionReceipt({ hash, retryCount: 20 });
  if (receipt.status !== "success") throw new Error("The transfer failed onchain.");
  return hash;
}

/** Sends a little USDT; MiniPay and Valora can pay fees with it. */
export const sendUsdt = (to, usd, opts) => write(USDT, erc20, "transfer", [to, toUnits(usd)], opts);

export const usdtBalance = (who) => reader.readContract({ address: USDT, abi: erc20, functionName: "balanceOf", args: [who] });

export async function lockOrder({ buyer, supplier, total, depositBps, acceptBy, shipBy, disputeWindow, transit = 0, ref }, onStep = () => {}, onSent = () => {}) {
  const VAULT = await currentVault();
  const allowance = await reader.readContract({ address: USDT, abi: erc20, functionName: "allowance", args: [buyer, VAULT] });
  if (allowance < total) {
    onStep("approve");
    await write(USDT, erc20, "approve", [VAULT, total], { onSent: (h) => onSent("approve", h) });
  }
  onStep("lock");
  await ensureWallet();
  // v4 takes the transit time too; older vaults don't.
  const abi = VAULT_V4 ? vaultAbi : legacyVaultAbi;
  const args = VAULT_V4
    ? [supplier, total, depositBps, BigInt(acceptBy), BigInt(shipBy), disputeWindow, transit, ref]
    : [supplier, total, depositBps, BigInt(acceptBy), BigInt(shipBy), disputeWindow, ref];
  await simulateSoon({ account: wallet.account, address: VAULT, abi, functionName: "createOrder", args });
  const hash = await wallet.writeContract({ address: VAULT, abi, functionName: "createOrder", args, ...feeOpts() });
  onSent("lock", hash);
  const receipt = await reader.waitForTransactionReceipt({ hash, retryCount: 20 });
  // Read the id from the event, not the simulation, in case someone else ordered at the same moment.
  const [created] = parseEventLogs({ abi: vaultAbi, eventName: "OrderCreated", logs: receipt.logs });
  return { id: Number(created.args.id), hash };
}

// One function per button. Names match the contract.
// `vault`: the vault this order lives in (the order page passes it).
export const vaultCall = (functionName, args, opts, vault = VAULT) => write(vault, vaultAbi, functionName, args, opts);

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
  await ensureWallet();
  onStep("quote");
  let q;
  try {
    q = await api.fxQuote(taker, usd);
  } catch (e) {
    // Only without a Textile partner key on the server: prove once (free, no gas)
    // that this wallet is yours. Textile confirmed MiniPay can sign this too.
    if (e.status !== 401) throw e;
    onStep("sign");
    let proof;
    try {
      proof = await signTakerProof(taker);
    } catch (err) {
      if (/reject|denied|cancel/i.test(err?.shortMessage ?? err?.message ?? "")) throw err;
      throw new Error("Your wallet couldn't sign the free ownership message Textile needs. Pay with USDT instead, or try again from another Celo wallet.");
    }
    q = await api.fxQuote(taker, usd, proof);
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

// ---- Notes and evidence: signed by the wallet (free, moves no money) ----
const ZERO32 = `0x${"0".repeat(64)}`;
export function noteTypedData({ orderId, kind, text, photo = ZERO32, replyTo = ZERO32, at }) {
  return {
    domain: { name: "Arra Notes", version: "1", chainId: 42220 },
    types: {
      Note: [
        { name: "orderId", type: "uint256" },
        { name: "kind", type: "string" },
        { name: "text", type: "string" },
        { name: "photo", type: "bytes32" },
        { name: "replyTo", type: "bytes32" },
        { name: "at", type: "uint256" },
      ],
    },
    primaryType: "Note",
    message: { orderId: BigInt(orderId), kind, text, photo, replyTo, at: BigInt(at) },
  };
}

/** Signs a note for an order and returns the body the server expects. */
export async function signNote(orderId, { kind, text = "", photo = ZERO32, replyTo = ZERO32 }) {
  const w = await ensureWallet();
  const at = Math.floor(Date.now() / 1000);
  const signature = await w.signTypedData({ account: w.account, ...noteTypedData({ orderId, kind, text, photo, replyTo, at }) });
  return { kind, text, photo, replyTo, at, signature };
}

/** Shrinks a photo on the phone to a JPEG of at most 1280 px before upload. */
export function shrinkPhoto(file, max = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k);
      c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(img.src);
      resolve(c.toDataURL("image/jpeg", 0.82).split(",")[1]);
    };
    img.onerror = () => reject(new Error("That file isn't a photo we can read"));
    img.src = URL.createObjectURL(file);
  });
}
