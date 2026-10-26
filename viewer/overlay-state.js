// A modelled area's flood layer is either a canvas filled with setPixels (the
// normal path) or an image set by URL (the fallback). Either counts as drawn
// once it has content, and either can be turned back into an image URL for
// the printable report.
export const PIXELS_DRAWN = '_pixelsDrawn';

export function overlayDrawn(overlay) {
  return !!(overlay && (overlay._floodUrl || overlay[PIXELS_DRAWN]));
}

export function overlayImageUrl(overlay) {
  if (!overlay) return null;
  if (overlay._floodUrl) return overlay._floodUrl;
  const canvas = overlay[PIXELS_DRAWN] && overlay._image;
  if (!canvas || typeof canvas.toDataURL !== 'function') return null;
  try { return canvas.toDataURL('image/png'); } catch (error) { return null; }
}
