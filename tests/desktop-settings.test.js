const test = require('node:test');
const assert = require('node:assert/strict');

async function setup(invoke, desktop = true) {
  const { desktopSettings } = await import('../viewer/desktop-settings.js');
  const elements = Object.fromEntries(['settingsModal', 'settingsBtn', 'setQldKey', 'setNswKey', 'settingsSave', 'settingsClose', 'settingsStatus'].map(id => [id, {
    hidden: true, disabled: false, value: '', textContent: '',
    addEventListener() {}, focus() {}, querySelectorAll() { return []; },
  }]));
  const controller = desktopSettings({ invoke, desktop, document: { getElementById: id => elements[id] } });
  return { controller, elements };
}

test('web settings stay hidden and never access desktop credentials', async () => {
  const { controller, elements } = await setup(() => assert.fail('unexpected desktop command'), false);
  assert.equal(controller, null);
  assert.equal(elements.settingsBtn.hidden, true);
});

test('traffic keys round-trip through native settings; blank clears a saved key', async () => {
  const calls = [];
  const { controller, elements } = await setup(async (command, args) => {
    calls.push({ command, args });
    return { QLD_TRAFFIC_API_KEY: 'example-qld', NSW_TRAFFIC_API_KEY: 'example-nsw' };
  });
  await controller.open();
  assert.equal(elements.setQldKey.value, 'example-qld');
  assert.equal(elements.setNswKey.value, 'example-nsw');
  elements.setQldKey.value = '  replacement-example  ';
  elements.setNswKey.value = '  ';
  await controller.save();
  assert.deepEqual(calls[1], { command: 'save_settings', args: { qldKey: 'replacement-example', nswKey: null } });
  assert.match(elements.settingsStatus.textContent, /Saved on this computer/);
  controller.close();
  assert.equal(elements.setQldKey.value, '');
  assert.equal(elements.setNswKey.value, '');
});

test('failed loading cannot overwrite existing credentials with empty inputs', async () => {
  const calls = [];
  const { controller, elements } = await setup(async command => {
    calls.push(command);
    throw new Error('Cannot read settings file');
  });
  await controller.open();
  assert.equal(elements.settingsSave.disabled, true);
  await controller.save();
  assert.deepEqual(calls, ['load_settings']);
  assert.match(elements.settingsStatus.textContent, /Close and reopen/);
});

test('closing settings discards a delayed load without restoring keys into the page', async () => {
  let finish;
  const { controller, elements } = await setup(() => new Promise(resolve => { finish = resolve; }));
  const loading = controller.open();
  controller.close();
  finish({ QLD_TRAFFIC_API_KEY: 'stale-example' });
  await loading;
  assert.equal(elements.settingsModal.hidden, true);
  assert.equal(elements.setQldKey.value, '');
});

test('a save failure keeps the form available for retry without claiming success', async () => {
  const { controller, elements } = await setup(async command => {
    if (command === 'save_settings') throw new Error('Settings file is read-only');
    return {};
  });
  await controller.open();
  elements.setNswKey.value = 'example-nsw';
  await controller.save();
  assert.equal(elements.settingsSave.disabled, false);
  assert.equal(elements.setNswKey.value, 'example-nsw');
  assert.match(elements.settingsStatus.textContent, /Save failed/);
});
