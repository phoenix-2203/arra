// Page proof: a supplier shows that the Instagram, TikTok or X page buyers know them by
// belongs to the wallet that gets paid. Arra gives them a short code for that page and
// wallet; they put it in their bio for a minute; Arra's agent reads the page (a paid
// x402 call) and, if the code is there, records the link. They can then remove the code.
//
// Only the page's owner can edit its bio, so a scammer can't confirm someone else's page
// for their own wallet. A buyer paying a wallet that differs from the confirmed one sees
// a clear warning: that's the usual impersonation trick.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { isAddress } from "viem";
import { PLATFORMS, cleanHandle } from "./supplierCheck.js";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class PageProofs {
  constructor(file, mac) {
    this.file = file;
    this.mac = mac;
    this.tries = new Map();
  }
  all() {
    return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {};
  }
  parse(platform, rawHandle, address) {
    const handle = cleanHandle(rawHandle);
    if (!PLATFORMS[platform]) throw Object.assign(new Error("Choose Instagram, TikTok or X"), { status: 400 });
    if (!handle) throw Object.assign(new Error("That doesn't look like a username"), { status: 400 });
    if (!isAddress(String(address ?? ""), { strict: false })) throw Object.assign(new Error("Connect the wallet that gets paid"), { status: 400 });
    return { platform, handle, address: address.toLowerCase() };
  }
  /** The code for this page and wallet: always the same, so a page refresh doesn't change it. */
  code(platform, handle, address) {
    const hex = this.mac(`arra-page:${platform}:${handle}:${address}`);
    let out = "";
    for (let i = 0; i < 6; i++) out += ALPHABET[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % ALPHABET.length];
    return `ARRA-${out}`;
  }
  start(platform, rawHandle, address) {
    const p = this.parse(platform, rawHandle, address);
    return { ...p, label: PLATFORMS[platform].label, code: this.code(p.platform, p.handle, p.address) };
  }
  get(platform, rawHandle) {
    const handle = cleanHandle(rawHandle);
    return handle ? this.all()[`${platform}:${handle}`] ?? null : null;
  }
  byAddress(address) {
    const a = String(address).toLowerCase();
    return Object.values(this.all()).filter((p) => p.address === a);
  }
  /** Reads the page fresh (paid) and records the proof if the code is in the bio. */
  async confirm(platform, rawHandle, address, checker, now = Date.now()) {
    const p = this.parse(platform, rawHandle, address);
    const key = `${p.platform}:${p.handle}`;
    const t = this.tries.get(key) ?? { start: now, n: 0 };
    if (now - t.start > 3600_000) (t.start = now), (t.n = 0);
    if (++t.n > 5) throw Object.assign(new Error("Too many tries for this page. Wait an hour and try again."), { status: 429 });
    this.tries.set(key, t);
    const code = this.code(p.platform, p.handle, p.address);
    const profile = await checker.check(p.platform, p.handle, { fresh: true });
    if (!profile.found) throw Object.assign(new Error(`We couldn't find a public ${PLATFORMS[platform].label} account named @${p.handle}.`), { status: 404 });
    const bio = String(profile.summary?.bio ?? "").toUpperCase().replace(/\s+/g, "");
    if (!bio.includes(code)) return { confirmed: false, code, bio: profile.summary?.bio ?? "" };
    const all = this.all();
    all[key] = { platform: p.platform, label: PLATFORMS[platform].label, handle: p.handle, address: p.address, at: Math.floor(now / 1000), paidTx: profile.paid?.txHash ?? null };
    writeFileSync(this.file, JSON.stringify(all, null, 1));
    return { confirmed: true, proof: all[key] };
  }
}
