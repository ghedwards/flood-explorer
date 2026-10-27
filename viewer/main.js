import "@fontsource-variable/archivo/standard.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import "./styles.css";
import "./runtime-paths.js";
import "./flood-wasm.js";
import { showUnsupported } from "./unsupported.js";

// The app only starts once the WebAssembly flood model has loaded; without it, say so and stop.
(async () => {
  let failure = '';
  window.addEventListener('flood:wasm-error', (e) => { failure = (e.detail && e.detail.error) || failure; });
  try { await window.FloodCoreReady; } catch (err) { failure = String(err); }
  if (window.FloodCore.engine !== 'rust') { showUnsupported(failure || 'The model could not be loaded in this browser session.'); return; }
  await import("./app.js");
})();
