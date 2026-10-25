const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { collect, manifest, TARGETS } = require('../scripts/desktop-release.js');

async function ui(invoke, desktop = true) {
  const source = fs.readFileSync(path.join(__dirname, '../viewer/desktop-updates.js'), 'utf8');
  const { desktopUpdates } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  const elements = Object.fromEntries(['desktopUpdates', 'updateStatus', 'updateNotes', 'updateCheck', 'updateInstall', 'settingsModal'].map(id => [id, { hidden: true, disabled: false, textContent: '', addEventListener() {} }]));
  const controller = desktopUpdates({ invoke, desktop, document: { getElementById: id => elements[id] } });
  if (controller) await controller.ready;
  return { controller, elements };
}

test('web viewer never checks native updates', async () => {
  const { controller, elements } = await ui(() => assert.fail('unexpected native command'), false);
  assert.equal(controller, null);
  assert.equal(elements.desktopUpdates.hidden, true);
});
test('startup check offers a newer version but installs only on explicit action', async () => {
  const calls = [];
  const { controller, elements } = await ui(async (command, args) => {
    calls.push({ command, args });
    return { currentVersion: '0.2.0', version: '0.3.0', notes: '<img src=x onerror=alert(1)>' };
  });
  assert.deepEqual(calls.map(c => c.command), ['check_for_update']);
  assert.equal(elements.updateInstall.hidden, false);
  assert.equal(elements.settingsModal.hidden, false);
  assert.equal(elements.updateNotes.textContent, '<img src=x onerror=alert(1)>');
  await controller.installNow();
  assert.deepEqual(calls[1], { command: 'install_update', args: { version: '0.3.0' } });
});
test('offline check is recoverable and does not open Settings', async () => {
  let online = false;
  const { controller, elements } = await ui(async () => {
    if (!online) throw new Error('Offline');
    return { currentVersion: '0.2.0', version: null };
  });
  assert.match(elements.updateStatus.textContent, /Offline/);
  assert.equal(elements.settingsModal.hidden, true);
  assert.equal(elements.updateCheck.disabled, false);
  online = true;
  await controller.checkNow();
  assert.match(elements.updateStatus.textContent, /0.2.0 is up to date/);
});
test('duplicate operations are ignored and failed installation requires a fresh check', async () => {
  let finish, installs = 0;
  const { controller, elements } = await ui(async command => {
    if (command === 'check_for_update') return { currentVersion: '0.2.0', version: '0.3.0' };
    installs++;
    await new Promise(resolve => { finish = resolve; });
    throw new Error('Invalid signature');
  });
  const installing = controller.installNow();
  await controller.installNow();
  await controller.checkNow();
  assert.equal(installs, 1);
  assert.equal(elements.updateInstall.disabled, true);
  finish();
  await installing;
  assert.match(elements.updateStatus.textContent, /Invalid signature/);
  assert.equal(elements.updateInstall.hidden, true);
  await controller.installNow();
  assert.equal(installs, 1);
});
test('release feed includes exactly four signed platform bundles with unique names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flood-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const inputs = path.join(root, 'inputs'), output = path.join(root, 'release');
  fs.mkdirSync(output);
  for (const [target, [platform, suffix]] of Object.entries(TARGETS)) {
    const bundle = path.join(root, target);
    fs.mkdirSync(bundle);
    const artifact = path.join(bundle, `Flood Explorer${suffix}`);
    fs.writeFileSync(artifact, platform);
    fs.writeFileSync(`${artifact}.sig`, `signature-${platform}\n`);
    collect(target, bundle, path.join(inputs, target, 'update-assets'));
  }
  const feed = manifest(inputs, output, '0.2.0', 'Release notes', '2026-10-25T00:00:00Z');
  assert.equal(feed.version, '0.2.0');
  assert.equal(Object.keys(feed.platforms).length, 4);
  for (const [platform, update] of Object.entries(feed.platforms)) {
    assert.equal(update.signature, `signature-${platform}`);
    assert.match(update.url, /^https:\/\/github.com\/ghedwards\/flood-explorer\/releases\/download\/desktop-v0.2.0\//);
    assert.equal(fs.readFileSync(path.join(output, path.basename(update.url)), 'utf8'), platform);
  }
  fs.unlinkSync(path.join(inputs, 'aarch64-apple-darwin/update-assets/darwin-aarch64.json'));
  assert.throws(() => manifest(inputs, output, '0.2.0', ''), /darwin-aarch64/);
});
test('unsigned bundles and mismatched metadata cannot be collected or published', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flood-unsigned-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'test.AppImage'), 'bundle');
  assert.throws(() => collect('x86_64-unknown-linux-gnu', root, path.join(root, 'output')), /ENOENT/);
  fs.writeFileSync(path.join(root, 'test.AppImage.sig'), '');
  assert.throws(() => collect('x86_64-unknown-linux-gnu', root, path.join(root, 'output')), /Missing signature/);
});
