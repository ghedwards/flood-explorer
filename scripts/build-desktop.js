// Prepare the datasets at the same relative URLs used by the desktop viewer.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const input = path.join(root, 'viewer/data');
const output = path.join(root, 'site/data');
if (fs.existsSync(input)) fs.cpSync(input, output, { recursive: true });
for (const name of ['gauges-core.min.json', 'storages.geojson', 'readings.json', 'meta.json']) {
  if (!fs.existsSync(path.join(output, 'national', name))) {
    throw new Error(`Missing desktop dataset: national/${name}. Generate viewer/data/national first (see README.md).`);
  }
}
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], {
  cwd: root,
  env: { ...process.env, FLOOD_BROKER_URL: 'http://127.0.0.1:8787', DATA_SOURCE: 'runtime' },
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
if (result.error) throw result.error;
process.exitCode = result.status || 0;
