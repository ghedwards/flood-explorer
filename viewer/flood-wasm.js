/* Flood Explorer: the flood model compiled from Rust (rust/flood-core) to
 * WebAssembly, behind the same API as flood-core.js (FloodCore).
 *
 * In the page and the worker this file loads flood.wasm and swaps the Rust
 * versions of the heavy functions into window.FloodCore once it is ready;
 * until then, if it fails, or with ?engine=js in the address, the
 * JavaScript model runs. Both give the same numbers (tests/parity.js).
 *
 * The module has four exports: flood_alloc, flood_free, flood_run and
 * flood_out_len. flood_run(op, input) takes a "bag" of named arrays and
 * returns one (see rust/flood-wasm/src/lib.rs). Analyses and flood waves
 * stay in the module by handle; an analysis made elsewhere (the worker, or
 * the JavaScript model) is uploaded the first time it is used.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') root.FloodWasm = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TYPES = [Float64Array, Float32Array, Int32Array, Uint8Array, Int16Array, Uint32Array];
  const enc = new TextEncoder(), dec = new TextDecoder();

  /* ------------------------------------------------------------ bags */

  // entries: { name: number | boolean | typed array | array of numbers }
  // (null, undefined and false-y "missing" values are left out by callers)
  function prepare(obj) {
    const list = [];
    let size = 4;
    for (const k of Object.keys(obj)) {
      let v = obj[k];
      if (v == null) continue;
      if (typeof v === 'number' || typeof v === 'boolean') v = new Float64Array([+v]);
      else if (!ArrayBuffer.isView(v)) v = Float64Array.from(v, (x) => (x == null ? NaN : +x));
      let ty = TYPES.findIndex((T) => v instanceof T);
      if (ty < 0) { v = Float64Array.from(v); ty = 0; }
      const name = enc.encode(k);
      list.push({ name, ty, v });
      size += 1 + name.length + 1 + 4 + v.byteLength;
    }
    return { list, size };
  }

  function writeBag(prep, out) {
    const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    dv.setUint32(0, prep.list.length, true);
    let p = 4;
    for (const { name, ty, v } of prep.list) {
      out[p] = name.length; out.set(name, p + 1); p += 1 + name.length;
      out[p] = ty; dv.setUint32(p + 1, v.length, true); p += 5;
      out.set(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), p); p += v.byteLength;
    }
  }

  // u8: a view of the output (it may sit in the module's memory; big bags
  // are copied out of it once, and every aligned field becomes a typed-array
  // view into that buffer — copies only where the field offsets misalign)
  function readBag(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const n = dv.getUint32(0, true), out = {};
    const big = u8.byteLength >= 0x8000 ? u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) : null;
    let p = 4;
    for (let i = 0; i < n; i++) {
      const nl = u8[p], name = dec.decode(u8.subarray(p + 1, p + 1 + nl)); p += 1 + nl;
      const ty = u8[p], len = dv.getUint32(p + 1, true); p += 5;
      const T = TYPES[ty], bytes = len * T.BYTES_PER_ELEMENT;
      if (big) {
        if (p % T.BYTES_PER_ELEMENT === 0) {
          out[name] = new T(big, p, len);
        } else {
          out[name] = new T(big.slice(p, p + bytes));
        }
      } else {
        out[name] = new T(u8.buffer.slice(u8.byteOffset + p, u8.byteOffset + p + bytes));
      }
      p += bytes;
    }
    return out;
  }

  /* --------------------------------------------------------- runners */

  // A runner: (op, entries) => output object. From a WebAssembly instance:
  function wasmRunner(instance) {
    const ex = instance.exports;
    return (op, obj) => {
      const prep = prepare(obj), ob = enc.encode(op);
      const po = ex.flood_alloc(ob.length) >>> 0, pi = ex.flood_alloc(prep.size) >>> 0;
      new Uint8Array(ex.memory.buffer, po, ob.length).set(ob);
      writeBag(prep, new Uint8Array(ex.memory.buffer, pi, prep.size));
      const p = ex.flood_run(po, ob.length, pi, prep.size) >>> 0;
      const out = readBag(new Uint8Array(ex.memory.buffer, p, ex.flood_out_len() >>> 0));
      ex.flood_free(po, ob.length); ex.flood_free(pi, prep.size);
      return out;
    };
  }

  // From the Node test addon (rust/flood-node): run(op, Uint8Array) -> Buffer
  function addonRunner(addon) {
    return (op, obj) => {
      const prep = prepare(obj), buf = new Uint8Array(prep.size);
      writeBag(prep, buf);
      return readBag(addon.run(op, buf));
    };
  }

  /* ---------------------------------------------- the FloodCore API */

  const num = (x) => (x && x.length ? x[0] : NaN);

  function create(runner, J) {
    const call = (op, obj) => {
      const out = runner(op, obj);
      if (out.error) throw new Error('flood model: ' + dec.decode(out.error));
      return out;
    };
    const handles = new WeakMap();
    const waveHandles = new WeakMap();
    const gone = typeof FinalizationRegistry === 'function'
      ? new FinalizationRegistry(({ op, key, h }) => { try { call(op, { [key]: h }); } catch (e) { /* closing */ } })
      : null;

    function handleOf(a) {
      let h = handles.get(a);
      if (h == null) {
        h = num(call('load', {
          W: a.W, H: a.H, cell: a.cell, dem: f32(a.dem), valid: a.valid, ocean: a.ocean, filled: a.filled || null,
          order: a.order, nOrder: a.nOrder, rec: a.rec, acc: a.acc, chain: a.chain, stream: a.stream,
          recvStream: a.recvStream, mainOutlet: a.mainOutlet, defaultGauge: a.defaultGauge,
          streamAreaKm2: a.streamAreaKm2, byPointers: a.routedBy === 'pointers' ? 1 : 0,
        }).handle);
        handles.set(a, h);
        if (gone) gone.register(a, { op: 'drop', key: 'a', h });
      }
      return h;
    }

    const f32 = (v) => (v instanceof Float32Array ? v : Float32Array.from(v));
    const u8 = (v) => (v instanceof Uint8Array ? v : v ? Uint8Array.from(v) : null);

    function scenarioBag(s) {
      const b = {
        gauge: s.gauge != null && s.gauge >= 0 ? s.gauge : -1,
        gaugeLevel: s.gaugeLevel, bayLevel: s.bayLevel, upstreamGradient: s.upstreamGradient,
        gates: s.gates && s.gates.length ? s.gates : null,
        levee: u8(s.levee), wse: s.wse || null,
      };
      if (s.controls && s.controls.length) {
        b.controlCell = s.controls.map((c) => c.cell);
        b.controlLevel = s.controls.map((c) => c.level);
      }
      return b;
    }

    function waveBag(o) {
      o = o || {};
      const b = {
        baseLevel: o.baseLevel, riseHours: o.riseHours, fallHours: o.fallHours, speedKmh: o.speedKmh,
        flatten: o.flatten, route: o.route ? 1 : 0, stepHours: o.stepHours, maxSteps: o.maxSteps,
      };
      if (o.tide) { b.tideAmp = o.tide.amp; b.tideLow = o.tide.atPeak === 'low' ? 1 : 0; }
      if (o.rating) { b.ratingB = o.rating.b; b.ratingDepth = o.rating.depth; }
      if (o.release) { b.releaseStart = o.release.startHours; b.releaseHours = o.release.hours; b.releaseFrac = o.release.frac; }
      if (o.hydro && o.hydro.length) { b.hydroT = o.hydro.map((r) => r[0]); b.hydroV = o.hydro.map((r) => r[1]); }
      if (o.sea && o.sea.length) { b.seaT = o.sea.map((r) => r[0]); b.seaV = o.sea.map((r) => r[1]); }
      if (o.others && o.others.length) {
        const ok = o.others.filter((x) => x && x.hydro);
        b.othersCell = ok.map((x) => (x.cell == null ? -1 : x.cell));
        b.othersLen = ok.map((x) => x.hydro.length);
        b.othersT = [].concat(...ok.map((x) => x.hydro.map((r) => r[0])));
        b.othersV = [].concat(...ok.map((x) => x.hydro.map((r) => r[1])));
      }
      return b;
    }

    // withLevel=false drops level for the ops whose math ignores it (stats,
    // compareRuns); hazard needs it for the velocity slope
    const runBag = (r, p, withLevel) => ({ [p + 'wet']: u8(r.wet), [p + 'depth']: f32(r.depth), [p + 'level']: (withLevel && r.level) ? f32(r.level) : null });

    // slim runs come back without wse/onPath; the profile rebuilds when it
    // needs the waterline
    const toRun = (out, slim) => (slim ? { wet: out.wet, depth: out.depth, level: out.level } : { wet: out.wet, depth: out.depth, level: out.level, wse: out.wse, onPath: out.onPath });

    function analyse(grid, opts) {
      const o = Object.assign({ streamAreaKm2: 4 }, opts || {});
      const out = call('analyse', {
        W: grid.W, H: grid.H, cell: grid.cell, dem: f32(grid.dem), valid: u8(grid.valid),
        inflow: grid.inflow ? f32(grid.inflow) : null, d8: grid.d8 ? Int16Array.from(grid.d8) : null,
        streamAreaKm2: o.streamAreaKm2,
      });
      const a = {
        W: grid.W, H: grid.H, cell: grid.cell, N: num(out.N), dem: grid.dem, valid: grid.valid || out.valid,
        ocean: out.ocean, filled: out.filled, order: out.order, nOrder: num(out.nOrder),
        routedBy: grid.d8 ? 'pointers' : 'priority-flood',
        rec: out.rec, acc: out.acc, chain: out.chain, stream: out.stream, recvStream: out.recvStream,
        mainOutlet: num(out.mainOutlet), streamAreaKm2: o.streamAreaKm2,
      };
      a.defaultGauge = num(out.defaultGauge);
      const h = num(out.handle);
      handles.set(a, h);
      if (gone) gone.register(a, { op: 'drop', key: 'a', h });
      return a;
    }

    function streamSurface(a, s) {
      const out = call('streamSurface', Object.assign({ a: handleOf(a) }, scenarioBag(s)));
      return { wse: out.wse, onPath: out.onPath };
    }

    function inundate(a, s, opts) {
      const slim = opts && opts.slim ? 1 : null;
      const r = toRun(call('inundate', Object.assign({ a: handleOf(a) }, scenarioBag(s), slim ? { slim } : null)), Boolean(slim));
      if (s.wse) r.wse = s.wse;
      return r;
    }

    function flashFlood(a, o) {
      o = o || {};
      const out = call('flashFlood', {
        a: handleOf(a), rainMm: o.rainMm, hours: o.hours, initialLoss: o.initialLoss, contLoss: o.contLoss,
        nChannel: o.nChannel, nOverland: o.nOverland, maxRise: o.maxRise, maxPondDepth: o.maxPondDepth,
        pipeMmH: o.pipeMmH, urban: u8(o.urban),
      }, Object.assign({ a: handleOf(a) }, o.slim ? { slim: 1 } : null));
      return {
        wet: out.wet, depth: out.depth, level: out.level, kind: out.kind, wse: out.wse ? Float32Array.from(out.wse) : undefined,
        summary: {
          excessMm: num(out.excessMm), runoffCoeff: num(out.runoffCoeff), creekKm2: num(out.creekKm2),
          overlandKm2: num(out.overlandKm2), pondKm2: num(out.pondKm2), maxCreekRise: num(out.maxCreekRise),
          pipedMm: num(out.pipedMm), urbanKm2: num(out.urbanKm2),
        },
      };
    }

    function stats(a, run, base) {
      const out = call('stats', Object.assign({ a: handleOf(a) }, runBag(run, ''), base ? runBag(base, 'base') : {}));      return {
        wetLandKm2: num(out.wetLandKm2), floodedKm2: num(out.floodedKm2), deepKm2: num(out.deepKm2),
        maxDepth: num(out.maxDepth), rawMaxDepth: num(out.rawMaxDepth), meanDepth: num(out.meanDepth),
      };
    }

    function hazard(a, run) {
      const out = call('hazard', Object.assign({ a: handleOf(a) }, runBag(run, '', true)));
      return { cls: out.cls, vel: out.vel, km2: Array.from(out.km2) };
    }

    function compareRuns(a, now, pinned) {
      const out = call('compareRuns', Object.assign({ a: handleOf(a) }, runBag(now, ''), runBag(pinned, 'pin')));
      return {
        diff: out.diff, dDepth: out.dDepth,
        km2: { both: num(out.both), onlyNow: num(out.onlyNow), onlyPinned: num(out.onlyPinned) },
        deeperKm2: num(out.deeperKm2), shallowerKm2: num(out.shallowerKm2),
      };
    }

    function waveSetup(a, s, o) {
      o = o || {};
      const out = call('waveSetup', Object.assign({ a: handleOf(a) }, scenarioBag(s), waveBag(o)));
      const h = num(out.handle);
      const at1 = (kind, band) => (t) => num(call('waveAt', { w: h, kind, band, t: [t] }).v);
      const gaugeAt = at1(0, 0);
      const nb = num(out.bands);
      const w = {
        lo: num(out.lo), hi: num(out.hi), w0: out.w0, w1: out.w1, cells: out.cells, arrive: out.arrive,
        minA: num(out.minA), maxA: num(out.maxA), rise: num(out.rise), fall: num(out.fall),
        gaugeAt, at: Array.from({ length: nb }, (_, b) => (b ? at1(2, b) : gaugeAt)), band: out.band,
        tStart: num(out.tStart), tEnd: num(out.tEnd), tPeak: num(out.tPeak), routed: null,
        release: out.releaseFrac ? { frac: num(out.releaseFrac), peakWith: num(out.releasePeakWith), rise: num(out.releaseRise) } : null,
        bayAt: at1(1, 0), tide: num(out.tide),
        seaRecorded: out.seaLo ? { lo: num(out.seaLo), hi: num(out.seaHi) } : null,
      };
      if (out.upGauges) {
        const others = (o.others || []).filter((x) => x && x.hydro);
        w.up = {
          gauges: num(out.upGauges), below: num(out.upBelow), base: num(out.upBase), rng: num(out.upRng),
          k1: out.upK1, k2: out.upK2, names: Array.from(out.upUsed, (i) => others[i].name || ''),
        };
      }
      if (out.rT0) {
        const nT = num(out.rNT), T0 = num(out.rT0), dt = num(out.rDt), Q = out.rQ;
        const flows = Array.from(out.rFlowK, (k, i) => (i
          ? { k, Q: Q.subarray(i * nT, (i + 1) * nT), ref: out.rFlowRef[i], K: out.rFlowKK[i], X: out.rFlowX[i] }
          : { k, Q: Q.subarray(0, nT), ref: out.rFlowRef[0] }));
        w.routed = {
          T0, dt, nT, flows, cellA: out.rCellA, cellF: out.rCellF, qPk: num(out.rQPk), exponent: num(out.rExponent),
          rated: num(out.rRated) === 1,
          reaches: Array.from(out.rReachKm, (km, i) => ({ km, K: out.rReachK[i], X: out.rReachX[i] })),
          tributaries: num(out.rTributaries), extraHours: num(out.rExtraHours),
          peakAt(n) { const f = flows[n]; let m = 0, im = 0; for (let i = 0; i < nT; i++) if (f.Q[i] / f.ref > m) { m = f.Q[i] / f.ref; im = i; } return { frac: m, hours: T0 + im * dt }; },
        };
      }
      waveHandles.set(w, h);
      if (gone) gone.register(w, { op: 'dropWave', key: 'w', h });
      return w;
    }

    function waveSurface(a, w, t, out) {
      const h = waveHandles.get(w);
      if (h == null) return J.waveSurface(a, w, t, out);
      const v = call('waveSurface', { w: h, t }).v;
      const wse = out || new Float64Array(a.N).fill(NaN);
      const cells = w.cells;
      for (let i = 0; i < cells.length; i++) wse[cells[i]] = v[i];
      return wse;
    }

    function floodTimeline(a, s, o) {
      const out = call('floodTimeline', Object.assign({ a: handleOf(a) }, scenarioBag(s), waveBag(o)));
      return {
        t0: num(out.t0), step: num(out.step), steps: num(out.steps),
        firstWet: out.firstWet, lastWet: out.lastWet, firstDeep: out.firstDeep, lastDeep: out.lastDeep,
        wetCount: out.wetCount, gauge: out.gauge, wordsPerStep: num(out.wordsPerStep),
        wetBits: out.wetBits, deepBits: out.deepBits,
      };
    }

    function burnDefences(grid, opts) {
      const lv = (opts && opts.levees) || [];
      if (!lv.length) return Object.assign({}, grid, { dem: Float32Array.from(grid.dem) });
      const out = call('burnDefences', {
        W: grid.W, H: grid.H, cell: grid.cell, dem: f32(grid.dem), leveeCount: lv.length,
        leveeCells: [].concat(...lv.map((l) => Array.from(l.cells || []))),
        leveeCellLen: lv.map((l) => (l.cells || []).length),
        leveeHeight: lv.map((l) => (l.height == null ? NaN : l.height)),
        leveeFailed: lv.map((l) => (l.failed ? 1 : 0)),
        leveeBreaches: [].concat(...lv.map((l) => Array.from(l.breaches || []))),
        leveeBreachLen: lv.map((l) => (l.breaches || []).length),
        leveeBreachWidth: lv.map((l) => (l.breachWidth == null ? NaN : l.breachWidth)),
      });
      return Object.assign({}, grid, { dem: out.dem });
    }

    function parseSimpleTiff(buf) {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer || buf, buf.byteOffset || 0, buf.byteLength);
      const out = call('parseSimpleTiff', { bytes });
      return { W: num(out.W), H: num(out.H), data: out.data, nodata: num(out.nodata), bounds: out.bounds ? Array.from(out.bounds) : null };
    }

    const rust = {
      inertialStart: (grid, opts) => call('inertialStart', { ...grid, ...opts }),
      inertialStep: () => { const o = call('inertialStep', {}); return { depth: o.depth, vx: o.vx, vy: o.vy, ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== 'depth' && k !== 'vx' && k !== 'vy').map(([k, v]) => [k, num(v)])) }; },
      inertialVelocities: () => { const o = call('inertialVelocities', {}); return { vx: o.vx, vy: o.vy }; },
      analyse, streamSurface, inundate, flashFlood, stats, hazard, compareRuns,
      waveSetup, waveSurface, floodTimeline, burnDefences, parseSimpleTiff,
    };
    return Object.assign({}, J, rust, { engine: 'rust', rustFunctions: Object.keys(rust) });
  }

  /* ------------------------------------------------- loading it live */

  async function instantiate(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const { instance } = WebAssembly.instantiateStreaming && /wasm/.test(res.headers.get('content-type') || '')
      ? await WebAssembly.instantiateStreaming(res, {})
      : await WebAssembly.instantiate(await res.arrayBuffer(), {});
    return instance;
  }

  // Swap the Rust functions into an existing FloodCore object once the
  // module loads; any call that throws falls back to the JavaScript model.
  function install(target, url) {
    const J = Object.assign({}, target);
    target.engine = 'js';
    const off = typeof location !== 'undefined' && /[?&]engine=js\b/.test(location.search || '');
    if (off || typeof WebAssembly !== 'object') return Promise.resolve(target);
    return instantiate(url || 'flood.wasm').then((inst) => {
      const core = create(wasmRunner(inst), J);
      for (const k of core.rustFunctions) {
        target[k] = function () {
          try { return core[k].apply(null, arguments); } catch (e) {
            if (!J[k]) throw e; // Rust-only solvers must never silently change physics.
            if (typeof console !== 'undefined') console.warn(`Rust ${k} failed, using JavaScript:`, e);
            return J[k].apply(null, arguments);
          }
        };
      }
      target.engine = 'rust';
      return target;
    }).catch((e) => {
      target.engine = 'error';
      if (typeof console !== 'undefined') console.error('WebAssembly flood model failed to load:', e);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        try { window.dispatchEvent(new CustomEvent('flood:wasm-error', { detail: { error: String(e) } })); } catch (err) { if (console) console.warn(err); }
      }
      return target;
    });
  }

  return { create, wasmRunner, addonRunner, install, prepare, writeBag, readBag };
});

// In the page or worker, swap in the Rust model behind FloodCore.
if (typeof self !== 'undefined' && self.FloodCore && self.FloodWasm) {
  self.FloodCoreReady = self.FloodWasm.install(self.FloodCore, self.FloodWasmURL);
}
