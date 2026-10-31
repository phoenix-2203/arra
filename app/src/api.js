// A wallet's sign-in (one free signature, kept 30 days) for "Your orders" and History.
const SESSION_KEY = "arra.session";
export function sessionFor(address) {
  try {
    const t = localStorage.getItem(SESSION_KEY) ?? "";
    const [a, exp] = t.split(".");
    return address && a === address.toLowerCase() && Number(exp) > Date.now() / 1000 ? t : null;
  } catch {
    return null;
  }
}
export function saveSession(token) {
  try {
    localStorage.setItem(SESSION_KEY, token);
  } catch {
    /* storage can be unavailable; the user just signs again next time */
  }
}

async function call(method, path, body, session) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (session) headers["x-arra-session"] = session;
  const res = await fetch(path, {
    method,
    headers,
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
  myOrders: (address) => call("GET", `/api/orders?address=${address}`, null, sessionFor(address)),
};

api.fxPreview = (usd) => call("POST", "/api/fx/preview", { usd });
api.fxQuote = (taker, usd, takerProof) => call("POST", "/api/fx/quote", { taker, usd, takerProof });
api.fxSubmit = (rfqId, txHash) => call("POST", `/api/fx/${rfqId}/submit`, { txHash });
api.stats = () => call("GET", "/api/stats");
api.tracking = (id, number, tx) => call("POST", `/api/orders/${id}/tracking`, { number, tx });
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
api.activity = (address) => call("GET", `/api/activity?address=${address}`, null, sessionFor(address));
api.timeline = (id) => call("GET", `/api/orders/${id}/timeline`);
api.assistant = (messages, today) => call("POST", "/api/assistant", { messages, today });
api.sessionText = (address, at) => call("GET", `/api/session/text?address=${address}&at=${at}`);
api.signIn = (address, at, signature) => call("POST", "/api/session", { address, at, signature });
api.orderLink = (id, owner) => call("POST", `/api/orders/${id}/link`, { owner });
