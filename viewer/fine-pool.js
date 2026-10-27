/* The 5 m flood picture, worked out by several workers at once: the rows are split into bands,
 * each worker draws one band (fine-raster.js, rowFrom/rowTo), and the bands are joined. The
 * result is the same picture one worker (or the main thread) would draw, byte for byte.
 *
 * Workers are made by `makeWorker` (a module Worker running fine-worker.js in the page), so the
 * pool can be tested with stand-ins. If any worker fails, or throws, the picture is drawn by
 * `fallback` (the main thread) instead and the pool stops using workers.
 *
 * Splitting only pays for big pictures: in Chromium a 1800 x 1800 picture took 243 ms in one worker,
 * 126 ms in two and 85 ms in four, while a 1000 x 1000 one (79 ms in one) was no faster in three
 * (the data has to be posted to each worker). So pictures under `minPixels` go to one worker. */

/* Row bands [from, to) covering 0..H: at most `workers` of them, none thinner than `minRows`. */
export function planBands(H, workers, minRows = 200) {
  const n = Math.max(1, Math.min(Math.floor(workers) || 1, Math.floor(H / minRows)));
  return Array.from({ length: n }, (_, i) => [Math.floor((i * H) / n), Math.floor(((i + 1) * H) / n)]);
}

/* The parameters for one band: only that band's LiDAR rows are copied (a typed-array view would
 * send its whole buffer to the worker). The whole picture keeps its own parameters. */
export function bandParams(p, from, to) {
  if (from === 0 && to === p.H) return p;
  return { ...p, rowFrom: from, rowTo: to, lidar: p.lidar.slice(from * p.W, to * p.W) };
}

/* Join bands (in row order) into one picture of W x H pixels. */
export function stitch(parts, W, H) {
  const rgba = new Uint8ClampedArray(W * H * 4);
  let at = 0, have = 0;
  for (const part of parts) {
    if (at + part.rgba.length > rgba.length) throw new Error('the bands are taller than the picture');
    rgba.set(part.rgba, at);
    at += part.rgba.length;
    have += part.have;
  }
  if (at !== rgba.length) throw new Error('the bands do not cover the picture');
  return { rgba, have };
}

export function createFinePool({ makeWorker, size = 1, minRows = 200, minPixels = 1.5e6, fallback, onProblem = () => {} }) {
  let workers = [], ok = typeof makeWorker === 'function' && size > 0, nextId = 0;
  const waiting = new Map();
  function failAll(message) {
    ok = false;
    for (const w of workers) { try { w.terminate(); } catch (e) { /* already gone */ } }
    workers = [];
    for (const job of waiting.values()) job.reject(new Error(message));
    waiting.clear();
  }
  function spawn() {
    const worker = makeWorker();
    worker.onmessage = (e) => {
      const job = waiting.get(e.data.id);
      if (!job) return;
      waiting.delete(e.data.id);
      if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve({ rgba: e.data.rgba, have: e.data.have });
    };
    worker.onerror = (ev) => {
      onProblem(`5 m flood worker failed: ${(ev && ev.message) || 'unknown error'} (drawing on the main thread instead)`);
      failAll('worker failed');
    };
    return worker;
  }
  return {
    compute(p) {
      if (!ok) return Promise.resolve(fallback(p));
      try {
        const bands = p.W * p.H < minPixels ? [[0, p.H]] : planBands(p.H, size, minRows);
        while (workers.length < bands.length) workers.push(spawn());
        const jobs = bands.map(([from, to], i) => new Promise((resolve, reject) => {
          const id = ++nextId;
          waiting.set(id, { resolve, reject });
          workers[i].postMessage({ id, p: bandParams(p, from, to) });
        }));
        return Promise.all(jobs).then((parts) => ({ ...stitch(parts, p.W, p.H), worker: true })).catch(() => fallback(p));
      } catch (err) {
        failAll(String(err));
        return Promise.resolve(fallback(p));
      }
    },
    get workers() { return workers.length; },
    close() { failAll('closed'); },
  };
}
