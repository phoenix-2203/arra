// Renders film.html frame by frame (each frame = seek(t) + screenshot) and pipes them to ffmpeg.
//   node render.mjs stills 3 12.5 40      -> stills/ at those seconds
//   node render.mjs video [from] [to] [out]  -> silent H.264, 30 fps
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const HERE = new URL('.', import.meta.url).pathname;
const TL = JSON.parse(fs.readFileSync(HERE + 'timeline.json', 'utf8'));
const MIME = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', ttf: 'font/ttf', html: 'text/html', json: 'application/json' };
const PORT = Number(process.env.PORT ?? 8650);
const srv = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[f.split('.').pop()] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT);
const [mode, ...args] = process.argv.slice(2);
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.addInitScript((tl) => { window.TL = tl; }, TL);
await page.goto(`http://localhost:${PORT}/video/production/film.html`);
await page.evaluate(() => window.ready);
await page.waitForTimeout(400);
if (mode === 'stills') {
  fs.mkdirSync(HERE + 'stills', { recursive: true });
  for (const s of args.map(Number)) {
    await page.evaluate((t) => window.seek(t), s);
    await page.screenshot({ path: `${HERE}stills/t${s.toFixed(1).padStart(6, '0')}.jpg`, type: 'jpeg', quality: 85 });
  }
} else {
  const FPS = 30, from = Number(args[0] ?? 0), to = Number(args[1] ?? TL.total), out = args[2] ?? HERE + 'frames.mp4';
  const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p', '-r', String(FPS), out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.round((to - from) * FPS); const t0 = Date.now();
  for (let i = 0; i < n; i++) {
    await page.evaluate((x) => window.seek(x), from + i / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 300 === 0) console.log(`frame ${i}/${n} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  }
  ff.stdin.end(); await new Promise((r) => ff.on('close', r)); console.log('wrote', out);
}
await b.close(); srv.close();
