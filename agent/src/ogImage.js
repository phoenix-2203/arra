// Draws the preview image for a shared order link (WhatsApp, X, Telegram):
// the amount, what it's for, the deposit and where the order stands. Built as
// SVG and turned into a PNG, because chat apps don't show SVG previews.
import { Resvg } from "@resvg/resvg-js";
import { fileURLToPath } from "node:url";

const font = (f) => fileURLToPath(new URL(`../assets/fonts/${f}`, import.meta.url));
const FONTS = [font("BricolageGrotesque_700Bold.ttf"), font("InstrumentSans_400Regular.ttf"), font("InstrumentSans_600SemiBold.ttf")];

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const money = (units) => `$${(Number(units) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (ts) => new Date(ts * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Splits text into at most `max` lines of about `width` characters, adding … if cut. */
function wrap(text, width, max) {
  const words = String(text).split(/\s+/);
  const lines = [""];
  for (const w of words) {
    const cur = lines.at(-1);
    if ((cur + " " + w).trim().length <= width) lines[lines.length - 1] = (cur + " " + w).trim();
    else if (lines.length < max) lines.push(w);
    else {
      lines[lines.length - 1] = cur.replace(/[ ,.;:]*$/, "") + "…";
      break;
    }
  }
  return lines.map((l) => (l.length > width + 2 ? l.slice(0, width) + "…" : l));
}

/** What the card says for each state of an order. */
export function cardFor(order, sheet) {
  const s = sheet ?? {};
  const goods = (s.kind ?? "goods") === "goods";
  const shipWord = goods ? "ships" : "is delivered";
  const who = s.supplier ?? "your supplier";
  const balance = BigInt(order.total) - BigInt(order.deposit);
  const base = {
    product: s.product ? `${s.product}${s.quantity ? ` · ${s.quantity} ${s.unit}` : ""}` : `Order #${order.id}`,
    orderNo: `Order #${order.id}`,
  };
  switch (order.status) {
    case "Pending":
      return { ...base, label: `Locked for ${who}`, amount: money(order.total), tone: "lime", status: "Waiting for the supplier to accept",
        rows: [["Deposit on accept", money(order.deposit)], [`Locked until it ${shipWord}`, money(balance)], ["Accept by", day(order.acceptBy)]], cta: "Open to accept" };
    case "Active":
      return { ...base, label: "Still locked in the vault", amount: money(order.held), tone: "lime", status: goods ? "Accepted · being made" : "Accepted · in progress",
        rows: [["Order total", money(order.total)], ["Deposit paid", money(order.deposit)], [goods ? "Ship by" : "Deliver by", day(order.shipBy)]], cta: "Open order" };
    case "Shipped": {
      // v4: the check period starts at arrival (or shipping + transit at the latest).
      const transit = !order.arrivedAt && order.transit > 0;
      const start = order.arrivedAt || order.shippedAt + (order.transit ?? 0);
      return { ...base, label: "Still locked in the vault", amount: money(order.held), tone: "lime", status: transit ? "Shipped · on its way" : goods ? "Arrived · buyer checking" : "Delivered · buyer checking",
        rows: [["Order total", money(order.total)], ["Deposit paid", money(order.deposit)], transit ? ["Check starts", "on arrival"] : ["Paid out on", day(start + order.disputeWindow)]], cta: "Open order" };
    }
    case "Disputed":
      return { ...base, label: "Held while it's sorted out", amount: money(order.held), tone: "alert", status: "Problem raised",
        rows: [["Order total", money(order.total)], ["Deposit paid", money(order.deposit)], ["Next", "Offer or accept a split"]], cta: "Open order" };
    case "Released":
      return { ...base, label: "Paid in full", amount: money(order.total), tone: "lime", status: "Complete",
        rows: [["Order total", money(order.total)], ["Deposit", money(order.deposit)], ["Balance", money(balance)]], cta: "See receipt" };
    case "Settled":
      return { ...base, label: "Settled by agreement", amount: money(order.total), tone: "lime", status: "Complete",
        rows: [["Order total", money(order.total)], ["Deposit", money(order.deposit)], ["Settled", "Agreed split"]], cta: "See receipt" };
    default:
      return { ...base, label: "Refunded to the buyer", amount: money(order.total), tone: "grey", status: "Closed",
        rows: [["Order total", money(order.total)], ["Deposit", money(order.deposit)], ["Result", "Money returned"]], cta: "See receipt" };
  }
}

