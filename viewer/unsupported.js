/* Shown instead of the app when the WebAssembly flood model can't run (main.js). The flood model is Rust compiled
 * to WebAssembly and everything the page shows comes from it, so there is nothing to fall back to: the app is not
 * started, and this explains why. */

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function showUnsupported(detail) {
  const card = document.createElement('div');
  card.id = 'wasmGate';
  card.setAttribute('role', 'alertdialog');
  card.setAttribute('aria-label', 'The flood model is unavailable');
  card.innerHTML = `<style>
    #wasmGate{position:fixed;inset:0;z-index:9999;background:#0b2233;display:flex;align-items:center;justify-content:center;padding:24px;font-family:Archivo,system-ui,sans-serif}
    #wasmGate .card{max-width:34em;background:#fff;color:#123;border-radius:12px;padding:22px 26px;box-shadow:0 8px 40px rgba(0,0,0,.35)}
    #wasmGate h2{margin:.1em 0 .4em;font-size:1.15em}
    #wasmGate ul{margin:.3em 0 .8em;padding-left:1.2em}
    #wasmGate .hint{color:#567;font-size:.85em;word-break:break-word}
    #wasmGate button{font:inherit;padding:.4em 1.1em;border-radius:8px;border:1px solid #94a3b8;background:#20618d;color:#fff;cursor:pointer}
  </style><div class="card"><h2>This browser can't run Flood Explorer</h2>
    <p>The flood model is written in Rust and runs as WebAssembly. It didn't load, so there is nothing to calculate flood maps, statistics or timelines with, and the app has not been started.</p>
    <p>This usually means:</p>
    <ul><li>an old browser without WebAssembly: try the current Firefox, Chrome, Edge or Safari</li>
    <li>WebAssembly switched off (Lockdown Mode, a hardened-browser setting or a managed-device policy), or an extension blocking it or the model download</li>
    <li>an interrupted download: a reload often fixes it</li></ul>
    <p class="hint">${esc(detail || '')}</p>
    <button type="button" onclick="location.reload()">Reload</button></div>`;
  document.body.appendChild(card);
}
