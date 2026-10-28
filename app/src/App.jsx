import { useEffect, useState, useCallback } from "react";
import { connect, hasWallet, isMiniPay, VAULT, EXPLORER } from "./chain.js";
import { Wordmark } from "./Adire.jsx";
import Home from "./pages/Home.jsx";
import Landing from "./pages/Landing.jsx";
import NewOrder from "./pages/NewOrder.jsx";
import Order from "./pages/Order.jsx";

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

// Dark by default; the person can switch to light.
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return "dark";
}

function ThemeToggle() {
  const [theme, setTheme] = useState(currentTheme);
  const flip = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("arra.theme", next);
    } catch {
      /* storage can be unavailable */
    }
    setTheme(next);
  };
  return (
    <button className="icon-btn" onClick={flip} aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
      {theme === "dark" ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="4.5" /><path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" /></svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" /></svg>
      )}
    </button>
  );
}

export function navigate(path) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  window.scrollTo(0, 0);
}

const link = (path) => (e) => {
  e.preventDefault();
  navigate(path);
};

export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [account, setAccount] = useState(null);
  const [connectError, setConnectError] = useState("");

  useEffect(() => {
    const onPop = () => setPath(location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const doConnect = useCallback(async () => {
    setConnectError("");
    try {
      setAccount(await connect());
    } catch (e) {
      setConnectError(e.shortMessage ?? e.message);
    }
  }, []);

  // MiniPay connects silently and skips the homepage; other wallets wait for a tap.
  useEffect(() => {
    if (isMiniPay()) {
      doConnect();
      if (location.pathname === "/") navigate("/app");
    }
    if (hasWallet() && window.ethereum.on) {
      const onChange = (accs) => setAccount(accs?.[0] ?? null);
      window.ethereum.on("accountsChanged", onChange);
      return () => window.ethereum.removeListener?.("accountsChanged", onChange);
    }
  }, [doConnect]);

  const order = path.match(/^\/o\/(\d+)/);
  const wallet = { account, connect: doConnect, connectError };
  const landing = path === "/";

  return (
    <div className={`shell${landing ? " wide" : ""}`}>
      <header className="bar">
        <Wordmark />
        {landing ? (
          <nav className="nav-links" aria-label="Sections">
            <a href="#how">How it works</a>
            <a href="#security">Security</a>
            <a href="#faq">Questions</a>
          </nav>
        ) : null}
        <div className="tools">
          {account ? <a className="who num" href="/app" onClick={link("/app")}>{short(account)}</a> : null}
          {landing ? <a href="/app" className="button money small-btn" onClick={link("/app")}>Open app</a> : null}
          {!landing && !account ? <button className="secondary small-btn" onClick={doConnect}>Connect</button> : null}
          <ThemeToggle />
        </div>
      </header>
      <main>
        {order ? <Order id={Number(order[1])} wallet={wallet} /> : path === "/new" ? <NewOrder wallet={wallet} /> : landing ? <Landing wallet={wallet} /> : <Home wallet={wallet} />}
      </main>
      <footer className="foot">
        <span>Money is held by an open contract on Celo, not by Arra.</span>
        <span className="foot-links">
          <a href={`${EXPLORER}/address/${VAULT}`} target="_blank" rel="noreferrer">Vault</a>
          <a href="https://github.com/phoenix-2203/arra" target="_blank" rel="noreferrer">Code</a>
          <a href="/" onClick={link("/")}>Home</a>
        </span>
      </footer>
    </div>
  );
}
