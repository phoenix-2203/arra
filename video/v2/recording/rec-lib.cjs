// Screen-recording helpers for the demo film: a visible cursor, captions, and full-HD frames
// taken straight from the browser (1920x1080, page shown at 1.5x), saved as MP4 with marks.
const { open } = require('./lib.cjs');
const fs = require('fs');
const { execFileSync } = require('child_process');
const CURSOR = fs.readFileSync(__dirname + '/demo-cursor.js', 'utf8');
const OUT = __dirname + '/clips';
fs.mkdirSync(OUT, { recursive: true });

async function stage(who, { browser, lang, tag = 'Real Arra app · local test chain, example amounts' } = {}) {
  const { b, ctx, page } = await open(who, { mobile: false, browser, extra: { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 } });
  await ctx.addInitScript({ content: `window.__ZOOM = 1.5; window.__TAG = ${JSON.stringify(tag)}; try { localStorage.setItem('arra.theme','dark'); ${lang ? `localStorage.setItem('arra.lang', ${JSON.stringify(lang)});` : ''} } catch (e) {}` });
  await ctx.addInitScript({ content: CURSOR });
  const p = page;
  const cdp = await ctx.newCDPSession(p);
  let frames = [], marks = {}, on = false;
  cdp.on('Page.screencastFrame', (f) => { if (on) frames.push({ t: f.metadata.timestamp, data: f.data }); cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
  const S = {
    b, ctx, p,
    w: (ms) => p.waitForTimeout(ms),
    async start() { frames = []; marks = {}; on = true; await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }); await p.waitForTimeout(250); },
    mark(n) { marks[n] = Date.now() / 1000; },
    async stop(name) {
      await p.waitForTimeout(300); const tStop = Date.now() / 1000; on = false; await cdp.send('Page.stopScreencast').catch(() => {});
      const dir = `${OUT}/${name}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      let list = '';
      frames.forEach((f, i) => {
        const fn = `f${String(i).padStart(5, '0')}.jpg`; fs.writeFileSync(`${dir}/${fn}`, Buffer.from(f.data, 'base64'));
        list += `file '${fn}'\nduration ${(i + 1 < frames.length ? frames[i + 1].t - f.t : Math.max(0.1, tStop - f.t)).toFixed(4)}\n`;
      });
      list += `file 'f${String(frames.length - 1).padStart(5, '0')}.jpg'\n`;
      fs.writeFileSync(`${dir}/list.txt`, list);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', `${OUT}/${name}.mp4`], { cwd: dir });
      const t0 = frames[0].t;
      const m = Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, +(v - t0).toFixed(2)]));
      m._end = +(tStop - t0).toFixed(2);
      fs.writeFileSync(`${OUT}/${name}.json`, JSON.stringify(m, null, 1));
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(name, JSON.stringify(m));
    },
    async to(sel, ms = 650) {
      const el = p.locator(sel).first(); await el.scrollIntoViewIfNeeded().catch(() => {});
      const box = await el.boundingBox();
      await p.evaluate(([x, y, ms]) => window.__moveTo(x, y, ms), [box.x + box.width / 2, box.y + box.height / 2, ms]);
    },
    async click(sel, ms) { await S.to(sel, ms); await p.waitForTimeout(90); await p.evaluate(() => window.__ripple()); await p.locator(sel).first().click(); },
    async type(sel, text, delay = 45) { await S.click(sel, 500); await p.locator(sel).first().pressSequentially(text, { delay }); },
    scroll: (y, block = 96) => (typeof y === 'number' ? p.evaluate((y) => window.scrollTo({ top: y, behavior: 'smooth' }), y) : p.locator(y).first().evaluate((el, block) => window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - block, behavior: 'smooth' }), block)),
    caption: (t) => p.evaluate((t) => window.__caption(t), t),
  };
  return S;
}
module.exports = { stage, OUT };
