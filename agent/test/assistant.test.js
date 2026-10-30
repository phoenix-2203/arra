import { test } from "node:test";
import assert from "node:assert/strict";
import { assistant, cleanDraft } from "../src/assistant.js";

const reply = (input) => async (_url, opts) => {
  reply.last = JSON.parse(opts.body);
  return { ok: true, json: async () => ({ content: [{ type: "tool_use", name: "respond", input }] }) };
};

test("assistant turns a description into a clean draft", async () => {
  const ai = assistant({ key: "k", fetchFn: reply({ message: "10 × $10 + 20 × $15 = $400. That's above the $50 limit.", ready: false,
    draft: { kind: "goods", supplier: "Phoenix Store", product: "Phones", quantity: 1, unit: "lot", unitPriceUsd: "400", depositPct: 30, details: [{ label: "Item 1", value: "10 × Samsung S10, $10 each" }], evil: "x", shipBy: "soon" } }) });
  const r = await ai.chat([{ role: "user", content: "30 phones from Phoenix Store" }], "2026-10-30");
  assert.equal(r.draft.supplier, "Phoenix Store");
  assert.equal(r.draft.quantity, "1");
  assert.equal(r.draft.unitPriceUsd, "400");
  assert.equal(r.draft.evil, undefined);
  assert.equal(r.draft.shipBy, undefined);
  assert.match(reply.last.system, /2026-10-30/);
  assert.equal(reply.last.tool_choice.name, "respond");
});

test("assistant is off without a key and rejects bad chats", async () => {
  await assert.rejects(assistant({ key: "" }).chat([{ role: "user", content: "hi" }]), { status: 503 });
  const ai = assistant({ key: "k", fetchFn: reply({ message: "", draft: {}, ready: false }) });
  await assert.rejects(ai.chat([{ role: "assistant", content: "hi" }]), { status: 400 });
  await assert.rejects(ai.chat([]), { status: 400 });
});

test("cleanDraft drops unsafe values", () => {
  assert.deepEqual(cleanDraft({ depositPct: 90, transitDays: 5, term: "XYZ", unitPriceUsd: "1e9", quantity: -1 }), {});
});
