import { estuaryIds } from './tsunami-locations.js';
/* The grids the tsunami lab runs on: regional propagation grids (idealised basins or a prefetched coastal grid), the idealised nonlinear estuary and the real local terrain scenes,
 * with their starting waves. They are built and checked in Rust (rust/flood-core/src/tsunami_grid.rs, through FloodCore.tsunamiGrid); this only says which builder a scene
 * needs and hands over its data. The wave model must have loaded (FloodCore): the page awaits FloodCoreReady, and the tests load it with ./model.js. */
const EDGE_CODES = { north: 0, east: 1, south: 2, west: 3 };
const core = (F) => {
  const c = F || globalThis.FloodCore;
  if (!c || !c.tsunamiGrid) throw new Error('The wave model has not loaded yet.');
  return c;
};
// the edge names as the Rust side's codes; any unknown name makes the whole list invalid (an empty list, which it refuses)
const edgeCodes = (names) => (Array.isArray(names) && names.every((n) => n in EDGE_CODES) ? Float64Array.from(names, (n) => EDGE_CODES[n]) : new Float64Array(0));
const arrayOr = (v) => (Array.isArray(v) || ArrayBuffer.isView(v) ? v : []);

const result = (o, extra = {}) => ({
  W: o.W, H: o.H, cell: o.cell, depth: o.depth, eta: o.eta, absorbing: o.absorbing, method: o.method,
  ...(o.bed && { bed: o.bed }), ...(o.valid && { valid: o.valid }), ...(o.roughness !== undefined && { roughness: o.roughness }), ...extra,
});

export function tsunamiGrid({ preset = 'shelf', deep = 3000, amplitude = 1, width = 10, source = [38, 48], absorbing = true, method = 'staggered', bathymetry = null, tide = 0, roughness = 0.025, lakeLevel = 1, coupled = false, scheme = 'first' } = {}, F) {
  if (!['first', 'second'].includes(scheme)) throw new Error('Unknown numerical scheme.');
  if (coupled && !estuaryIds.includes(preset)) throw new Error('Only the local terrain scenes can be driven by a regional offshore wave.');
  const local = estuaryIds.includes(preset);
  if (method === 'dispersive' && (preset === 'estuary' || local)) throw new Error('Dispersive waves are not available in the nonlinear local scenes.');
  const order = scheme === 'second' ? 2 : 1, c = core(F), common = { amplitude, width, absorbing: absorbing ? 1 : 0, source: Array.isArray(source) ? Float64Array.from(source, Number) : undefined };
  const out = (o) => ({ ...o, absorbing: o.absorbing === 1, coupled: o.coupled === 1 });
  if (local) {
    const b = bathymetry || {}, valid = Array.isArray(b.valid) && b.valid.every((v) => v === 0 || v === 1) ? Uint8Array.from(b.valid) : (b.valid == null ? undefined : new Uint8Array(0));
    const o = c.tsunamiGrid({ ...common, kind: 2, tide, roughness, coupled: coupled ? 1 : 0, idOk: b.id === preset ? 1 : 0, bW: b.W, bH: b.H, bCell: b.cell, elevation: arrayOr(b.elevation), extent: arrayOr(b.extent), valid, seaEdges: edgeCodes(b.seaEdges ?? ['east']) });
    return result(out(o), { coupled: o.coupled === 1, order });
  }
  if (preset === 'estuary') return result(out(c.tsunamiGrid({ ...common, kind: 1, tide, roughness, lakeLevel })), { order });
  const mapped = { staggered: 0, 'finite-volume': 1, dispersive: 3 }[method];
  const shape = { flat: 0, shelf: 1, island: 2 }[preset], b = bathymetry;
  const o = c.tsunamiGrid({
    ...common, kind: 0, deep, method: mapped ?? 255, coast: b ? 1 : 0, shape: shape ?? 255,
    ...(b && { idOk: b.id === preset ? 1 : 0, bW: b.W, bH: b.H, bCell: b.cell, elevation: arrayOr(b.elevation), bounds: arrayOr(b.bounds) }),
  });
  return result(out(o));
}

// Sea inward from the open edges: the depth of every cell connected to an open edge whose ground is below `level` (see tsunami_grid.rs).
export function connectedWaterDepth(bed, W, H, level, edges = ['east'], valid = null, F) {
  return core(F).connectedWaterDepth(bed, W, H, level, edges, valid);
}
