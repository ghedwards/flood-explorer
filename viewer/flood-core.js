/*
 * Flood Explorer: the global `FloodCore` object. The flood model and every helper around it live in Rust
 * (rust/flood-core), compiled to WebAssembly and installed into this object by flood-wasm.js; there is no
 * JavaScript copy of any of it, and without WebAssembly the app refuses to run (see app.js's gate).
 * What is left here is the binary heap the road routing uses.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') root.FloodCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function MinHeap(cap) {
    this.k = new Float64Array(cap);
    this.v = new Int32Array(cap);
    this.n = 0;
  }
  MinHeap.prototype.push = function (key, val) {
    let i = this.n++;
    const k = this.k, v = this.v;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  };
  MinHeap.prototype.pop = function () {
    const k = this.k, v = this.v;
    const top = v[0];
    const lk = k[--this.n], lv = v[this.n];
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.n) break;
      if (c + 1 < this.n && k[c + 1] < k[c]) c++;
      if (k[c] >= lk) break;
      k[i] = k[c]; v[i] = v[c]; i = c;
    }
    k[i] = lk; v[i] = lv;
    return top;
  };

  return { _internal: { MinHeap } };
});
