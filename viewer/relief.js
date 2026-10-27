/* Shaded relief colours for the map and the static image: a hypsometric tint, sea in a flat colour. The shading
 * itself is rust/flood-core/src/render.rs `terrain_rgba` (FloodCore.terrainRGBA, given these stops);
 * tests/relief-reference.js is the plain JavaScript version that tests/relief-wasm.test.js checks it against. */

export const HYPSO = [
  [0, [226, 230, 214]], [0.12, [208, 218, 186]], [0.35, [186, 186, 146]], [0.65, [160, 142, 112]], [1, [128, 112, 100]],
];
