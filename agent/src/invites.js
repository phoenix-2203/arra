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
import { sheetRef } from "./orderSheet.js";

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
  save(inv) {
    const out = { ...inv };
    delete out.expired;
    writeFileSync(this.path(inv.code), JSON.stringify(out));
    return out;
  }

  /**
   * Terms first: the buyer attaches the draft order. The supplier agrees to exactly
   * this version (by its fingerprint); any later edit resets the agreement.
   */
  setDraft(code, sheet, now = Date.now()) {
    const inv = this.get(code, now);
    if (!inv) throw Object.assign(new Error("This invite doesn't exist"), { status: 404 });
    if (!sheet || typeof sheet !== "object") throw Object.assign(new Error("sheet required"), { status: 400 });
    const ref = sheetRef(sheet);
    if (inv.draftRef === ref) return inv;
    return this.save({ ...inv, draft: sheet, draftRef: ref, draftAt: now, agreedRef: null, agreedAt: null });
  }

  /** The supplier agrees to the current draft (and the invite takes their wallet if it hasn't yet). */
  agree(code, address, ref, now = Date.now()) {
    let inv = this.claim(code, address, now);
    if (!inv.draftRef) throw Object.assign(new Error("There are no terms to agree to yet"), { status: 409 });
    if (String(ref).toLowerCase() !== inv.draftRef.toLowerCase()) throw Object.assign(new Error("The buyer changed the terms. Please read them again."), { status: 409 });
    inv = this.get(code, now);
    return this.save({ ...inv, agreedRef: inv.draftRef, agreedAt: now, changeRequest: null });
  }

  /** The supplier asks for a change instead of agreeing. */
  suggest(code, address, text, now = Date.now()) {
    const inv = this.claim(code, address, now);
    const clean = String(text ?? "").trim().slice(0, 600);
    if (!clean) throw Object.assign(new Error("Say what should change"), { status: 400 });
    return this.save({ ...this.get(code, now), agreedRef: null, agreedAt: null, changeRequest: { text: clean, at: now, ref: inv.draftRef ?? null } });
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
