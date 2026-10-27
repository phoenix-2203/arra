import { useEffect, useState, useCallback } from "react";
import { connect, hasWallet, isMiniPay, VAULT, EXPLORER } from "./chain.js";
import { Wordmark } from "./Adire.jsx";
import Home from "./pages/Home.jsx";
import NewOrder from "./pages/NewOrder.jsx";
import Order from "./pages/Order.jsx";

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export function navigate(path) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

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

  // MiniPay connects silently; other wallets wait for a tap.
  useEffect(() => {
    if (isMiniPay()) doConnect();
    if (hasWallet() && window.ethereum.on) {
      const onChange = (accs) => setAccount(accs?.[0] ?? null);
      window.ethereum.on("accountsChanged", onChange);
      return () => window.ethereum.removeListener?.("accountsChanged", onChange);
    }
  }, [doConnect]);

  const order = path.match(/^\/o\/(\d+)/);
  const wallet = { account, connect: doConnect, connectError };

  return (
    <div className="shell">
      <header className="bar">
        <Wordmark />
        {account ? <span className="who num">{short(account)}</span> : null}
      </header>
      <main>
        {order ? <Order id={Number(order[1])} wallet={wallet} /> : path === "/new" ? <NewOrder wallet={wallet} /> : <Home wallet={wallet} />}
      </main>
      <footer className="foot">
        Money is held by an open contract on Celo, not by Arra.{" "}
        <a href={`${EXPLORER}/address/${VAULT}`} target="_blank" rel="noreferrer">Read the vault</a>
      </footer>
    </div>
  );
}
