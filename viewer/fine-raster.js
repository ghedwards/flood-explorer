/* Helpers for the 5 m flood picture from LiDAR (see updateFine in app.js): the window of model cells a box
 * needs, and cropping arrays to it. The picture itself is rust/flood-core/src/fine.rs (FloodCore.fineRaster);
 * tests/fine-raster-reference.js is the plain JavaScript version it is checked against. */

/* The window of model cells a box needs (with a margin for the 3×3 lookups),
 * clamped to the grid: { x0, y0, ww, wh }. */
export function fineWindow(box, g, aW, aH) {
  const gw = g.east - g.west, gh = g.north - g.south;
  const clampX = (v) => Math.max(0, Math.min(aW - 1, v)), clampY = (v) => Math.max(0, Math.min(aH - 1, v));
  const x0 = clampX(Math.floor(((box[0] - g.west) / gw) * aW) - 2), x1 = clampX(Math.ceil(((box[2] - g.west) / gw) * aW) + 2);
  const y0 = clampY(Math.floor(((g.north - box[3]) / gh) * aH) - 2), y1 = clampY(Math.ceil(((g.north - box[1]) / gh) * aH) + 2);
  return { x0, y0, ww: x1 - x0 + 1, wh: y1 - y0 + 1 };
}

/* Copy a window of a full-grid array (itemsPerCell values per cell). */
export function cropGrid(arr, aW, win, itemsPerCell = 1) {
  if (!arr) return null;
  const out = new arr.constructor(win.ww * win.wh * itemsPerCell);
  for (let y = 0; y < win.wh; y++) {
    const from = ((win.y0 + y) * aW + win.x0) * itemsPerCell;
    out.set(arr.subarray(from, from + win.ww * itemsPerCell), y * win.ww * itemsPerCell);
  }
  return out;
}
