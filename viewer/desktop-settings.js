// Runtime feed settings live in the desktop settings file, never localStorage.
export function desktopSettings({ invoke, desktop, document }) {
  const modal = document.getElementById('settingsModal');
  const button = document.getElementById('settingsBtn');
  if (button) button.hidden = !desktop;
  if (!desktop || !modal) return null;
  const qld = document.getElementById('setQldKey');
  const nsw = document.getElementById('setNswKey');
  const saveButton = document.getElementById('settingsSave');
  const closeButton = document.getElementById('settingsClose');
  const status = document.getElementById('settingsStatus');
  let generation = 0, returnFocus = null;
  const clear = () => { qld.value = ''; nsw.value = ''; };
  const message = error => error && error.message || String(error);

  async function open() {
    const current = ++generation;
    if (modal.hidden) returnFocus = document.activeElement;
    clear();
    modal.hidden = false;
    saveButton.disabled = true;
    status.textContent = 'Loading saved traffic keys…';
    closeButton.focus();
    try {
      const values = await invoke('load_settings', {});
      if (current !== generation || modal.hidden) return;
      qld.value = values && values.QLD_TRAFFIC_API_KEY || '';
      nsw.value = values && values.NSW_TRAFFIC_API_KEY || '';
      saveButton.disabled = false;
      status.textContent = '';
      qld.focus();
    } catch (error) {
      if (current === generation && !modal.hidden) status.textContent = `Could not load settings: ${message(error)}. Close and reopen to retry.`;
    }
  }
  function close() {
    generation++;
    modal.hidden = true;
    clear();
    if (returnFocus && returnFocus.focus) returnFocus.focus();
  }
  async function save() {
    if (saveButton.disabled || modal.hidden) return;
    const current = generation;
    saveButton.disabled = true;
    status.textContent = 'Saving…';
    try {
      await invoke('save_settings', { qldKey: qld.value.trim() || null, nswKey: nsw.value.trim() || null });
      if (current === generation && !modal.hidden) status.textContent = 'Saved on this computer. Keys apply when the traffic feed next refreshes.';
    } catch (error) {
      if (current === generation && !modal.hidden) status.textContent = `Save failed: ${message(error)}`;
    } finally {
      if (current === generation && !modal.hidden) saveButton.disabled = false;
    }
  }
  if (button) button.addEventListener('click', open);
  closeButton.addEventListener('click', close);
  saveButton.addEventListener('click', save);
  modal.querySelectorAll('a[data-service]').forEach(link => {
    link.addEventListener('click', async event => {
      event.preventDefault();
      try { await invoke('open_service', { service: link.dataset.service }); }
      catch (error) { status.textContent = `Could not open setup page: ${message(error)}`; }
    });
  });
  modal.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    } else if (event.key === 'Tab') {
      const focusable = [...modal.querySelectorAll('a[href], button, input, select, textarea, [tabindex="0"]')]
        .filter(element => !element.disabled && element.offsetParent !== null);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (first && event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (last && !event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });
  return { open, close, save };
}
