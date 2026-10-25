const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { chromium } = require('playwright');

test('canvas uploads preserve RGBA bytes received through a worker-style transfer', async () => {
  const source = fs.readFileSync(require.resolve('../../viewer/app.js'), 'utf8');
  const start = source.indexOf('  function canvasPixels(');
  const helper = source.slice(start, source.indexOf('\n  }', start) + 4);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: helper });
    const result = await page.evaluate(async () => {
      const channel = new MessageChannel();
      const received = new Promise(resolve => { channel.port2.onmessage = e => resolve(e.data); });
      const bytes = new Uint8Array([0, 0, 10, 20, 30, 255, 0]);
      channel.port1.postMessage(bytes.subarray(2, 6), [bytes.buffer]);
      const pixels = await received;
      channel.port1.close(); channel.port2.close();
      const ctx = document.createElement('canvas').getContext('2d');
      const inputs = [pixels, new ImageData(new Uint8ClampedArray(pixels), 1, 1)];
      return inputs.map(input => {
        const img = window.canvasPixels(ctx, input, 1, 1);
        ctx.putImageData(img, 0, 0);
        return Array.from(ctx.getImageData(0, 0, 1, 1).data);
      });
    });
    assert.deepEqual(result, [[10, 20, 30, 255], [10, 20, 30, 255]]);
  } finally { await browser.close(); }
});
