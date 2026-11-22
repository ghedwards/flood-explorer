// Pure share-link encoding, decoding, and validation helpers.
// Kept free of DOM/Leaflet globals so both the viewer and unit tests can import it directly.

export function b64(str) {
  // Chunked char codes: spreading every byte into fromCharCode throws
  // RangeError past ~65 k bytes, which saved share links would hit.
  const bytes = new TextEncoder().encode(str);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function unb64(txt) {
  const norm = String(txt || '').replace(/-/g, '+').replace(/_/g, '/');
  return new TextDecoder().decode(Uint8Array.from(atob(norm), (ch) => ch.charCodeAt(0)));
}

export function isValidLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
}

export function sanitizeView(view) {
  if (!Array.isArray(view) || view.length < 3) return null;
  const lat = Number(view[0]);
  const lon = Number(view[1]);
  const zoom = Number(view[2]);
  if (!isValidLatLon(lat, lon) || !Number.isFinite(zoom) || zoom < 1 || zoom > 22) return null;
  return [lat, lon, zoom];
}

export function sanitizePin(p) {
  if (!p || typeof p !== 'object') return null;
  const lat = Number(p.lat);
  const lon = Number(p.lon);
  if (!isValidLatLon(lat, lon)) return null;
  const n = Number.isInteger(p.n) && p.n > 0 ? p.n : undefined;
  const name = typeof p.name === 'string' ? p.name.slice(0, 120) : '';
  return { n, lat, lon, name };
}

export function sanitizeStudy(x) {
  if (!x || !Array.isArray(x.b) || x.b.length < 4) return null;
  const b = x.b.slice(0, 4).map(Number);
  if (!b.every(Number.isFinite)) return null;
  const letter = typeof x.l === 'string' && /^[A-Z]$/i.test(x.l.trim()) ? x.l.trim().toUpperCase() : undefined;
  const name = typeof x.name === 'string' ? x.name.slice(0, 120) : '';
  const nums = Array.isArray(x.m) ? x.m.filter((k) => Number.isInteger(k) && k > 0 && k < 10000).slice(0, 200) : [];
  return { letter, bounds: b, name, nums };
}
