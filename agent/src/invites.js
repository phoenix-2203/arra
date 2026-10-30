// Supplier invites: instead of copying a wallet address from a chat (where look-alike
// "poisoned" addresses and fake suppliers live), the buyer sends an invite link. The
// supplier opens it and connects the wallet they want to be paid in; the address goes
// straight into the buyer's order form. The first wallet to claim an invite keeps it,
// so a link forwarded later can't swap the address. Real proof of ownership still
// comes when the supplier accepts the order from that wallet.
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAddress, isAddress } from "viem";

const ALPHABET = "23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export const INVITE_RE = /^[2-9a-km-zA-HJ-NP-Z]{12}$/;
const TTL = 7 * 86400 * 1000;

export class Invites {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }
  path(code) {
    return join(this.dir, `${code}.json`);
  }
  create(buyer, name, now = Date.now()) {
    if (!isAddress(buyer ?? "", { strict: false })) throw Object.assign(new Error("buyer must be an address"), { status: 400 });
    const clean = String(name ?? "").trim().slice(0, 80);
    if (!clean) throw Object.assign(new Error("Add the supplier's name first"), { status: 400 });
    const code = [...randomBytes(12)].map((b) => ALPHABET[b % ALPHABET.length]).join("");
    writeFileSync(this.path(code), JSON.stringify({ code, buyer: getAddress(buyer.toLowerCase()), name: clean, createdAt: now, address: null, claimedAt: null }));
    return code;
  }
  get(code, now = Date.now()) {
    if (!INVITE_RE.test(code) || !existsSync(this.path(code))) return null;
    const inv = JSON.parse(readFileSync(this.path(code), "utf8"));
    return { ...inv, expired: !inv.address && now - inv.createdAt > TTL };
  }
  claim(code, address, now = Date.now()) {
    const inv = this.get(code, now);
    if (!inv) throw Object.assign(new Error("This invite doesn't exist"), { status: 404 });
    if (inv.expired) throw Object.assign(new Error("This invite has expired. Ask the buyer for a new one."), { status: 410 });
    if (!isAddress(address ?? "", { strict: false })) throw Object.assign(new Error("That isn't a wallet address"), { status: 400 });
    const addr = getAddress(address.toLowerCase());
    if (addr === inv.buyer) throw Object.assign(new Error("That's the buyer's own wallet"), { status: 400 });
    if (inv.address) {
      if (inv.address === addr) return inv; // the same wallet again is fine
      throw Object.assign(new Error("This invite was already used by another wallet. Ask the buyer for a new one."), { status: 409 });
    }
    const done = { ...inv, address: addr, claimedAt: now };
    delete done.expired;
    writeFileSync(this.path(code), JSON.stringify(done));
    return done;
  }
}
