// Optional for suppliers: link the Instagram, TikTok or X page buyers know you by to the
// wallet you're paid at. Put a short code in your bio for a minute, Arra's agent reads
// the page, and buyers see "Page confirmed". Nobody else can do it for your page, because
// only you can edit your bio.
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { PLATFORMS, readHandle } from "./SupplierVerify.jsx";

const WORDS = {
  en: {
    title: "Get a “Page confirmed” badge (optional, 1 minute)",
    why: "Buyers trust a supplier more when they can see the page they found you on really belongs to you. It also stops anyone pretending to be you.",
    page: "Your page",
    next: "Get my code",
    step: (label) => `Add this code anywhere in your ${label} bio, save, then tap Check. You can remove it straight after.`,
    copy: "Copy code",
    copied: "Copied",
    check: "I've added it, check now",
    checking: "Reading your page…",
    notYet: "We can't see the code in your bio yet. Bios can take a minute to update; try again shortly.",
    done: (h, label) => `@${h} on ${label} is confirmed for this wallet. Buyers will see “Page confirmed”. You can remove the code from your bio now.`,
    have: (h, label) => `Page confirmed: @${h} on ${label}.`,
    back: "Back",
  },
  zh: {
    title: "获取“主页已认证”标识（选填，约 1 分钟）",
    why: "当买家确认他们找到您的主页确实属于您时，会更信任您，也能防止他人冒充您。",
    page: "您的主页",
    next: "获取验证码",
    step: (label) => `将此验证码添加到您的 ${label} 简介中并保存，然后点击“检查”。检查后即可删除。`,
    copy: "复制验证码",
    copied: "已复制",
    check: "已添加，立即检查",
    checking: "正在读取您的主页…",
    notYet: "暂未在简介中看到验证码。简介更新可能需要一分钟，请稍后再试。",
    done: (h, label) => `${label} 账号 @${h} 已与此钱包绑定，买家将看到“主页已认证”。现在可以从简介中删除验证码。`,
    have: (h, label) => `主页已认证：${label} @${h}。`,
    back: "返回",
  },
};

export default function PageProof({ address, lang = "en" }) {
  const w = WORDS[lang] ?? WORDS.en;
  const [have, setHave] = useState(null);
  const [platform, setPlatform] = useState("instagram");
  const [handle, setHandle] = useState("");
  const [code, setCode] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { tone, text }
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!address) return;
    api.pageProofs(address).then((r) => setHave(r.proofs)).catch(() => setHave([]));
  }, [address]);

  if (!address || have === null) return null;
  if (have.length) return msg?.tone === "ok" ? <p className="note ok">{msg.text}</p> : <p className="small note-ok">✓ {w.have(have[0].handle, have[0].label)}</p>;

  async function start() {
    setMsg(null);
    try {
      const h = readHandle(handle, platform);
      const r = await api.pageProofStart(h.platform, h.handle, address);
      setPlatform(r.platform);
      setHandle(r.handle);
      setCode(r);
    } catch (e) {
      setMsg({ tone: "bad", text: e.message });
    }
  }
  async function confirm() {
    setMsg(null);
    setBusy(true);
    try {
      const r = await api.pageProofConfirm(code.platform, code.handle, address);
      if (r.confirmed) {
        setMsg({ tone: "ok", text: w.done(r.proof.handle, r.proof.label) });
        setHave([r.proof]);
      } else setMsg({ tone: "", text: w.notYet });
    } catch (e) {
      setMsg({ tone: "bad", text: e.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="more">
      <summary>{w.title}</summary>
      <div className="stack">
        <p className="small muted">{w.why}</p>
        {!code ? (
          <>
            <div className="chips wrap" role="radiogroup" aria-label={w.page}>
              {PLATFORMS.map(([k, label]) => (
                <button key={k} type="button" role="radio" aria-checked={platform === k} className={platform === k ? "chip on" : "chip"} onClick={() => setPlatform(k)}>{label}</button>
              ))}
            </div>
            <div className="with-btn">
              <input value={handle} onChange={(e) => setHandle(e.target.value)} placeholder="@username" autoCapitalize="off" spellCheck="false" aria-label={w.page} />
              <button type="button" className="secondary small-btn" disabled={!handle.trim()} onClick={start}>{w.next}</button>
            </div>
          </>
        ) : (
          <>
            <p className="small">{w.step(code.label)}</p>
            <div className="proof-code">
              <strong className="num">{code.code}</strong>
              <button type="button" className="secondary small-btn" onClick={() => navigator.clipboard?.writeText(code.code).then(() => setCopied(true))}>{copied ? w.copied : w.copy}</button>
            </div>
            <button className="money" disabled={busy} onClick={confirm}>{busy ? w.checking : w.check}</button>
            <button type="button" className="linkish" onClick={() => { setCode(null); setMsg(null); }}>{w.back}</button>
          </>
        )}
        {msg ? <p className={`note ${msg.tone}`}>{msg.text}</p> : null}
      </div>
    </details>
  );
}
