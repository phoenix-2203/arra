// Private order links. Vault order ids are counters (1, 2, 3…), so a link like
// /o/2 is easy to guess. Each order instead gets a 10-character code made from
// a secret that only this server knows: /o/k7Qm2xR9vB. Nobody can work out the
// code for another order, and nothing extra has to be stored per order.
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// No 0/O, 1/l/I, so codes are easy to read out over the phone.
const ALPHABET = "23456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";
export const LINK_RE = /^[2-9a-km-zA-HJ-NP-Z]{10}$/;

function encode(buf, length = 10) {
  let n = BigInt(`0x${buf.toString("hex")}`);
  let out = "";
  const base = BigInt(ALPHABET.length);
  while (out.length < length) {
    out += ALPHABET[Number(n % base)];
    n /= base;
  }
  return out;
}

export class OrderLinks {
  /** `file` holds the secret; it's created once and must be kept (it's in the data folder). */
  constructor(file, secret) {
    if (secret) this.secret = Buffer.from(secret);
    else if (file && existsSync(file)) this.secret = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    else {
      this.secret = randomBytes(32);
      if (file) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, this.secret.toString("hex"), { mode: 0o600 });
      }
    }
    this.byCode = new Map();
  }

  code(id) {
    return encode(createHmac("sha256", this.secret).update(`arra-order:${Number(id)}`).digest());
  }

  /** Finds the order id for a code, checking ids up to `max` (the current order count). */
  resolve(code, max) {
    if (!LINK_RE.test(code)) return null;
    if (this.byCode.has(code)) return this.byCode.get(code);
    for (let id = 1; id <= max; id++) {
      const c = this.code(id);
      this.byCode.set(c, id);
      if (c === code) return id;
    }
    return null;
  }
}
