// A worker thread that runs wave series through the local model (see run-pool.js).
'use strict';
const { parentPort } = require('node:worker_threads');
const { runSeries } = require('./run-series-local.js');

parentPort.on('message', async ({ id, csv, seconds, options }) => {
  try {
    const { parseSeriesCsv } = await import('../viewer/tsunami-coupling.js');
    parentPort.postMessage({ id, result: await runSeries(parseSeriesCsv(csv), seconds, options) });
  } catch (error) {
    parentPort.postMessage({ id, error: error.message });
  }
});
