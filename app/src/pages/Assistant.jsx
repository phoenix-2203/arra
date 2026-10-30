// "Describe your order": the buyer writes the deal in their own words, Claude asks for
// what's missing one question at a time and fills in the form as it goes. Nothing is
// locked from here: the buyer still checks every field, and the supplier's wallet only
// ever comes from the invite link.
import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";

const STARTERS = [
  "30 phones from Phoenix Store in China: 10 Samsung S10 at $10 and 20 iPhone 15 Pro at $15",
  "A 6-seater dining table from Ade's Workshop, $45, ready in 3 weeks",
  "A logo and brand kit from Tunde Studio for $40, delivered in 10 days",
];

export default function Assistant({ onDraft, onReady }) {
  const [open, setOpen] = useState(false);
  const [chat, setChat] = useState([]); // { role, content }
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);
  const end = useRef(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [chat, busy]);

  async function send(words) {
    const content = (words ?? text).trim();
    if (!content || busy) return;
    const next = [...chat, { role: "user", content }];
    setChat(next);
    setText("");
    setError("");
    setBusy(true);
    try {
      const today = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD in the buyer's time zone
      const r = await api.assistant(next, today);
      setChat([...next, { role: "assistant", content: r.message }]);
      onDraft(r.draft);
      setReady(r.ready);
    } catch (e) {
      setError(e.message);
      setChat(chat); // let them resend
      setText(content);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button type="button" className="ai-open" onClick={() => setOpen(true)}>
        <span className="ai-spark" aria-hidden>✦</span>
        <span><strong>Describe your order instead</strong><small>Write it like a message. The assistant fills in the form and asks for anything missing.</small></span>
      </button>
    );
  }

  return (
    <section className="ai-box stack" aria-label="Order assistant">
      <div className="ai-head">
        <strong><span className="ai-spark" aria-hidden>✦</span> Order assistant</strong>
        <button type="button" className="linkish" onClick={() => setOpen(false)}>Fill by hand</button>
      </div>
      {!chat.length ? (
        <div className="stack">
          <p className="small muted">Say what you're buying, from whom, how many and the price. For example:</p>
          {STARTERS.map((s) => (
            <button key={s} type="button" className="ai-starter" onClick={() => setText(s)}>{s}</button>
          ))}
        </div>
      ) : (
        <ol className="ai-chat">
          {chat.map((m, i) => (
            <li key={i} className={m.role === "user" ? "ai-me" : "ai-it"}>{m.content}</li>
          ))}
          {busy ? <li className="ai-it ai-typing" aria-label="Thinking"><span /><span /><span /></li> : null}
          <li ref={end} aria-hidden className="ai-end" />
        </ol>
      )}
      {error ? <p className="note bad">{error}</p> : null}
      {ready ? (
        <div className="note ok stack">
          <span>The form below is filled in. Check every line, invite your supplier, then continue.</span>
          <button type="button" className="auto small-btn" onClick={onReady}>Check the order</button>
        </div>
      ) : null}
      <form className="ai-input" onSubmit={(e) => (e.preventDefault(), send())}>
        <textarea rows={2} maxLength={1500} value={text} disabled={busy} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder={chat.length ? "Reply…" : "Describe your order…"} />
        <button type="submit" className="money auto" disabled={busy || !text.trim()}>Send</button>
      </form>
      <p className="small muted">The assistant only fills in the form. It never sees your wallet, and the supplier's wallet comes from their invite link.</p>
    </section>
  );
}
