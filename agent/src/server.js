// Arra's HTTP API plus the static app. No framework: node:http only, so it
// runs comfortably on a small VPS.
import { createServer as httpServer } from "node:http";
import { gzipSync } from "node:zlib";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { isAddress, keccak256, toBytes, parseEventLogs, verifyMessage } from "viem";
import { reviewSheet, sheetRef, sheetTotal, canonicalSheet } from "./orderSheet.js";
import { PayeeBook } from "./payeeBook.js";
import { checkContainerNumber } from "./container.js";
import { nextActions, explain, vaultAbi, abiFor } from "./vault.js";
import { assistant } from "./assistant.js";
import { textileClient, ngnPerUsd, rampSupportsCelo, TextileError } from "./textile.js";
import { LogIndex } from "./history.js";
import { VaultSet } from "./vaults.js";
import { OrderLinks, LINK_RE } from "./links.js";
import { Invites } from "./invites.js";
import { Notes } from "./notes.js";
import { orderPreviewPng } from "./ogImage.js";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const MAX_BODY = 64 * 1024;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req, limit = MAX_BODY) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Body must be JSON"), { status: 400 });
  }
}

export function createApp({ client, vault, dataDir, staticDir, now = () => Math.floor(Date.now() / 1000), textile = textileClient(), history = null, vaults = null, links = null, ai = assistant() }) {
  // One vault (tests, simple setups) or several versions shown as one Arra.
  vaults ??= new VaultSet({ client, vaults: [{ address: vault, firstId: 1, history: history ?? new LogIndex({ client, vault }) }] });
  let statsCache = null;
  // The vault's per-order cap (owner can change it), re-read at most once a minute.
  let capCache = null;
  const maxOrder = async () => {
    if (!capCache || Date.now() - capCache.at > 60_000) {
      const v = await client.readContract({ address: vaults.current, abi: vaultAbi, functionName: "maxOrder" }).catch(() => null);
      capCache = { at: Date.now(), v: /^\d+$/.test(String(v ?? "")) ? String(v) : capCache?.v ?? "50000000" };
    }
    return capCache.v;
  };
  // Claim tokens for firm quotes stay on the server; the browser only gets the rfqId.
  const claims = new Map();
  const usdUnits = (v) => {
    if (!/^\d+(\.\d{1,6})?$/.test(String(v ?? ""))) throw Object.assign(new Error("usd must be an amount like 12.50"), { status: 400 });
    const [w, f = ""] = String(v).split(".");
    return BigInt(w) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  };
  const fx = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TextileError) return [e.status === 401 ? 401 : 502, { error: e.message, code: e.code ?? null }];
      // Textile unreachable (network): say so plainly instead of a generic error.
      if (!e.status && /fetch failed|ENOTFOUND|ECONN|ETIMEDOUT|network/i.test(`${e.message} ${e.cause?.code ?? ""}`)) {
        return [502, { error: "Naira rates are unavailable right now. Try again in a minute, or pay with USDT." }];
      }
      throw e;
    }
  };
  const sheetsDir = join(dataDir, "sheets");
  mkdirSync(sheetsDir, { recursive: true });
  const payees = new PayeeBook(join(dataDir, "payees.json"));
  links ??= new OrderLinks(join(dataDir, "link-secret"));
  // An order can be addressed by its private link code or (old links) its number.
  // Orders open by their private code. Plain numbers still work only for the first
  // orders, whose links were shared before codes existed.
  const LEGACY_NUMBERS = Number(process.env.ARRA_NUMERIC_LINKS_MAX ?? 5);
  const toId = async (x) => (/^\d{1,9}$/.test(x) ? (Number(x) <= LEGACY_NUMBERS ? Number(x) : null) : links.resolve(x, await vaults.count()));
  // "Your orders" and History list everything a wallet did, so they need proof the
  // visitor owns that wallet: one free signature, remembered for 30 days.
  const signInText = (address, at) => `Sign in to Arra to see your orders.\n\nWallet: ${address.toLowerCase()}\nTime: ${at}\n\nThis is free and moves no money.`;
  const signedIn = (req, who) => {
    const w = links.sessionWallet(req?.headers?.["x-arra-session"]);
    return !!w && w === String(who).toLowerCase();
  };
  // Container numbers: the vault stores only their fingerprint. Anyone may tell the
  // server the number, and it's kept only if it matches that fingerprint, so the
  // buyer can see and track it.
  const invites = new Invites(join(dataDir, "invites"));
  const notes = new Notes(join(dataDir, "notes"));
  const trackingDir = join(dataDir, "tracking");
  mkdirSync(trackingDir, { recursive: true });
  const trackingPath = (id) => join(trackingDir, `${Number(id)}.json`);
  const loadTracking = (id) => (existsSync(trackingPath(id)) ? JSON.parse(readFileSync(trackingPath(id), "utf8")) : null);
  const sheetPath = (ref) => join(sheetsDir, `${ref.toLowerCase()}.json`);
  const loadSheet = (ref) => (existsSync(sheetPath(ref)) ? JSON.parse(readFileSync(sheetPath(ref), "utf8")) : null);

  async function orderView(id, viewer) {
    const o = await vaults.read(id);
    if (!o) return null;
    const sheet = loadSheet(o.ref);
    const t = now();
    // Compare lower-case: wallets report addresses with or without checksum casing.
    const v = viewer && isAddress(viewer, { strict: false }) ? viewer.toLowerCase() : null;
    const role = v === o.buyer.toLowerCase() ? "buyer" : v === o.supplier.toLowerCase() ? "supplier" : "anyone";
    // F9: once the supplier has accepted from this address, remember it.
    const name = sheet?.sheet?.supplier;
    if (name && o.status !== "Pending" && o.status !== "Refunded" && payees.check(o.buyer, name, o.supplier).status !== "known") {
      payees.remember(o.buyer, name, o.supplier, `accepted order ${id}`);
    }
    return { order: o, link: links.code(id), tracking: loadTracking(id), sheet, role, actions: nextActions(o, t, role), explanation: explain(o, t), now: t };
  }

  const routes = {
    "GET /api/health": async () => {
      // keeperFee: what the agent takes if it has to trigger a refund or payout (v3 vaults; 0 before).
      keeperFee ??= await client.readContract({ address: vaults.current, abi: vaultAbi, functionName: "keeperFee" }).then((v) => (/^\d+$/.test(String(v)) ? String(v) : "0")).catch(() => "0");
      const v4 = (await abiFor(client, vaults.current).catch(() => null)) === vaultAbi;
      return [200, { ok: true, vault: vaults.current, vaults: vaults.addresses, keeperFee, v4, assistant: ai.enabled, maxOrder: await maxOrder() }];
    },

    // Live totals for the homepage (cached for a minute).
    "GET /api/stats": async () => {
      if (!statsCache || Date.now() - statsCache.at > 60_000) statsCache = { at: Date.now(), data: await vaults.stats() };
      return [200, statsCache.data];
    },

    // Order assistant: describe the deal in your own words; Claude fills the form.
    "POST /api/assistant": async (body) => {
      const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today ?? "") ? body.today : undefined;
      return [200, await ai.chat(body.messages, today, Math.floor(Number(await maxOrder()) / 1e6))];
    },

    // F7: check an order sheet and get its fingerprint before funding.
    "POST /api/sheet/review": async (body) => {
      const issues = reviewSheet(body.sheet);
      const ready = issues.length === 0;
      return [200, { issues, ready, ref: ready ? sheetRef(body.sheet) : null, totalUsdt: ready ? sheetTotal(body.sheet).toString() : null }];
    },

    // Save the sheet so the supplier's page can show it. Only clean sheets are stored.
    "POST /api/sheets": async (body) => {
      const issues = reviewSheet(body.sheet);
      if (issues.length) return [400, { error: "Sheet has issues", issues }];
      const ref = sheetRef(body.sheet);
      writeFileSync(sheetPath(ref), JSON.stringify({ sheet: body.sheet, canonical: canonicalSheet(body.sheet) }, null, 2));
      return [200, { ref, owner: links.owner(ref) }];
    },

    // Sign in with a wallet signature (free). Returns a token the app keeps for 30 days.
    "POST /api/session": async (body) => {
      const address = String(body.address ?? "");
      const at = Number(body.at);
      if (!isAddress(address, { strict: false }) || !Number.isFinite(at) || Math.abs(Date.now() - at) > 10 * 60 * 1000) return [400, { error: "Please try signing in again" }];
      const message = signInText(address, at);
      let ok = await verifyMessage({ address, message, signature: body.signature }).catch(() => false);
      // Smart-contract wallets sign differently; let the network check those.
      if (!ok && client.verifyMessage) ok = await client.verifyMessage({ address, message, signature: body.signature }).catch(() => false);
      if (!ok) return [401, { error: "That signature doesn't match this wallet" }];
      return [200, { token: links.session(address) }];
    },
    "GET /api/session/text": async (_b, url) => {
      const a = url.searchParams.get("address") ?? "";
      const at = Number(url.searchParams.get("at"));
      if (!isAddress(a, { strict: false }) || !Number.isFinite(at)) return [400, { error: "address and at required" }];
      return [200, { text: signInText(a, at) }];
    },

    // Supplier invites (no copied addresses).
    "POST /api/invites": async (body) => [200, { code: invites.create(body.buyer, body.name) }],

    // F9
    "POST /api/payee/check": async (body) => {
      if (!isAddress(body.buyer ?? "")) return [400, { error: "buyer must be an address" }];
      return [200, payees.check(body.buyer, body.supplierName ?? "", body.address ?? "")];
    },
    // The buyer ticks "I confirmed by phone" for this order only. Nothing is stored: anyone
    // could call this endpoint with someone else's wallet, so an address only becomes
    // "known" once the supplier has accepted an order from it onchain (see orderView).
    "POST /api/payee/confirm": async (body) => {
      if (!isAddress(body.buyer ?? "") || !isAddress(body.address ?? "")) return [400, { error: "addresses required" }];
      return [200, { ok: true }];
    },

    // F8
    "POST /api/container/check": async (body) => [200, checkContainerNumber(body.number)],

    // F11: cNGN -> USDT on Textile FX. Exact output: the buyer gets exactly the USDT the order needs.
    "POST /api/fx/preview": async (body) =>
      fx(async () => {
        const buyAmount = usdUnits(body.usd);
        const { data } = await textile.preview({ buyAmount });
        return [200, { cngn: data.sellAmount, usdt: data.buyAmount ?? buyAmount.toString(), ngnPerUsd: ngnPerUsd({ sellAmount: data.sellAmount, buyAmount: data.buyAmount ?? buyAmount }) }];
      }),
    "POST /api/fx/quote": async (body) =>
      fx(async () => {
        if (!isAddress(body.taker ?? "", { strict: false })) return [400, { error: "taker must be an address" }];
        const { data } = await textile.request({ buyAmount: usdUnits(body.usd), taker: body.taker, takerProof: body.takerProof });
        if (data.status !== "quoted") return [200, { status: data.status, reason: data.reason ?? null }];
        claims.set(data.rfqId, data.claimToken);
        setTimeout(() => claims.delete(data.rfqId), 15 * 60 * 1000).unref?.();
        const q = data.quote;
        return [200, { status: "quoted", rfqId: data.rfqId, takerPays: q.takerPays, buyAmount: q.buyAmount, feeAmount: q.feeAmount, reactor: q.reactor, expiresAt: q.expiresAt, ngnPerUsd: ngnPerUsd({ sellAmount: q.takerPays, buyAmount: q.buyAmount }), transactions: data.transactions }];
      }),
    "GET /api/ramp/providers": async () =>
      fx(async () => {
        const all = await textile.rampProviders();
        return [200, { celo: rampSupportsCelo(all) }];
      }),

    // Transaction history: every payment in or out of one wallet, newest first.
    "GET /api/activity": async (_b, url, req) => {
      const who = url.searchParams.get("address");
      if (!who || !isAddress(who, { strict: false })) return [400, { error: "address required" }];
      if (!signedIn(req, who)) return [401, { error: "Sign in with your wallet to see your history", signIn: true }];
      let raw;
      try {
        raw = await vaults.activity(who);
      } catch (e) {
        console.error("activity:", e.shortMessage ?? e.message);
        return [503, { error: "Your history couldn't be loaded from the Celo network just now. Please try again in a moment." }];
      }
      const rows = raw.map(({ ref, ...r }) => ({ ...r, link: links.code(r.orderId), product: loadSheet(ref)?.sheet?.product ?? null, counterpartyName: r.role === "buyer" ? loadSheet(ref)?.sheet?.supplier ?? null : null }));
      const sum = (flow) => rows.filter((r) => r.flow === flow).reduce((s, r) => s + BigInt(r.amount), 0n).toString();
      return [200, { rows, totals: { in: sum("in"), out: sum("out") } }];
    },

    "GET /api/orders": async (_b, url, req) => {
      const who = url.searchParams.get("address");
      if (!who || !isAddress(who, { strict: false })) return [400, { error: "address required" }];
      if (!signedIn(req, who)) return [401, { error: "Sign in with your wallet to see your orders", signIn: true }];
      const n = await vaults.count();
      const mine = [];
      for (let id = n; id >= 1 && mine.length < 50; id--) {
        const view = await orderView(id, who);
        if (view && view.role !== "anyone") mine.push(view);
      }
      return [200, { orders: mine }];
    },
  };

  // What a shared link shows in WhatsApp and other apps. For an order link:
  // the amount, what it's for and what happens next.
  async function previewFor(pathname, req) {
    const proto = req.headers["x-forwarded-proto"] ?? (req.headers.host?.startsWith("127.") ? "http" : "https");
    const origin = `${proto}://${req.headers.host ?? "localhost"}`;
    const meta = { image: `${origin}/og.png`, url: origin + pathname };
    const m = pathname.match(/^\/o\/([A-Za-z0-9]{1,10})(\/receipt)?$/);
    if (!m) return meta;
    try {
      const id = await toId(m[1]);
      const v = id && (await orderView(id, null));
      if (!v) return meta;
      const { order: o, sheet } = v;
      // A picture of this order; the version changes with its state so chat apps refresh it.
      meta.image = `${origin}/og/${v.link}.png?v=${o.status}-${o.held}`;
      const s = sheet?.sheet;
      const money = (x) => `$${(Number(x) / 1e6).toFixed(2)}`;
      const what = s ? `${s.product}${s.quantity ? `, ${s.quantity} ${s.unit}` : ""}` : `Order #${o.id}`;
      if (m[2]) {
        meta.title = `Receipt for order #${o.id} · Arra`;
        meta.description = `${what}. Total ${money(o.total)} USDT on Celo.`;
      } else if (o.status === "Pending") {
        meta.title = `${money(o.total)} locked for ${s?.supplier ?? "you"} · Arra`;
        meta.description = `${what}. ${BigInt(o.deposit) > 0n ? `${money(o.deposit)} deposit paid the moment you accept; the` : "The"} balance is released when it ${s && (s.kind ?? "goods") !== "goods" ? "is delivered" : "ships"}. Money held in an open contract on Celo.`;
      } else {
        meta.title = `Order #${o.id}: ${what} · Arra`;
        meta.description = `${money(o.total)} USDT order. ${explain(o, now())}`;
      }
    } catch {
      /* fall back to the general preview */
    }
    return meta;
  }

  const pngCache = new Map();
  let keeperFee = null;

  // Per-visitor limits so nobody can flood the server with uploads or writes.
  // (Caddy passes the visitor's address in x-forwarded-for.)
  const hits = new Map();
  const tooMany = (req, bucket, max, windowMs) => {
    const ip = String(req.headers["x-forwarded-for"] ?? req.socket?.remoteAddress ?? "?").split(",")[0].trim();
    const k = `${bucket}:${ip}`;
    const t = Date.now();
    let h = hits.get(k);
    if (!h || t - h.start > windowMs) {
      if (hits.size > 20_000) hits.clear();
      h = { start: t, n: 0 };
      hits.set(k, h);
    }
    return ++h.n > max;
  };

  return async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    try {
      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const photo = /\/photos$/.test(url.pathname);
        if (photo ? tooMany(req, "photo", 40, 3600_000) : tooMany(req, "post", 300, 600_000)) {
          return send(res, 429, { error: "Too many requests from your connection. Please wait a few minutes and try again." });
        }
      }
      // Preview image for one order, drawn on request and kept in memory.
      const og = url.pathname.match(/^\/og\/([A-Za-z0-9]{10})\.png$/);
      if (og && req.method === "GET") {
        const id = LINK_RE.test(og[1]) ? await toId(og[1]) : null;
        const v = id && (await orderView(id, null));
        if (!v) return send(res, 404, { error: "No such order" });
        const key = `${id}:${v.order.status}:${v.order.held}`;
        if (!pngCache.has(key)) {
          if (pngCache.size > 500) pngCache.clear();
          pngCache.set(key, orderPreviewPng(v.order, v.sheet?.sheet));
        }
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=300" });
        return res.end(pngCache.get(key));
      }
      if (url.pathname.startsWith("/api/")) {
        const m = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9]{1,10})$/);
        if (m && req.method === "GET") {
          const id = await toId(m[1]);
          const view = id ? await orderView(id, url.searchParams.get("as")) : null;
          return view ? send(res, 200, view) : send(res, 404, { error: "No such order" });
        }
        const inv = url.pathname.match(/^\/api\/invites\/([A-Za-z0-9]{12})(\/claim)?$/);
        if (inv) {
          if (req.method === "GET" && !inv[2]) {
            const v = invites.get(inv[1]);
            return v ? send(res, 200, v) : send(res, 404, { error: "This invite doesn't exist" });
          }
          if (req.method === "POST" && inv[2]) {
            const body = await readJson(req);
            return send(res, 200, invites.claim(inv[1], body.address));
          }
        }
        const invAct = url.pathname.match(/^\/api\/invites\/([A-Za-z0-9]{12})\/(draft|agree|suggest)$/);
        if (invAct && req.method === "POST") {
          const body = await readJson(req);
          if (invAct[2] === "draft") return send(res, 200, invites.setDraft(invAct[1], body.sheet));
          if (invAct[2] === "agree") return send(res, 200, invites.agree(invAct[1], body.address, body.ref));
          return send(res, 200, invites.suggest(invAct[1], body.address, body.text));
        }
        // Notes and evidence: list, upload a photo, add a signed note.
        const nt = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9]{1,10})\/(notes|photos)$/);
        if (nt) {
          const id = await toId(nt[1]);
          const o = id && (await vaults.read(id));
          if (!o) return send(res, 404, { error: "No such order" });
          if (nt[2] === "notes" && req.method === "GET") return send(res, 200, { notes: notes.list(id) });
          if (nt[2] === "photos" && req.method === "POST") {
            const body = await readJson(req, 2_200_000);
            return send(res, 200, { photo: notes.savePhoto(body.jpegBase64) });
          }
          if (nt[2] === "notes" && req.method === "POST") {
            const body = await readJson(req);
            return send(res, 200, { note: await notes.add(o, body, now()) });
          }
        }
        const ph = url.pathname.match(/^\/api\/photos\/(0x[0-9a-f]{64})\.jpg$/);
        if (ph && req.method === "GET") {
          if (!notes.hasPhoto(ph[1])) return send(res, 404, { error: "No such photo" });
          res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" });
          return res.end(readFileSync(notes.photoPath(ph[1])));
        }
        const rec = url.pathname.match(/^\/api\/record\/(0x[0-9a-fA-F]{40})$/);
        if (rec && req.method === "GET") {
          try {
            return send(res, 200, await vaults.record(rec[1]));
          } catch (e) {
            console.error("record:", e.shortMessage ?? e.message);
            return send(res, 503, { error: "Track record unavailable right now" });
          }
        }
        const tr = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9]{1,10})\/tracking$/);
        if (tr && req.method === "POST") {
          const id = await toId(tr[1]);
          if (!id) return send(res, 404, { error: "No such order" });
          const body = await readJson(req);
          const check = checkContainerNumber(body.number);
          if (!check.ok) return send(res, 400, { error: check.reason });
          let shipped = (await vaults.timeline(id).catch(() => [])).find((st) => st.event === "OrderShipped");
          // Just shipped: the history index reads a couple of blocks behind, so check the
          // shipping transaction's own receipt (only an OrderShipped log from this order's vault counts).
          if (!shipped && /^0x[0-9a-fA-F]{64}$/.test(body.tx ?? "")) {
            const vault = vaults.vaultFor(id);
            const receipt = await client.getTransactionReceipt({ hash: body.tx }).catch(() => null);
            const log = receipt?.status === "success" && vault
              ? parseEventLogs({ abi: vaultAbi, eventName: "OrderShipped", logs: receipt.logs }).find((l) => l.address.toLowerCase() === vault.toLowerCase() && l.args.id === BigInt(id))
              : null;
            if (log) shipped = { trackingHash: log.args.trackingHash, at: Number(log.args.shippedAt), tx: body.tx };
          }
          if (!shipped) return send(res, 409, { error: "The order isn't marked shipped yet" });
          if (keccak256(toBytes(check.number)).toLowerCase() !== String(shipped.trackingHash).toLowerCase()) {
            return send(res, 400, { error: "That number doesn't match the one the supplier recorded" });
          }
          writeFileSync(trackingPath(id), JSON.stringify({ number: check.number, at: shipped.at, tx: shipped.tx }));
          return send(res, 200, { ok: true, number: check.number });
        }
        // Right after locking: the buyer proves they wrote the order's sheet and gets its private link.
        const ol = url.pathname.match(/^\/api\/orders\/(\d{1,9})\/link$/);
        if (ol && req.method === "POST") {
          const body = await readJson(req);
          const o = await vaults.read(Number(ol[1])).catch(() => null);
          if (!o) return send(res, 404, { error: "No such order yet" });
          if (String(body.owner ?? "") !== links.owner(o.ref)) return send(res, 403, { error: "Not your order" });
          return send(res, 200, { link: links.code(Number(ol[1])) });
        }
        const tl = url.pathname.match(/^\/api\/orders\/([A-Za-z0-9]{1,10})\/timeline$/);
        if (tl && req.method === "GET") {
          const id = await toId(tl[1]);
          if (!id) return send(res, 404, { error: "No such order" });
          try {
            return send(res, 200, { steps: await vaults.timeline(id) });
          } catch (e) {
            console.error("timeline:", e.shortMessage ?? e.message);
            return send(res, 200, { steps: null, error: "History is temporarily unavailable" });
          }
        }
        const sub = url.pathname.match(/^\/api\/fx\/([A-Za-z0-9_-]+)\/submit$/);
        if (sub && req.method === "POST") {
          const claim = claims.get(sub[1]);
          if (!claim) return send(res, 404, { error: "Unknown or expired quote" });
          const body = await readJson(req);
          if (!/^0x[0-9a-fA-F]{64}$/.test(body.txHash ?? "")) return send(res, 400, { error: "txHash required" });
          const [st, payload] = await fx(async () => [200, (await textile.submit(sub[1], claim, body.txHash)).data ?? { ok: true }]);
          return send(res, st, payload);
        }
        const s = url.pathname.match(/^\/api\/sheets\/(0x[0-9a-fA-F]{64})$/);
        if (s && req.method === "GET") {
          const sheet = loadSheet(s[1]);
          return sheet ? send(res, 200, sheet) : send(res, 404, { error: "Unknown sheet" });
        }
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) return send(res, 404, { error: "Not found" });
        const body = req.method === "POST" ? await readJson(req) : {};
        const [status, payload] = await route(body, url, req);
        return send(res, status, payload);
      }
      // App pages: give link previews the right title, text and an absolute image URL.
      if (req.method === "GET" && !extname(url.pathname) && staticDir && existsSync(join(staticDir, "index.html"))) {
        return sendPage(res, req, await previewFor(url.pathname, req), staticDir);
      }
      return serveStatic(staticDir, url.pathname, res, req);
    } catch (e) {
      send(res, e.status ?? 500, { error: e.status ? e.message : "Something went wrong" });
      if (!e.status) console.error(e);
    }
  };
}