export function cardSvg(c) {
  const LIME = "#ccff3d";
  const accent = c.tone === "alert" ? "#ff7a6b" : c.tone === "grey" ? "#8d9288" : LIME;
  const product = wrap(c.product, 30, 2);
  const label = wrap(c.label, 42, 1)[0];
  const amtSize = c.amount.length > 10 ? 92 : 112;
  const rows = c.rows
    .map(([k, v], i) => {
      const y = 232 + i * 64;
      return `<line x1="752" y1="${y - 40}" x2="1104" y2="${y - 40}" stroke="#23261f" stroke-width="2"/>
      <text x="752" y="${y}" font-family="Instrument Sans" font-size="23" fill="#8d9288">${esc(k)}</text>
      <text x="1104" y="${y}" text-anchor="end" font-family="Instrument Sans" font-weight="600" font-size="24" fill="#eef2ea">${esc(v)}</text>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <radialGradient id="g" cx="0.85" cy="0.1" r="0.6"><stop offset="0" stop-color="${accent}" stop-opacity="0.22"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient>
    <linearGradient id="chrome" x1="0" y1="0" x2="1" y2="0.2"><stop offset="0" stop-color="#a7aca2"/><stop offset="0.3" stop-color="#f4f7f0"/><stop offset="0.55" stop-color="#c6cbc1"/><stop offset="0.8" stop-color="#f7faf3"/><stop offset="1" stop-color="#a7aca2"/></linearGradient>
  </defs>
  <rect width="1200" height="630" fill="#090a07"/>
  <rect width="1200" height="630" fill="url(#g)"/>
  <text x="72" y="104" font-family="Bricolage Grotesque" font-weight="700" font-size="46" fill="#eef2ea">A<tspan fill="${LIME}">rr</tspan>a</text>
  <text x="1128" y="100" text-anchor="end" font-family="Instrument Sans" font-weight="600" font-size="24" fill="#8d9288">${esc(c.orderNo)}</text>
  <text x="72" y="200" font-family="Instrument Sans" font-weight="600" font-size="28" fill="#a4a99f">${esc(label)}</text>
  <text x="66" y="${200 + amtSize}" font-family="Bricolage Grotesque" font-weight="700" font-size="${amtSize}" letter-spacing="-3" fill="url(#chrome)">${esc(c.amount)}<tspan font-family="Instrument Sans" font-weight="400" font-size="30" fill="#8d9288" letter-spacing="0"> USDT</tspan></text>
  ${product.map((l, i) => `<text x="72" y="${384 + i * 46}" font-family="Instrument Sans" font-weight="600" font-size="38" fill="#eef2ea">${esc(l)}</text>`).join("")}
  <rect x="72" y="500" width="${Math.min(600, 76 + c.status.length * 13.2)}" height="58" rx="29" fill="${accent}" fill-opacity="0.14" stroke="${accent}" stroke-opacity="0.55" stroke-width="2"/>
  <circle cx="102" cy="529" r="8" fill="${accent}"/>
  <text x="122" y="537" font-family="Instrument Sans" font-weight="600" font-size="24" fill="${accent}">${esc(c.status)}</text>
  <rect x="720" y="150" width="416" height="360" rx="30" fill="#121410" stroke="#2f3329" stroke-width="2"/>
  ${rows}
  <rect x="752" y="${232 + c.rows.length * 64 - 26}" width="352" height="64" rx="16" fill="${LIME}"/>
  <text x="928" y="${232 + c.rows.length * 64 + 15}" text-anchor="middle" font-family="Instrument Sans" font-weight="600" font-size="25" fill="#0b0d05">${esc(c.cta)}</text>
  <text x="72" y="596" font-family="Instrument Sans" font-size="21" fill="#6b6f63">Held in an open contract on Celo, not by Arra</text>
</svg>`;
}

/** PNG bytes for one order's preview. */
export function orderPreviewPng(order, sheet) {
  const r = new Resvg(cardSvg(cardFor(order, sheet)), {
    fitTo: { mode: "original" },
    font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: "Instrument Sans" },
  });
  return r.render().asPng();
}
