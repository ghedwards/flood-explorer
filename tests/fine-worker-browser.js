// The built 5 m picture worker, in a real browser: it must load the Rust module (module workers
// and the bundled flood.wasm), and its picture must match the JavaScript one byte for byte.
//
//   npm run build && node tests/fine-worker-browser.js
//
// Needs Playwright's Chromium (npx playwright install chromium). Serves the built site/ itself.
const { chromium } = require('playwright');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../site');

const { scene } = require('./fine-scene.js');

// Typed arrays travel to the page as base64 and are rebuilt there.
const pack = (p) => JSON.parse(JSON.stringify(p, (k, v) => {
  if (ArrayBuffer.isView(v)) return { __typed: v.constructor.name, b64: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  if (typeof v === 'number' && !Number.isFinite(v)) return { __num: String(v) };
  return v;
}));

// The newest bundle's worker asset (older builds leave stale chunks behind).
function currentWorker() {
  const mains = fs.readdirSync(path.join(root, 'assets')).filter((f) => /^main-.*\.js$/.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(root, 'assets', f)).mtimeMs })).sort((a, b) => b.t - a.t);
  for (const { f } of mains) {
    const m = /fine-worker-[A-Za-z0-9_-]+\.js/.exec(fs.readFileSync(path.join(root, 'assets', f), 'utf8'));
    if (m) return m[0];
  }
  throw new Error('no fine-worker asset is referenced by the built page; run npm run build');
}

async function main() {
  const { fineWindow, cropGrid } = await import('../viewer/fine-raster.js'), { fineRaster } = require('./fine-raster-reference.js');
  const { bandParams, stitch } = await import('../viewer/fine-pool.js');
  const server = http.createServer((req, res) => {
    const file = path.resolve(root, '.' + new URL(req.url, 'http://localhost').pathname.replace(/\/$/, '/index.html'));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) { res.writeHead(404).end(); return; }
    const types = { '.js': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' };
    res.setHeader('content-type', types[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // a blank page on the site's origin; the worker is what is under test
    await context.route('**/blank.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>blank</title>' }));
    await page.goto(`${base}/blank.html`);
    const asset = currentWorker();
    // Several real workers at once, each sent one set of parameters; the replies come back in order.
    const drawIn = (jobs) => page.evaluate(async ({ asset, packed }) => {
      const revive = (v) => {
        if (Array.isArray(v)) return v.map(revive);
        if (v && typeof v === 'object') {
          if (v.__typed) { const b = Uint8Array.from(atob(v.b64), (c) => c.charCodeAt(0)); return new self[v.__typed](b.buffer); }
          if (v.__num) return Number(v.__num);
          return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
        }
        return v;
      };
      return Promise.all(packed.map(async (job) => {
        const worker = new Worker(`/assets/${asset}`, { type: 'module' });
        const reply = await new Promise((resolve, reject) => {
          worker.onmessage = (e) => resolve(e.data);
          worker.onerror = (e) => reject(new Error(e.message || 'worker error'));
          worker.postMessage({ id: 1, p: revive(job) });
        });
        worker.terminate();
        if (reply.error) return { error: reply.error };
        let s = ''; const bytes = new Uint8Array(reply.rgba.buffer);
        for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return { b64: btoa(s), have: reply.have, engine: reply.engine };
      }));
    }, { asset, packed: jobs.map(pack) });
    const bytesOf = (r) => { assert.ok(!r.error, `worker error: ${r.error}`); assert.equal(r.engine, 'rust', 'the worker should be running the Rust module'); return new Uint8ClampedArray(Buffer.from(r.b64, 'base64')); };

    let seed = 1, compared = 0;
    for (const hazard of [false, true]) for (const baseline of [false, true]) for (const level of [false, true]) {
      const p = scene(seed++, { fineWindow, cropGrid }, { hazard, baseline, level, window: seed % 2 === 0 });
      const expected = fineRaster(p);
      const [got] = await drawIn([p]);
      assert.equal(got.have, expected.have);
      assert.ok(Buffer.from(bytesOf(got)).equals(Buffer.from(expected.rgba.buffer, expected.rgba.byteOffset, expected.rgba.length)),
        `picture differs for hazard=${hazard} baseline=${baseline} level=${level}`);
      compared++;
    }

    // The same pictures drawn as three bands by three workers at once, then joined.
    let banded = 0;
    for (const [hazard, baseline] of [[false, false], [true, true], [true, false]]) {
      const p = scene(seed++, { fineWindow, cropGrid }, { hazard, baseline, level: baseline, window: true });
      const cuts = [[0, 23], [23, 46], [46, 70]];
      const replies = await drawIn(cuts.map(([from, to]) => bandParams(p, from, to)));
      const joined = stitch(replies.map((r) => ({ rgba: bytesOf(r), have: r.have })), p.W, p.H);
      const expected = fineRaster(p);
      assert.equal(joined.have, expected.have);
      assert.ok(Buffer.from(joined.rgba.buffer).equals(Buffer.from(expected.rgba.buffer, expected.rgba.byteOffset, expected.rgba.length)), `bands differ for hazard=${hazard} baseline=${baseline}`);
      banded++;
    }
    assert.deepEqual(errors, []);
    console.log(`fine worker ${asset}: ${compared} pictures and ${banded} three-worker banded pictures identical to the JavaScript reference, engine rust`);
  } finally {
    if (browser) await browser.close();
    server.close();
  }
}

main().catch((error) => { console.error(error); process.exit(1); });
