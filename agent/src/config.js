// Arra configuration. Addresses checked against official sources on 27 Oct 2026:
//  - USDT + fee adapter: celo-org/agent-skills fee-abstraction skill
//  - ERC-8004 Identity Registry: docs.celo.org/build-on-celo/build-with-ai/8004
//  - Attribution tag: issued by Loops House at enrolment (Agents on Open Rails)
import { celo } from "viem/chains";

export const CHAIN = celo; // Celo mainnet, chain 42220. Testnet activity never counts.
export const RPC_URL = process.env.CELO_RPC_URL || "https://forno.celo.org";

// Every transaction Arra sends carries this ERC-8021 tag. Never remove it.
export const ATTRIBUTION_TAG = "celo_00cfddd372fa";

export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"; // 6 decimals
export const USDT_FEE_ADAPTER = "0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72"; // pay gas in USDT
export const USDT_DECIMALS = 6;

export const IDENTITY_REGISTRY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432";

// Every Arra vault, oldest first. Contracts can't be edited, so an upgrade is a new
// vault: new orders go to the last one, old orders finish where they are, and order
// numbers never overlap (firstId), so the app shows them all as one Arra.
export const VAULTS = [
  // v2, 27 Oct 2026. Orders #1 onwards.
  { address: "0x3da5f9d36d1ae8769a9460a7788a21c8041c7bb3", firstId: 1, deployTx: "0xf8d8403f3574d1776a2d440e90fadbe49bb3d7706c5d49bc436a3dc3001bbe86" },
  // v3 (keeper fee) is added here after deployment.
];
// Where new orders go. ARRA_VAULT in .env only matters if it names a vault not listed above.
const envVault = process.env.ARRA_VAULT?.toLowerCase();
if (envVault && !VAULTS.some((v) => v.address.toLowerCase() === envVault)) {
  VAULTS.push({ address: envVault, firstId: Number(process.env.ARRA_VAULT_FIRST_ID ?? 1), deployTx: process.env.ARRA_VAULT_DEPLOY_TX });
}
export const ARRA_VAULT = VAULTS.at(-1).address;
export const KEEPER_FEE_USDT = 10_000n; // $0.01, for vaults from v3

// Safety: the vault's per-order cap at launch, in USDT units ($50).
export const MAX_ORDER_USDT = 50n * 10n ** 6n;
