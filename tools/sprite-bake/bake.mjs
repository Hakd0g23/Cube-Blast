// Fracture — Style C sprite-atlas bake driver. Not part of the shipped
// runtime bundle (lives under tools/, like the other project scripts).
// Renders tools/sprite-bake/bake.html headlessly (Playwright/Chromium) and
// writes the resulting PNG atlas to assets/sprites/shard-atlas.png.
//
// Usage: node tools/sprite-bake/bake.mjs
// Requires a Playwright Chromium install reachable on NODE_PATH (see repo
// verification notes) -- same headless-canvas/Playwright-screenshot
// technique already used to verify Style B and Style A.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../..');
const outPath = path.join(repoRoot, 'assets/sprites/shard-atlas.png');

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png' };

function startServer(root) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://localhost');
        let filePath = path.join(root, decodeURIComponent(url.pathname));
        if (!existsSync(filePath)) { res.writeHead(404); res.end(); return; }
        const ext = path.extname(filePath);
        const body = await readFile(filePath);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        res.end(body);
      } catch (e) {
        res.writeHead(500); res.end(String(e));
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const server = await startServer(repoRoot);
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => console.log('[page]', m.text()));
page.on('pageerror', (e) => console.error('[pageerror]', e));

await page.goto(`http://127.0.0.1:${port}/tools/sprite-bake/bake.html`);
await page.waitForFunction(() => window.__atlasReady === true, null, { timeout: 30000 });
const dataURL = await page.evaluate(() => window.__atlasDataURL);
const meta = await page.evaluate(() => window.__atlasMeta);

await browser.close();
server.close();

const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, Buffer.from(base64, 'base64'));

console.log('Wrote', outPath, meta);
