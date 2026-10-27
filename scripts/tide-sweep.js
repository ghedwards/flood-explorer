// How much does the tide at the time a tsunami arrives change what the local model floods?
// Each series file is run through the nested Gold Coast Seaway model at each of the
// tidal-plane states (LAT to HAT), starting from that sea level.
//
//   node scripts/tide-sweep.js [--seconds 3600] [--msl-offset 0] [--states MLWS,MSL,MHWS,HAT] [--jobs N] wave1.csv ...
//
// Runs are spread over --jobs worker threads (default: one per core, up to 8).
//
// The planes are in viewer/public/tsunami-data/gold-coast-seaway-tidal-planes.json (read the
// note there: they are not yet checked against the published table). --msl-offset is the level
// of MSL in the terrain's datum, in metres; the default 0 takes MSL as the terrain's zero.
// "tide alone" is land the starting sea level already covers (sea walls and levees that the
// terrain may not capture would keep some of it dry, so it can overstate real tidal flooding at
// the high states); "added by wave" is land the wave newly covers; "total flooded" is land under
// more than 1 cm at any time. The sea level stays at the chosen state for the whole run, so this
// shows the effect of the state at arrival, not of a tide that moves during the tsunami. It says
// nothing about how often each state occurs.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { STATES, stateLevel } = require('./tide-lib.js');
const { createPool, defaultJobs } = require('./run-pool.js');

async function main(argv) {
  let seconds = 3600, offset = 0, jobs = defaultJobs(), states = ['MLWS', 'MSL', 'MHWS', 'HAT'];
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seconds') seconds = Number(argv[++i]);
    else if (argv[i] === '--msl-offset') offset = Number(argv[++i]);
    else if (argv[i] === '--jobs') jobs = Number(argv[++i]);
    else if (argv[i] === '--states') states = String(argv[++i]).split(',');
    else if (argv[i].startsWith('--')) throw new Error(`Unknown option ${argv[i]}`);
    else files.push(argv[i]);
  }
  if (!files.length || !(seconds > 0 && seconds <= 7200)) throw new Error('Give one or more series files and --seconds up to 7200.');
  const bad = states.find(s => !STATES.includes(s));
  if (bad) throw new Error(`Unknown tide state ${bad}; use ${STATES.join(', ')}.`);
  const planes = JSON.parse(fs.readFileSync(path.join(__dirname, '../viewer/public/tsunami-data/gold-coast-seaway-tidal-planes.json'), 'utf8'));
  const rows = [];
  console.log(`tidal planes: ${planes.source.split(' (')[0]}${planes.verified ? '' : ' (not yet verified against the table)'}; MSL in the terrain datum: ${offset} m`);
  console.log('series                          state  sea level  max depth on land  tide alone  added by wave  total flooded');
  const pool = createPool(jobs);
  try {
    // Every (series, state) pair runs on the pool; results print in order as they arrive.
    const runs = files.flatMap(file => {
      const csv = fs.readFileSync(file, 'utf8');
      return states.map(state => {
        const tide = stateLevel(planes, state, offset);
        return { file, state, tide, done: pool.run(csv, seconds, { tide, baseline: offset }) };
      });
    });
    for (const run of runs) {
      const r = await run.done;
      rows.push({ file: path.basename(run.file), state: run.state, tide: run.tide, ...r });
      console.log(`${path.basename(run.file).slice(0, 30).padEnd(30)}  ${run.state.padEnd(5)}  ${run.tide.toFixed(2).padStart(7)} m  ${r.maxLandDepth.toFixed(2).padStart(10)} m  ${r.tideOnlyHectares.toFixed(0).padStart(7)} ha  ${r.addedHectares.toFixed(0).padStart(11)} ha  ${r.floodedHectares.toFixed(0).padStart(8)} ha`);
    }
  } finally { await pool.close(); }
  return rows;
}

if (require.main === module) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exit(1); });
module.exports = { main };
