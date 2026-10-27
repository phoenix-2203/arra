// Textile FX client (RFQ v2 + Ramp v2). Keyless by default: firm quotes are
// authorised by a "TakerControl" EIP-712 signature from the taker's wallet.
// Docs: https://docs.textilecredit.com/api/v2/
import { toHex } from "viem";

export const TEXTILE_API = process.env.TEXTILE_API ?? "https://api.textilecredit.com/v2";
export const CELO_CHAIN_ID = 42220;
export const CNGN = "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f";
export const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
export const REACTOR = "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3";
// Builder codes travel with each quote so Textile can attribute the flow.
export const BUILDER_CODES = ["arra", "celo_00cfddd372fa"];

/** EIP-712 typed data for proof of wallet control (no verifyingContract). */
export function takerControlTypedData({ taker, chainId, nonce, issuedAt }) {
  return {
    domain: { name: "Textile Taker Control", version: "1", chainId },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl",
    message: { taker, chainId: BigInt(chainId), nonce, issuedAt: BigInt(issuedAt) },
  };
}

/** Signs a fresh proof with any viem account or wallet client that has signTypedData. */
export async function signTakerProof(signer, taker, chainId = CELO_CHAIN_ID) {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const issuedAt = Date.now();
  const signature = await signer.signTypedData({ ...(signer.address ? {} : { account: taker }), ...takerControlTypedData({ taker, chainId, nonce, issuedAt }) });
  return { nonce, issuedAt, signature };
}

export class TextileError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? body?.message ?? `Textile request failed (${status})`);
    this.status = status;
    this.code = body?.error?.code ?? body?.code;
    this.body = body;
  }
}

export function textileClient({ base = TEXTILE_API, apiKey = process.env.TEXTILE_API_KEY, fetchImpl = fetch } = {}) {
  async function call(method, path, body, headers = {}) {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { "content-type": "application/json" } : {}),
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text };
    }
    if (!res.ok) throw new TextileError(res.status, data);
    return data;
  }

  const pair = (side) => (side === "sellUsdt" ? { sellToken: USDT, buyToken: CNGN } : { sellToken: CNGN, buyToken: USDT });

  return {
    /** Indicative price. side "buyUsdt" (cNGN -> USDT, default) or "sellUsdt". */
    preview: ({ side = "buyUsdt", sellAmount, buyAmount, chainId = CELO_CHAIN_ID }) =>
      call("POST", "/rfq/preview", { chainId, ...pair(side), ...(sellAmount ? { sellAmount: String(sellAmount) } : { buyAmount: String(buyAmount) }) }),

    /** Firm quote bound to `taker`. Throws TextileError 401 proof_of_control_required when a proof is needed. */
    request: ({ side = "buyUsdt", sellAmount, buyAmount, taker, takerProof, chainId = CELO_CHAIN_ID, builderCodes = BUILDER_CODES }) =>
      call("POST", "/rfq/request", {
        chainId,
        ...pair(side),
        ...(sellAmount ? { sellAmount: String(sellAmount) } : { buyAmount: String(buyAmount) }),
        taker,
        ...(takerProof ? { takerProof } : {}),
        builderCodes,
      }),

    submit: (rfqId, claimToken, txHash) => call("POST", `/rfq/${rfqId}/submit`, { txHash }, { "x-rfq-claim": claimToken }),
    cancel: (rfqId, claimToken) => call("POST", `/rfq/${rfqId}/cancel`, {}, { "x-rfq-claim": claimToken }),
    status: (rfqId, claimToken) => call("GET", `/rfq/${rfqId}`, null, { "x-rfq-claim": claimToken }),

    // ---- Ramp: NGN <-> cNGN through a licensed provider -------------------
    rampProviders: () => call("GET", "/ramp/providers"),
    rampCustomer: (body) => call("POST", "/ramp/customers", body),
    rampKyc: (body) => call("POST", "/ramp/customers/kyc", body),
    rampKycStatus: (body) => call("POST", "/ramp/customers/kyc/status", body),
    rampTransfer: (body) => call("POST", "/ramp/transfers", body),
    rampTransferStatus: (id, claimToken) => call("GET", `/ramp/transfers/${id}`, null, { "x-ramp-claim": claimToken }),
  };
}

/** Naira per dollar from a quote's atomic amounts (both tokens use 6 decimals). */
export function ngnPerUsd(quote, side = "buyUsdt") {
  const cngn = BigInt(side === "buyUsdt" ? quote.sellAmount ?? quote.takerPays : quote.buyAmount);
  const usdt = BigInt(side === "buyUsdt" ? quote.buyAmount : quote.sellAmount ?? quote.takerPays);
  if (usdt === 0n) return null;
  return Number((cngn * 10000n) / usdt) / 10000;
}

/** Does the ramp offer NGN -> cNGN delivered on Celo right now? */
export function rampSupportsCelo(providersBody) {
  const list = providersBody?.providers ?? providersBody?.data ?? [];
  return list.filter((p) => {
    const chains = p.chainIds ?? p.chains ?? Object.keys(p.limits ?? {}).map(Number);
    return chains.map(Number).includes(CELO_CHAIN_ID);
  });
}