// Compressed copies of the app's files, made once. The main script shrinks
// from ~590 KB to ~180 KB, which matters a lot on mobile data.
const gzCache = new Map();
const COMPRESS = new Set([".html", ".js", ".css", ".svg", ".json", ".webmanifest"]);

const escapeHtml = (v) => String(v).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function sendPage(res, req, meta, dir) {
  let html = readFileSync(join(dir, "index.html"), "utf8");
  const set = (prop, value) => {
    if (value == null) return;
    const re = new RegExp(`(<meta (?:property|name)="${prop}" content=")[^"]*(")`);
    // Function replacers, so "$20" in the text isn't read as a regex group.
    html = re.test(html) ? html.replace(re, (_, a, b) => a + escapeHtml(value) + b) : html.replace("</head>", () => `<meta property="${prop}" content="${escapeHtml(value)}" />\n</head>`);
  };
  set("og:image", meta.image);
  set("og:url", meta.url);
  set("og:title", meta.title);
  set("og:description", meta.description);
  if (meta.description) set("description", meta.description);
  if (meta.title) html = html.replace(/<title>[^<]*<\/title>/, () => `<title>${escapeHtml(meta.title)}</title>`);
  const headers = { "content-type": MIME[".html"], "cache-control": "no-cache", vary: "accept-encoding" };
  let body = Buffer.from(html);
  if (/\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
    body = gzipSync(body);
    headers["content-encoding"] = "gzip";
  }
  res.writeHead(200, headers);
  res.end(body);
}

function serveStatic(dir, pathname, res, req) {
  if (!dir || !existsSync(dir)) return send(res, 404, { error: "App not built" });
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(dir, safe);
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html"); // SPA routes
  const ext = extname(file);
  const headers = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    vary: "accept-encoding",
  };
  let body = readFileSync(file);
  if (COMPRESS.has(ext) && /\bgzip\b/.test(req?.headers["accept-encoding"] ?? "")) {
    const key = `${file}:${statSync(file).mtimeMs}`;
    if (!gzCache.has(key)) gzCache.set(key, gzipSync(body, { level: 9 }));
    body = gzCache.get(key);
    headers["content-encoding"] = "gzip";
  }
  res.writeHead(200, headers);
  res.end(body);
}

export function listen(handler, port) {
  return new Promise((resolve) => {
    const server = httpServer(handler);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
