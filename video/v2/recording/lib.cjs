const { chromium } = require('playwright');
const ANVIL = 'http://127.0.0.1:8545';
const ACCTS = { buyer: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', supplier: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', other: '0x90F79bf6EB2c4f870365E785982E1f101E93b906' };
async function open(who, { mobile = true, browser, extra = {} } = {}) {
  const b = browser ?? await chromium.launch();
  const ctx = await b.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 }, ...extra });
  const acct = who ? ACCTS[who] : null;
  await ctx.addInitScript(({ acct, ANVIL }) => {
    const listeners = {};
    let connected = !!acct;
    window.ethereum = {
      isMetaMask: true,
      async request({ method, params }) {
        if (method === 'eth_requestAccounts') { connected = true; return acct ? [acct] : []; }
        if (method === 'eth_accounts') return connected && acct ? [acct] : [];
        if (method === 'eth_chainId') return '0xa4ec';
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null;
        if (method === 'eth_sendTransaction') params = params.map(({ feeCurrency, ...t }) => t);
        const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
        const j = await r.json();
        if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
        return j.result;
      },
      on(ev, f) { (listeners[ev] ??= []).push(f); }, removeListener() {},
    };
  }, { acct, ANVIL });
  await ctx.route(/forno\.celo\.org/, async (route) => {
    const r = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: await r.text() });
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });
  return { b, ctx, page };
}
module.exports = { open, ACCTS, ANVIL };
