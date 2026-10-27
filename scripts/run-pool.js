// Run several wave series through the local model at once, one per worker thread.
//
// Each worker loads its own copy of the WASM model, so memory grows with the pool size
// (a few tens of MB each). Runs are independent and deterministic, so the results do not
// depend on the pool size or on which worker ran what.
'use strict';
const path = require('node:path');
const os = require('node:os');
const { Worker } = require('node:worker_threads');

function defaultJobs() {
  return Math.max(1, Math.min(os.availableParallelism(), 8));
}

// `run(csv, seconds, options)` queues one run and resolves with runSeries's result.
// Close the pool when done, or the process will not exit.
function createPool(size = defaultJobs()) {
  if (!Number.isInteger(size) || size < 1 || size > 32) throw new Error('The pool size is a whole number from 1 to 32.');
  const idle = [], queue = [], pending = new Map();
  let nextId = 1, closed = false;
  const workers = Array.from({ length: size }, () => {
    const worker = new Worker(path.join(__dirname, 'run-series-worker.js'));
    worker.on('message', ({ id, result, error }) => {
      const job = pending.get(id);
      pending.delete(id);
      if (error) job.reject(new Error(error)); else job.resolve(result);
      idle.push(worker);
      next();
    });
    worker.on('error', error => {
      for (const job of pending.values()) job.reject(error);
      pending.clear();
    });
    idle.push(worker);
    return worker;
  });
  function next() {
    while (idle.length && queue.length) {
      const worker = idle.pop(), job = queue.shift();
      pending.set(job.id, job);
      worker.postMessage({ id: job.id, csv: job.csv, seconds: job.seconds, options: job.options });
    }
  }
  return {
    size,
    run(csv, seconds = 3600, options = {}) {
      if (closed) return Promise.reject(new Error('The pool is closed.'));
      return new Promise((resolve, reject) => { queue.push({ id: nextId++, csv, seconds, options, resolve, reject }); next(); });
    },
    async close() { closed = true; await Promise.all(workers.map(w => w.terminate())); },
  };
}

// Map `items` through `fn` with at most `limit` calls in flight; results keep the input order.
async function mapLimit(items, limit, fn) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('The concurrency limit is a whole number from 1.');
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => { while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
}

module.exports = { createPool, defaultJobs, mapLimit };
