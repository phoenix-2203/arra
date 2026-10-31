// Shown when "Your orders" or History needs proof the wallet is yours: one free
// signature, remembered on this device for 30 days. It moves no money.
import { useState } from "react";
import { api, saveSession } from "./api.js";
import { signIn } from "./chain.js";

export default function SignIn({ what = "your orders", onDone }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setError("");
    setBusy(true);
    try {
      await signIn(api, saveSession);
      onDone();
    } catch (e) {
      const msg = e.shortMessage ?? e.message ?? "";
      if (!/reject|denied|cancel/i.test(msg)) setError(msg);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="block stack signin">
      <p><strong>Confirm it's your wallet</strong></p>
      <p className="small muted">So nobody else can look up {what}, Arra asks for one free signature. It moves no money, costs nothing and is remembered on this device for 30 days.</p>
      <button className="money" disabled={busy} onClick={go}>{busy ? "Check your wallet…" : "Confirm in my wallet"}</button>
      {error ? <p className="note bad">{error}</p> : null}
    </div>
  );
}
