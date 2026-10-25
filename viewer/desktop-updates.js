// Desktop only. The native side owns the update URL, signature check and installer.
export function desktopUpdates({ invoke, desktop, document }) {
  const panel = document.getElementById('desktopUpdates');
  if (!desktop || !panel) return null;
  const status = document.getElementById('updateStatus');
  const notes = document.getElementById('updateNotes');
  const check = document.getElementById('updateCheck');
  const install = document.getElementById('updateInstall');
  const settings = document.getElementById('settingsModal');
  panel.hidden = false;
  let pending = null, busy = false;
  const errorText = error => error && error.message || String(error);
  async function checkNow(automatic = false) {
    if (busy) return;
    busy = true;
    pending = null;
    check.disabled = true;
    install.hidden = true;
    notes.textContent = '';
    status.textContent = 'Checking for updates…';
    try {
      const result = await invoke('check_for_update', {});
      if (result.version) {
        pending = result.version;
        status.textContent = `Flood Explorer ${result.version} is available (installed: ${result.currentVersion}). Installing will close and restart the app. Save any work first.`;
        notes.textContent = result.notes || '';
        install.hidden = false;
        if (automatic && settings) settings.hidden = false;
      } else {
        status.textContent = `Flood Explorer ${result.currentVersion} is up to date.`;
      }
    } catch (error) {
      status.textContent = `Could not check for updates: ${errorText(error)}`;
    } finally {
      busy = false;
      check.disabled = false;
    }
  }
  async function installNow() {
    if (busy || !pending) return;
    busy = true;
    check.disabled = true;
    install.disabled = true;
    status.textContent = 'Downloading and verifying the update… The app will restart when ready.';
    try {
      await invoke('install_update', { version: pending });
    } catch (error) {
      status.textContent = `Update failed: ${errorText(error)} Check for updates to try again.`;
      pending = null;
      install.hidden = true;
    } finally {
      busy = false;
      check.disabled = false;
      install.disabled = false;
    }
  }
  check.addEventListener('click', () => checkNow());
  install.addEventListener('click', installNow);
  // Checking is automatic; downloading, replacing files and restarting require a click.
  const ready = checkNow(true);
  return { checkNow, installNow, ready };
}
