// Renders each card scene of film.html to its own clip (frame by frame: seekScene + screenshot).
//   node render.mjs [sceneId ...]     -> clips/<id>.mp4 (silent, 1080p30)
//   node render.mjs --stills id:u ... -> stills/<id>-<u>.jpg
import { createRequire } from 'node:module';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = '/root/arra';
const HERE = new URL('.', import.meta.url).pathname;
const TL = JSON.parse(fs.readFileSync(HERE + 'timeline.json', 'utf8'));
const MIME = { js: 'text/javascript', css: 'text/css', svg: 'image/svg+xml', png: 'image/png', ttf: 'font/ttf', html: 'text/html', json: 'application/json' };
const PORT = 8651;
const srv = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': MIME[f.split('.').pop()] ?? 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
}).listen(PORT);
const args = process.argv.slice(2);
const b = await chromium.launch();
const page = await b.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('pageerror', e.message));
await page.addInitScript((tl) => { window.TL = tl; }, TL);
await page.goto(`http://localhost:${PORT}/video/v2/production/film.html`);
await page.evaluate(() => window.ready);
await page.waitForTimeout(400);
fs.mkdirSync(HERE + 'clips', { recursive: true }); fs.mkdirSync(HERE + 'stills', { recursive: true });
if (args[0] === '--stills') {
  for (const a of args.slice(1)) { const [id, u] = a.split(':'); await page.evaluate(([id, u]) => window.seekScene(id, u), [id, Number(u)]); await page.screenshot({ path: `${HERE}stills/${id}-${u}.jpg`, type: 'jpeg', quality: 92 }); }
} else {
  const ids = args.length ? args : TL.scenes.filter((s) => s.type === 'card').map((s) => s.id);
  for (const id of ids) {
    const sc = TL.scenes.find((s) => s.id === id); const FPS = 30; const n = Math.round(sc.dur * FPS);
    const ff = spawn('ffmpeg', ['-v', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-r', String(FPS), `${HERE}clips/${id}.mp4`], { stdio: ['pipe', 'inherit', 'inherit'] });
    for (let i = 0; i < n; i++) {
      await page.evaluate(([id, u]) => window.seekScene(id, u), [id, i / FPS]);
      const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    }
    ff.stdin.end(); await new Promise((r) => ff.on('close', r));
    console.log(id, n, 'frames');
  }
}
await b.close(); srv.close();
