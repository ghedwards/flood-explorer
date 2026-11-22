/* Shared HTML escaping, URL scheme validation, and area-ID sanitization used
 * across the viewer modules so every DOM sink enforces the same guarantees. */

const HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => HTML_MAP[c]);
}

export function safeHttpUrl(u, base) {
  if (!u) return '';
  try {
    const parsed = base ? new URL(String(u), base) : new URL(String(u));
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : '';
  } catch (e) {
    return '';
  }
}

export function safeAreaId(id) {
  return typeof id === 'string' && /^[a-z0-9-]+$/i.test(id) ? id : '';
}
