async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

export const api = {
  reviewSheet: (sheet) => call("POST", "/api/sheet/review", { sheet }),
  saveSheet: (sheet) => call("POST", "/api/sheets", { sheet }),
  checkPayee: (buyer, supplierName, address) => call("POST", "/api/payee/check", { buyer, supplierName, address }),
  confirmPayee: (buyer, supplierName, address) => call("POST", "/api/payee/confirm", { buyer, supplierName, address }),
  checkContainer: (number) => call("POST", "/api/container/check", { number }),
  order: (id, as) => call("GET", `/api/orders/${id}${as ? `?as=${as}` : ""}`),
  myOrders: (address) => call("GET", `/api/orders?address=${address}`),
};

api.fxPreview = (usd) => call("POST", "/api/fx/preview", { usd });
api.fxQuote = (taker, usd, takerProof) => call("POST", "/api/fx/quote", { taker, usd, takerProof });
api.fxSubmit = (rfqId, txHash) => call("POST", `/api/fx/${rfqId}/submit`, { txHash });
api.stats = () => call("GET", "/api/stats");
api.tracking = (id, number) => call("POST", `/api/orders/${id}/tracking`, { number });
api.createInvite = (buyer, name) => call("POST", "/api/invites", { buyer, name });
api.invite = (code) => call("GET", `/api/invites/${code}`);
api.inviteDraft = (code, sheet) => call("POST", `/api/invites/${code}/draft`, { sheet });
api.agreeInvite = (code, address, ref) => call("POST", `/api/invites/${code}/agree`, { address, ref });
api.suggestInvite = (code, address, text) => call("POST", `/api/invites/${code}/suggest`, { address, text });
api.claimInvite = (code, address) => call("POST", `/api/invites/${code}/claim`, { address });
api.record = (address) => call("GET", `/api/record/${address}`);
api.notes = (id) => call("GET", `/api/orders/${id}/notes`);
api.addNote = (id, body) => call("POST", `/api/orders/${id}/notes`, body);
api.uploadPhoto = (id, jpegBase64) => call("POST", `/api/orders/${id}/photos`, { jpegBase64 });
api.activity = (address) => call("GET", `/api/activity?address=${address}`);
api.timeline = (id) => call("GET", `/api/orders/${id}/timeline`);
api.assistant = (messages, today) => call("POST", "/api/assistant", { messages, today });
