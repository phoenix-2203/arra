// The agent's wallet. Every transaction it sends is tagged with Arra's attribution code.
// The private key is read only from the AGENT_PRIVATE_KEY environment variable on the
// machine that runs the agent. It is never printed, logged or sent anywhere.
import { createPublicClient, createWalletClient, encodeDeployData, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withAttribution } from "@celo/attribution-tags";
import { CHAIN, RPC_URL, ATTRIBUTION_TAG } from "./config.js";

export function publicClient(chain = CHAIN, rpcUrl = RPC_URL) {
  return createPublicClient({ chain, transport: http(rpcUrl) });
}

export function agentAccount() {
  const key = process.env.AGENT_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "AGENT_PRIVATE_KEY is missing or malformed. Put it in agent/.env on your own machine (never share it)."
    );
  }
  return privateKeyToAccount(key);
}

/** A wallet client that appends the attribution tag to every transaction it sends. */
export function taggedWallet(account = agentAccount(), chain = CHAIN, rpcUrl = RPC_URL) {
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) }).extend(
    withAttribution(ATTRIBUTION_TAG)
  );
  // @celo/attribution-tags v0.5.0 wraps sendTransaction and writeContract but NOT
  // deployContract (verified in test/tagging.test.js). Route deployments through the
  // wrapped sendTransaction so they are tagged too. Solidity ignores trailing bytes
  // after the constructor arguments, so the suffix does not change the deployment.
  return {
    ...wallet,
    deployContract: ({ abi, bytecode, args = [], ...rest }) =>
      wallet.sendTransaction({ data: encodeDeployData({ abi, bytecode, args }), ...rest }),
  };
}
