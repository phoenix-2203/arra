// Small notification system: one toast per transaction that moves through
// "confirm in your wallet" → "sending" → "done" (with a link) or "failed".
import { useEffect, useState } from "react";
import { EXPLORER } from "./chain.js";

let items = [];
let nextId = 1;
const listeners = new Set();
const emit = () => listeners.forEach((l) => l([...items]));

export function toast(t) {
  const id = nextId++;
  items = [...items, { id, kind: "info", ...t }];
  emit();
  const api = {
    update(patch) {
      items = items.map((i) => (i.id === id ? { ...i, ...patch } : i));
      emit();
      if (patch.kind === "ok" || patch.kind === "bad") setTimeout(api.close, patch.kind === "ok" ? 7000 : 12000);
      return api;
    },
    close() {
      items = items.filter((i) => i.id !== id);
      emit();
    },
  };
  return api;
}

/** Runs one transaction with a toast that follows it from start to finish. */
export async function withToast(send, words) {
  const t = toast({ kind: "info", title: words.confirm ?? "Confirm in your wallet", spinner: true });
  try {
    const hash = await send({
      onSent: (h) => t.update({ title: words.pending ?? "Sending…", hash: h, spinner: true }),
    });
    t.update({ kind: "ok", title: words.done, body: words.doneBody, hash, spinner: false });
    return hash;
  } catch (e) {
    const msg = e.shortMessage ?? e.message ?? "Something went wrong";
    const rejected = /reject|denied|cancel/i.test(msg);
    t.update({ kind: "bad", title: rejected ? "Cancelled. Nothing was sent." : "Didn't go through", body: rejected ? null : msg, spinner: false });
    throw e;
  }
}

export function Toasts({ viewTx = "View transaction" }) {
  const [list, setList] = useState(items);
  useEffect(() => {
    listeners.add(setList);
    return () => listeners.delete(setList);
  }, []);
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="toast-mark" aria-hidden="true">{t.spinner ? <span className="spin" /> : t.kind === "ok" ? "✓" : t.kind === "bad" ? "!" : "•"}</span>
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.body ? <span>{t.body}</span> : null}
            {t.hash ? <a href={`${EXPLORER}/tx/${t.hash}`} target="_blank" rel="noreferrer">{viewTx}</a> : null}
          </div>
          <button className="toast-x" aria-label="Close" onClick={() => { items = items.filter((i) => i.id !== t.id); emit(); }}>×</button>
        </div>
      ))}
    </div>
  );
}
