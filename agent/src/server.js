// Arra's HTTP API plus the static app. No framework: node:http only, so it
// runs comfortably on a small VPS.
import { createServer as httpServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { isAddress } from "viem";
import { reviewSheet, sheetRef, sheetTotal, canonicalSheet } from "./orderSheet.js";
import { PayeeBook } from "./payeeBook.js";
import { checkContainerNumber } from "./container.js";
import { readOrder, orderCount, nextActions, explain } from "./vault.js";
import { textileClient, ngnPerUsd, rampSupportsCelo, TextileError } from "./textile.js";
import { LogIndex, vaultStats } from "./history.js";

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };
const MAX_BODY = 64 * 1024;

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw Object.assign(new Error("Body must be JSON"), { status: 400 });
  }
}

export function createApp({ client, vault, dataDir, staticDir, now = () => Math.floor(Date.now() / 1000), textile = textileClient(), history = new LogIndex({ client, vault }) }) {
  let statsCache = null;
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
      throw e;
    }
  };
  const sheetsDir = join(dataDir, "sheets");
  mkdirSync(sheetsDir, { recursive: true });
  const payees = new PayeeBook(join(dataDir, "payees.json"));
  const sheetPath = (ref) => join(sheetsDir, `${ref.toLowerCase()}.json`);
  const loadSheet = (ref) => (existsSync(sheetPath(ref)) ? JSON.parse(readFileSync(sheetPath(ref), "utf8")) : null);

  async function orderView(id, viewer) {
    const o = await readOrder(client, vault, id);
    if (!o) return null;
    const sheet = loadSheet(o.ref);
    const t = now();
    // Compare lower-case: wallets report addresses with or without checksum casing.
    const v = viewer && isAddress(viewer, { strict: false }) ? viewer.toLowerCase() : null;
    const role = v === o.buyer.toLowerCase() ? "buyer" : v === o.supplier.toLowerCase() ? "supplier" : "anyone";
    // F9: once the supplier has accepted from this address, remember it.
    const name = sheet?.sheet?.supplier;
    if (name && o.status !== "Pending" && payees.check(o.buyer, name, o.supplier).status === "new") {
      payees.remember(o.buyer, name, o.supplier, `accepted order ${id}`);
    }
    return { order: o, sheet, role, actions: nextActions(o, t, role), explanation: explain(o, t), now: t };
  }

  const routes = {
    "GET /api/health": async () => [200, { ok: true, vault }],

    // Live totals for the homepage (cached for a minute).
    "GET /api/stats": async () => {
      if (!statsCache || Date.now() - statsCache.at > 60_000) statsCache = { at: Date.now(), data: await vaultStats(client, vault) };
      return [200, statsCache.data];
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
      return [200, { ref }];
    },

    // F9
    "POST /api/payee/check": async (body) => {
      if (!isAddress(body.buyer ?? "")) return [400, { error: "buyer must be an address" }];
      return [200, payees.check(body.buyer, body.supplierName ?? "", body.address ?? "")];
    },
    "POST /api/payee/confirm": async (body) => {
      if (!isAddress(body.buyer ?? "") || !isAddress(body.address ?? "")) return [400, { error: "addresses required" }];
      payees.remember(body.buyer, body.supplierName, body.address, "confirmed-by-phone");
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
    "GET /api/activity": async (_b, url) => {
      const who = url.searchParams.get("address");
      if (!who || !isAddress(who, { strict: false })) return [400, { error: "address required" }];
      const rows = (await history.activity(who)).map(({ ref, ...r }) => ({ ...r, product: loadSheet(ref)?.sheet?.product ?? null, counterpartyName: r.role === "buyer" ? loadSheet(ref)?.sheet?.supplier ?? null : null }));
      const sum = (flow) => rows.filter((r) => r.flow === flow).reduce((s, r) => s + BigInt(r.amount), 0n).toString();
      return [200, { rows, totals: { in: sum("in"), out: sum("out") } }];
    },

    "GET /api/orders": async (_b, url) => {
      const who = url.searchParams.get("address");
      if (!who || !isAddress(who, { strict: false })) return [400, { error: "address required" }];
      const n = await orderCount(client, vault);
      const mine = [];
      for (let id = n; id >= 1 && mine.length < 50; id--) {
        const view = await orderView(id, who);
        if (view && view.role !== "anyone") mine.push(view);
      }
      return [200, { orders: mine }];
    },
  };

  return async function handle(req, res) {
    const url = new URL(req.url, "http://x");
    try {
      if (url.pathname.startsWith("/api/")) {
        const m = url.pathname.match(/^\/api\/orders\/(\d+)$/);
        if (m && req.method === "GET") {
          const view = await orderView(Number(m[1]), url.searchParams.get("as"));
          return view ? send(res, 200, view) : send(res, 404, { error: "No such order" });
        }
        const tl = url.pathname.match(/^\/api\/orders\/(\d+)\/timeline$/);
        if (tl && req.method === "GET") {
          try {
            return send(res, 200, { steps: await history.timeline(Number(tl[1])) });
          } catch (e) {
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
        const [status, payload] = await route(body, url);
        return send(res, status, payload);
      }
      return serveStatic(staticDir, url.pathname, res);
    } catch (e) {
      send(res, e.status ?? 500, { error: e.status ? e.message : "Something went wrong" });
      if (!e.status) console.error(e);
    }
  };
}

function serveStatic(dir, pathname, res) {
  if (!dir || !existsSync(dir)) return send(res, 404, { error: "App not built" });
  const safe = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  let file = join(dir, safe);
  if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, "index.html"); // SPA routes
  const ext = extname(file);
  res.writeHead(200, {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
  });
  res.end(readFileSync(file));
}

export function listen(handler, port) {
  return new Promise((resolve) => {
    const server = httpServer(handler);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
