// A visible cursor for screen recordings: glides with easing, shows a ripple on click.
window.addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.innerHTML = '<svg width="44" height="44" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7.2 1.4 4.1 7.6-3 1.6-4.1-7.6L4 19.5z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  Object.assign(c.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none', transform: 'translate(960px, 620px)', filter: 'drop-shadow(0 3px 6px rgba(0,0,0,.45))' });
  document.documentElement.appendChild(c);
  if (window.__ZOOM) document.body.style.zoom = String(window.__ZOOM);
  const st = document.createElement('style');
  st.textContent = '@keyframes dc-ripple{from{transform:translate(-50%,-50%) scale(.2);opacity:.85}to{transform:translate(-50%,-50%) scale(1);opacity:0}} .dc-ripple{position:fixed;width:68px;height:68px;border-radius:50%;background:rgba(204,255,61,.55);pointer-events:none;z-index:2147483646;animation:dc-ripple .5s ease-out forwards} .dc-cap{position:fixed;right:36px;top:112px;z-index:2147483645;background:rgba(10,12,8,.88);color:#eef2ea;border:1px solid rgba(204,255,61,.5);padding:14px 26px;border-radius:999px;font:600 22px/1.2 system-ui,sans-serif;pointer-events:none;transition:opacity .4s}';
  document.head.appendChild(st);
  if (window.__TAG) { const tg = document.createElement('div'); tg.textContent = window.__TAG; Object.assign(tg.style, { position: 'fixed', left: '28px', bottom: '24px', zIndex: 2147483644, font: '600 19px/1 system-ui,sans-serif', color: 'rgba(238,242,234,.72)', background: 'rgba(10,12,8,.78)', border: '1px solid rgba(238,242,234,.14)', padding: '10px 16px', borderRadius: '999px', pointerEvents: 'none' }); document.documentElement.appendChild(tg); }
  window.__cur = { x: 960, y: 620 };
  window.__moveTo = (x, y, ms) => new Promise((done) => {
    const s = { ...window.__cur }; const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms), e = ease(t);
      window.__cur = { x: s.x + (x - s.x) * e, y: s.y + (y - s.y) * e };
      c.style.transform = `translate(${window.__cur.x - 6}px, ${window.__cur.y - 3}px)`;
      t < 1 ? requestAnimationFrame(step) : done();
    };
    requestAnimationFrame(step);
  });
  window.__ripple = () => { const r = document.createElement('div'); r.className = 'dc-ripple'; r.style.left = window.__cur.x + 'px'; r.style.top = window.__cur.y + 'px'; document.documentElement.appendChild(r); setTimeout(() => r.remove(), 600); };
  window.__caption = (text) => { let el = document.querySelector('.dc-cap'); if (!text) { if (el) el.style.opacity = '0'; return; } if (!el) { el = document.createElement('div'); el.className = 'dc-cap'; document.documentElement.appendChild(el); } el.textContent = text; el.style.opacity = '1'; };
});
