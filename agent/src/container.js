// F8: shipment check. Every shipping container number (ISO 6346) ends in a
// check digit computed from the other ten characters, so a made-up number is
// caught instantly, without any tracking API.
// Format: 3-letter owner code + category (U, J or Z) + 6 digits + check digit,
// e.g. CSQU3054383.

const LETTER_VALUES = (() => {
  const values = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    if (v % 11 === 0) v++; // 11, 22, 33 are skipped by the standard
    values[ch] = v++;
  }
  return values;
})();

export function normaliseContainerNumber(input) {
  return String(input ?? '').toUpperCase().replace(/[\s-]/g, '');
}

export function containerCheckDigit(first10) {
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    const value = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += value * 2 ** i;
  }
  return (sum % 11) % 10;
}

/**
 * Returns { ok: true, number } or { ok: false, number, reason } with a reason
 * written for a trader, not an engineer.
 */
export function checkContainerNumber(input) {
  const number = normaliseContainerNumber(input);
  if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(number)) {
    return {
      ok: false,
      number,
      reason: 'A container number is 4 letters then 7 digits, like CSQU 305438 3. Please check it with the supplier.',
    };
  }
  const expected = containerCheckDigit(number.slice(0, 10));
  if (Number(number[10]) !== expected) {
    return {
      ok: false,
      number,
      reason: 'This container number fails its built-in check, so it is mistyped or not a real container. Ask the supplier for a photo of the bill of lading.',
    };
  }
  return { ok: true, number };
}
