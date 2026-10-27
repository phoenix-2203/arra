// F9: address-change alarm. The "our bank details have changed" email is the
// classic way import payments get stolen. Arra remembers which address each
// supplier was paid at, and a new address for a known supplier is blocked until
// the buyer confirms it outside the chat (a phone or video call).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { getAddress, isAddress } from 'viem';

const key = (supplierName) => String(supplierName).trim().toLowerCase().replace(/\s+/g, ' ');

export class PayeeBook {
  constructor(file) {
    this.file = file;
    this.data = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
  }

  /**
   * status: 'new' (first order with this supplier), 'known' (same address as
   * before) or 'changed' (STOP: confirm by phone before paying).
   */
  check(buyer, supplierName, address) {
    if (!isAddress(address)) return { status: 'invalid', message: 'That is not a valid wallet address.' };
    const addr = getAddress(address);
    const entry = this.data[getAddress(buyer)]?.[key(supplierName)];
    if (!entry) {
      return { status: 'new', address: addr, message: `First order with ${supplierName}. The order only goes live once they sign from this address.` };
    }
    if (entry.addresses.includes(addr)) {
      return { status: 'known', address: addr, message: `Same address you used with ${supplierName} before.` };
    }
    return {
      status: 'changed',
      address: addr,
      previous: entry.addresses.at(-1),
      message: `${supplierName} is asking to be paid at a NEW address. This is how most payment scams work. Call them on a number you already had (not one from this message) and confirm before continuing.`,
    };
  }

  /** Records an address after a supplier accepted an order from it (or the buyer confirmed by phone). */
  remember(buyer, supplierName, address, how = 'accepted') {
    const b = getAddress(buyer);
    const addr = getAddress(address);
    const k = key(supplierName);
    this.data[b] ??= {};
    this.data[b][k] ??= { name: supplierName, addresses: [], history: [] };
    const entry = this.data[b][k];
    if (!entry.addresses.includes(addr)) entry.addresses.push(addr);
    entry.history.push({ address: addr, how, at: new Date().toISOString() });
    this.save();
  }
}
