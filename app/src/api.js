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
api.activity = (address) => call("GET", `/api/activity?address=${address}`);
api.timeline = (id) => call("GET", `/api/orders/${id}/timeline`);
