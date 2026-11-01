// Prove that the real screenshot runner fails if the flood overlay disappears.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const result = spawnSync(process.execPath, [path.join(__dirname, 'visual-browser.js'), '--hide-flood'], {
  encoding: 'utf8', timeout: 120000,
});
const output = (result.stdout || '') + (result.stderr || '');
assert.equal(result.error, undefined, `The regression proof did not complete: ${result.error}`);
assert.notEqual(result.status, 0, 'Hiding the flood overlay must fail the normal visual test');
assert.match(output, /river-depth: [\d.]+% of pixels changed/, `Expected an image mismatch, not an unrelated failure:\n${output}`);
assert.ok(fs.existsSync(path.resolve('test-results/visual-regression-proof/river-depth.diff.png')));
console.log('Intentional missing flood overlay was rejected; actual/expected/diff images retained.');
