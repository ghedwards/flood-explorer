// The flood model under test. FLOOD_IMPL picks the engine:
//   wasm (default) the Rust model compiled to WebAssembly (FLOOD_WASM,
//                  default viewer/flood.wasm — build it first with
//                  `node scripts/build-wasm.js`)
//   native         the Rust model as a Node addon (FLOOD_NODE_ADDON), for
//                  machines without the wasm32 target
// There is no JavaScript engine any more: the browser refuses to run
// without WebAssembly, and so do these tests.
const path = require('path');
const fs = require('fs');
const W = require('../viewer/flood-wasm.js');

const impl = process.env.FLOOD_IMPL || 'wasm';
let F;
if (impl === 'wasm') {
  const file = process.env.FLOOD_WASM || path.join(__dirname, '../viewer/flood.wasm');
  if (!fs.existsSync(file)) {
    throw new Error(`No flood.wasm at ${file} — run 'node scripts/build-wasm.js' first (needs the rust toolchain).`);
  }
  const instance = new WebAssembly.Instance(new WebAssembly.Module(fs.readFileSync(file)), {});
  F = W.create(W.wasmRunner(instance));
} else if (impl === 'native') {
  F = W.create(W.addonRunner(require(path.resolve(process.env.FLOOD_NODE_ADDON))));
} else throw new Error(`unknown FLOOD_IMPL ${impl}`);
// the viewer's grid builders (viewer/tsunami-grid.js) find the wave model here, as they find it on the page
globalThis.FloodCore = F;
module.exports = F;
