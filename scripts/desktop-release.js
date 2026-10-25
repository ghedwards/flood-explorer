// Package signed updater assets without architecture filename collisions.
const fs = require('node:fs');
const path = require('node:path');
const TARGETS = {
  'aarch64-apple-darwin': ['darwin-aarch64', '.app.tar.gz'],
  'x86_64-apple-darwin': ['darwin-x86_64', '.app.tar.gz'],
  'x86_64-pc-windows-msvc': ['windows-x86_64', '-setup.exe'],
  'x86_64-unknown-linux-gnu': ['linux-x86_64', '.AppImage'],
};
function files(root) {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function collect(target, root, output) {
  const spec = TARGETS[target];
  if (!spec) throw new Error(`Unsupported desktop target: ${target}`);
  const [platform, suffix] = spec;
  const candidates = files(root).filter(file => file.endsWith(suffix));
  if (candidates.length !== 1) throw new Error(`Expected one ${suffix} updater artifact for ${target}`);
  const artifact = candidates[0];
  const signature = fs.readFileSync(`${artifact}.sig`, 'utf8').trim();
  if (!signature) throw new Error(`Missing signature for ${target}`);
  fs.mkdirSync(output, { recursive: true });
  const name = `update-${platform}${suffix}`;
  fs.copyFileSync(artifact, path.join(output, name));
  fs.copyFileSync(`${artifact}.sig`, path.join(output, `${name}.sig`));
  fs.writeFileSync(path.join(output, `${platform}.json`), JSON.stringify({ platform, name, signature }));
}
function manifest(root, output, version, notes, date = new Date().toISOString()) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid release version');
  const platforms = {};
  for (const [platform] of Object.values(TARGETS)) {
    const parts = files(root).filter(file => path.basename(file) === `${platform}.json`);
    if (parts.length !== 1) throw new Error(`Expected exactly one metadata file for ${platform}`);
    const part = JSON.parse(fs.readFileSync(parts[0], 'utf8'));
    const directory = path.dirname(parts[0]);
    // Do not let metadata publish an unexpected path or a different signature.
    const spec = Object.values(TARGETS).find(([name]) => name === platform);
    if (part.platform !== platform || part.name !== `update-${platform}${spec[1]}` || !part.signature) throw new Error(`Invalid metadata for ${platform}`);
    if (fs.readFileSync(path.join(directory, `${part.name}.sig`), 'utf8').trim() !== part.signature) throw new Error(`Signature mismatch for ${platform}`);
    for (const name of [part.name, `${part.name}.sig`]) fs.copyFileSync(path.join(directory, name), path.join(output, name));
    platforms[platform] = { url: `https://github.com/ghedwards/flood-explorer/releases/download/desktop-v${version}/${encodeURIComponent(part.name)}`, signature: part.signature };
  }
  const result = { version, notes, pub_date: date, platforms };
  fs.writeFileSync(path.join(output, 'latest.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}
if (require.main === module) {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'collect') collect(...args);
  else if (command === 'manifest') {
    const [root, output] = args;
    const version = JSON.parse(fs.readFileSync('desktop/tauri.conf.json', 'utf8')).version;
    manifest(root, output, version, fs.readFileSync('desktop/RELEASE_NOTES.md', 'utf8'));
  } else throw new Error('Expected collect or manifest');
}
module.exports = { collect, manifest, TARGETS };
