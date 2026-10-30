// "Add deadlines to my calendar": a small .ics file with the order's deadlines, each
// with a reminder the day before, so nobody misses an accept, ship or check date.
const stamp = (ts) => new Date(ts * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
const esc = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, "\\n");

/** Deadlines that still matter for this order and this person. */
export function deadlines(o, role, goods = true) {
  const out = [];
  if (o.status === "Pending") out.push({ at: o.acceptBy, what: role === "supplier" ? "Accept the Arra order (deposit paid on accept)" : "Supplier must accept the Arra order, or you're refunded" });
  if (o.status === "Pending" || o.status === "Active") out.push({ at: o.shipBy, what: role === "supplier" ? `${goods ? "Ship" : "Deliver"} and mark it in Arra` : `Arra order must be ${goods ? "shipped" : "delivered"}, or the balance comes back` });
  if (o.status === "Shipped") out.push({ at: o.shippedAt + o.disputeWindow, what: role === "buyer" ? "Last day to check the goods (raise a problem in Arra or the balance pays out)" : "Buyer's check period ends; balance pays out" });
  return out.filter((d) => d.at > Date.now() / 1000);
}

export function icsFor(o, role, url, goods = true) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Arra//Order deadlines//EN"];
  for (const d of deadlines(o, role, goods)) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:arra-${o.id}-${d.at}@usearra`,
      `DTSTAMP:${stamp(Math.floor(Date.now() / 1000))}`,
      `DTSTART:${stamp(d.at - 3600)}`,
      `DTEND:${stamp(d.at)}`,
      `SUMMARY:${esc(`Arra #${o.id}: ${d.what}`)}`,
      `DESCRIPTION:${esc(url)}`,
      `URL:${url}`,
      "BEGIN:VALARM",
      "TRIGGER:-P1D",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(d.what)}`,
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.join("\r\n");
}

export function downloadIcs(o, role, url, goods) {
  const blob = new Blob([icsFor(o, role, url, goods)], { type: "text/calendar" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `arra-order-${o.id}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/** "3 days left" style countdown to the next deadline, or null. */
export function nextDeadline(o) {
  const now = Date.now() / 1000;
  const at = o.status === "Pending" ? o.acceptBy : o.status === "Active" ? o.shipBy : o.status === "Shipped" ? o.shippedAt + o.disputeWindow : null;
  if (!at || at < now) return null;
  const days = Math.ceil((at - now) / 86400);
  return days <= 1 ? (at - now < 3600 * 6 ? "due in hours" : "due tomorrow") : `${days} days left`;
}
