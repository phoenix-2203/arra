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

export function createApp({ client, vault, dataDir, staticDir, now = () => Math.floor(Date.now() / 1000) }) {
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
