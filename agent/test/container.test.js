import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkContainerNumber, containerCheckDigit } from '../src/container.js';

test('accepts real-format container numbers with a correct check digit', () => {
  // CSQU3054383 is the worked example from the ISO 6346 standard.
  assert.equal(containerCheckDigit('CSQU305438'), 3);
  assert.deepEqual(checkContainerNumber('CSQU3054383'), { ok: true, number: 'CSQU3054383' });
  assert.equal(checkContainerNumber('csqu 305438-3').ok, true, 'spaces, dashes and lower case are fine');
});

test('a check digit of 10 is written as 0', () => {
  // Find a serial whose raw remainder is 10 and confirm it maps to 0.
  let found = false;
  for (let n = 0; n < 2000 && !found; n++) {
    const first10 = 'MSCU' + String(n).padStart(6, '0');
    let sum = 0;
    const vals = { M: 24, S: 30, C: 13, U: 32 };
    for (let i = 0; i < 10; i++) sum += (i < 4 ? vals[first10[i]] : Number(first10[i])) * 2 ** i;
    if (sum % 11 === 10) {
      assert.equal(containerCheckDigit(first10), 0);
      assert.equal(checkContainerNumber(first10 + '0').ok, true);
      found = true;
    }
  }
  assert.ok(found);
});

test('rejects a wrong check digit', () => {
  const r = checkContainerNumber('CSQU3054384');
  assert.equal(r.ok, false);
  assert.match(r.reason, /fails its built-in check/);
});

test('rejects malformed numbers', () => {
  for (const bad of ['', 'CSQ3054383', 'CSQX3054383', 'CSQU305438', '1234567890A', 'TRACK123']) {
    const r = checkContainerNumber(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.reason, /4 letters then 7 digits/);
  }
});
