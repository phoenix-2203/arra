// Textile client against a local stand-in server (no network).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { textileClient, signTakerProof, takerControlTypedData, ngnPerUsd, rampSupportsCelo, TextileError, CNGN, USDT, BUILDER_CODES } from "../src/textile.js";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const seen = [];
let server, base;

before(async () => {
  server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : null;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: json });
    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/v2/rfq/preview") return send(200, { data: { sellAmount: "1600000000", buyAmount: "1000000" } });
    if (req.url === "/v2/rfq/request") {
      if (!json.takerProof) return send(401, { error: { code: "proof_of_control_required", message: "Sign once" } });
      const ok = await verifyTypedData({ address: json.taker, ...takerControlTypedData({ taker: json.taker, chainId: json.chainId, nonce: json.takerProof.nonce, issuedAt: json.takerProof.issuedAt }), signature: json.takerProof.signature });
      if (!ok) return send(401, { error: { code: "bad_proof" } });
      return send(200, { data: { rfqId: "rfq_1", claimToken: "rfqc_secret", status: "quoted", quote: { takerPays: "1600000000", sellAmount: "1600000000", buyAmount: "1000000", feeAmount: "160000", reactor: "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3", expiresAt: new Date(Date.now() + 60000).toISOString() }, transactions: { approval: { to: CNGN, data: "0x", value: "0" }, swap: { to: "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3", data: "0x", value: "0" } } } });
    }
    if (req.url === "/v2/rfq/rfq_1/submit") return send(200, { data: { status: "submitted" } });
    if (req.url === "/v2/ramp/providers") return send(200, { providers: [{ id: "busha", chainIds: [56, 8453] }, { id: "other", chainIds: [42220] }] });
    send(404, { error: { message: "nope" } });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/v2`;
});
after(() => server?.close());

test("preview asks for cNGN -> USDT on Celo and gives a naira rate", async () => {
  const t = textileClient({ base, apiKey: "" });
  const p = await t.preview({ buyAmount: 1_000_000n });
  const sent = seen.at(-1).body;
  assert.deepEqual(sent, { chainId: 42220, sellToken: CNGN, buyToken: USDT, buyAmount: "1000000" });
  assert.equal(ngnPerUsd(p.data), 1600);
  assert.equal(seen.at(-1).headers.authorization, undefined, "keyless by default");
});

test("firm quote: 401 first, then a signed TakerControl proof the server can verify", async () => {
  const t = textileClient({ base, apiKey: "" });
  await assert.rejects(() => t.request({ buyAmount: 1_000_000n, taker: account.address }), (e) => e instanceof TextileError && e.status === 401 && e.code === "proof_of_control_required");
  const takerProof = await signTakerProof(account, account.address);
  assert.match(takerProof.nonce, /^0x[0-9a-f]{64}$/);
  assert.ok(Math.abs(takerProof.issuedAt - Date.now()) < 5000);
  const r = await t.request({ buyAmount: 1_000_000n, taker: account.address, takerProof });
  assert.equal(r.data.status, "quoted");
  assert.deepEqual(seen.at(-1).body.builderCodes, BUILDER_CODES);
  for (const c of BUILDER_CODES) assert.match(c, /^[a-z0-9_]{1,32}$/, "builder code format");
});

test("submit sends the claim token header; API key goes as a bearer token", async () => {
  const t = textileClient({ base, apiKey: "tx_test_abc.secret" });
  await t.submit("rfq_1", "rfqc_secret", "0xabc");
  const last = seen.at(-1);
  assert.equal(last.headers["x-rfq-claim"], "rfqc_secret");
  assert.equal(last.headers.authorization, "Bearer tx_test_abc.secret");
  assert.deepEqual(last.body, { txHash: "0xabc" });
});

test("ramp: finds providers that deliver on Celo", async () => {
  const t = textileClient({ base, apiKey: "" });
  const celo = rampSupportsCelo(await t.rampProviders());
  assert.deepEqual(celo.map((p) => p.id), ["other"]);
});
