// Tide states from published tidal planes.
//
// A tidal-planes table gives the heights of characteristic tide levels above a chart datum
// (for Queensland, Port Datum = LAT). The tsunami lab's terrain is in AVWS (close to AHD)
// and its sea level starts at a level in those units, so a tide state needs two things the
// table cannot give by itself: the level of MSL in the terrain's datum, and how often each
// state occurs. This module supplies the first as an explicit, adjustable offset (default 0,
// that is, MSL taken as the terrain's zero) and does not guess the second.
'use strict';

const ORDER = ['LAT', 'MLWS', 'MLWN', 'MSL', 'MHWN', 'MHWS', 'HAT'];

// Plane heights relative to MSL, lowest first: { name, aboveMsl }.
function levelsAboveMsl(data) {
  const planes = data?.planes;
  if (!planes || !ORDER.every(name => Number.isFinite(planes[name]))) throw new Error(`The tidal planes need numbers for ${ORDER.join(', ')}.`);
  for (let i = 1; i < ORDER.length; i++) if (!(planes[ORDER[i]] > planes[ORDER[i - 1]])) throw new Error(`The tidal planes must rise from ${ORDER[i - 1]} to ${ORDER[i]}.`);
  return ORDER.map(name => ({ name, aboveMsl: +(planes[name] - planes.MSL).toFixed(3) }));
}

// The level to start the local model at for a named tide state, in the terrain's datum.
function stateLevel(data, name, mslInTerrainDatum = 0) {
  const state = levelsAboveMsl(data).find(s => s.name === name);
  if (!state) throw new Error(`Unknown tide state ${name}; use one of ${ORDER.join(', ')}.`);
  if (!Number.isFinite(mslInTerrainDatum)) throw new Error('The MSL offset must be a number of metres.');
  return +(state.aboveMsl + mslInTerrainDatum).toFixed(3);
}

// Spring and neap ranges and the M2 and S2 amplitudes they imply if those two constituents
// alone made the semidiurnal tide: spring range = 2(M2+S2), neap range = 2(M2-S2).
function springNeap(data) {
  const p = data.planes;
  const spring = p.MHWS - p.MLWS, neap = p.MHWN - p.MLWN;
  return { springRange: +spring.toFixed(3), neapRange: +neap.toFixed(3), m2: +((spring + neap) / 4).toFixed(3), s2: +((spring - neap) / 4).toFixed(3) };
}

module.exports = { STATES: ORDER, levelsAboveMsl, stateLevel, springNeap };
