// Notes and evidence on an order. Only the order's buyer or supplier can post, and
// each note is signed by their wallet (EIP-712 typed data: free, moves no money), so
// nobody can fake a note in someone else's name. Photos are stored by fingerprint.
// A "change" note proposes new terms; it counts as agreed once the other side posts
// an "agree" note pointing at it, signed by their wallet too.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { verifyTypedData, keccak256, toBytes } from "viem";

export const NOTE_KINDS = ["note", "change", "agree"];
const MAX_PHOTO = 1_500_000; // bytes, after the phone has shrunk it
const ZERO = `0x${"0".repeat(64)}`;

export function noteTypedData({ orderId, kind, text, photo = ZERO, replyTo = ZERO, at }) {
  return {
    domain: { name: "Arra Notes", version: "1", chainId: 42220 },
    types: {
      Note: [
        { name: "orderId", type: "uint256" },
        { name: "kind", type: "string" },
        { name: "text", type: "string" },
        { name: "photo", type: "bytes32" },
        { name: "replyTo", type: "bytes32" },
        { name: "at", type: "uint256" },
      ],
    },
    primaryType: "Note",
    message: { orderId: BigInt(orderId), kind, text, photo, replyTo, at: BigInt(at) },
  };
}

export class Notes {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(join(dir, "photos"), { recursive: true });
  }
  file(id) {
    return join(this.dir, `${Number(id)}.json`);
  }
  list(id) {
    const all = existsSync(this.file(id)) ? JSON.parse(readFileSync(this.file(id), "utf8")) : [];
    // Mark each proposed change as agreed if the other side has agreed to it.
    return all.map((n) => (n.kind === "change" ? { ...n, agreedBy: all.find((a) => a.kind === "agree" && a.replyTo === n.id && a.author !== n.author)?.author ?? null } : n));
  }
  photoPath(hash) {
    return join(this.dir, "photos", `${hash.slice(2)}.jpg`);
  }
  hasPhoto(hash) {
    return /^0x[0-9a-f]{64}$/.test(hash) && existsSync(this.photoPath(hash));
  }
  /** Saves a JPEG and returns its fingerprint (sha-256 as 0x hex). */
  savePhoto(base64) {
    const buf = Buffer.from(String(base64 ?? ""), "base64");
    if (!buf.length || buf.length > MAX_PHOTO) throw Object.assign(new Error("Photo missing or too large"), { status: 400 });
    if (buf[0] !== 0xff || buf[1] !== 0xd8) throw Object.assign(new Error("Photos must be JPEG"), { status: 400 });
    const hash = `0x${createHash("sha256").update(buf).digest("hex")}`;
    writeFileSync(this.photoPath(hash), buf);
    return hash;
  }

  /**
   * Adds a signed note. `order` is the vault's view of the order (buyer, supplier).
   * Returns the stored note.
   */
  async add(order, { kind, text, photo = ZERO, replyTo = ZERO, at, signature }, now = Math.floor(Date.now() / 1000)) {
    const bad = (m) => Object.assign(new Error(m), { status: 400 });
    if (!NOTE_KINDS.includes(kind)) throw bad("Unknown note type");
    const clean = String(text ?? "");
    if (clean.length > 1000) throw bad("Keep notes under 1,000 characters");
    if (kind !== "agree" && !clean.trim() && photo === ZERO) throw bad("Write something or add a photo");
    if (!Number.isInteger(at) || Math.abs(at - now) > 600) throw bad("The note's time is off; check your phone's clock and try again");
    if (photo !== ZERO && !this.hasPhoto(photo)) throw bad("Upload the photo first");
    const existing = this.list(order.id);
    if (kind === "agree" && !existing.some((n) => n.id === replyTo && n.kind === "change")) throw bad("There's no proposed change to agree to");
    const data = noteTypedData({ orderId: order.id, kind, text: clean, photo, replyTo, at });
    let author = null;
    for (const who of [order.buyer, order.supplier]) {
      // eslint-disable-next-line no-await-in-loop
      if (await verifyTypedData({ address: who, ...data, signature }).catch(() => false)) author = who;
    }
    if (!author) throw Object.assign(new Error("Only the buyer or the supplier of this order can add notes"), { status: 403 });
    if (kind === "agree" && existing.find((n) => n.id === replyTo)?.author === author) throw bad("The other side has to agree to your change");
    const note = { id: keccak256(toBytes(signature)), kind, text: clean, photo, replyTo, at, author, role: author === order.buyer ? "buyer" : "supplier", signature };
    if (existing.some((n) => n.id === note.id)) return note;
    const raw = existsSync(this.file(order.id)) ? JSON.parse(readFileSync(this.file(order.id), "utf8")) : [];
    raw.push(note);
    writeFileSync(this.file(order.id), JSON.stringify(raw, null, 1));
    return note;
  }
}
