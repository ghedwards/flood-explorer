// Small offline reference-label subsets from the national Composite Gazetteer.
const fs = require('node:fs');
const path = require('node:path');
const groups = {
  moreton: ['Brisbane', 'Redcliffe', 'Cleveland', 'Ipswich'],
  'gold-coast-seaway': ['Southport', 'Main Beach', 'Gold Coast Seaway', 'Wave Break Island', 'The Spit'],
  'gold-coast': ['Gold Coast', 'Surfers Paradise', 'Tweed Heads', 'Coolangatta'],
  coffs: ['Coffs Harbour', 'Woolgoolga', 'Urunga'],
  newcastle: ['Newcastle', 'Nelson Bay', 'Maitland'],
  sydney: ['Sydney', 'Gosford', 'Wollongong'],
  'sunshine-coast': ['Maroochydore', 'Mooloolaba', 'Caloundra', 'Noosa Heads'],
  'port-macquarie': ['Port Macquarie', 'Kempsey', 'Laurieton'],
  wollongong: ['Wollongong', 'Shellharbour', 'Kiama'],
  'pine-estuary': ['Brighton', 'Griffin', 'Pine River', 'Dohles Rocks'],
  'brisbane-mouth': ['Luggage Point', 'Fisherman Islands', 'Pinkenba'],
  currumbin: ['Currumbin', 'Currumbin Creek', 'Palm Beach'],
};
async function main() {
  const source = 'https://services.ga.gov.au/gis/rest/services/Composite_Gazetteer_of_Australia/MapServer/0';
  const names = [...new Set(Object.values(groups).flat())];
  const where = `UPPER(name) IN (${names.map(n => `'${n.toUpperCase().replaceAll("'", "''")}'`).join(',')}) AND authority IN ('QLD','NSW')`;
  const query = async sr => {
    const url = new URL(`${source}/query`);
    url.search = new URLSearchParams({ f: 'json', where, outFields: 'id,name,feature,authority', outSR: String(sr), returnGeometry: 'true' });
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Gazetteer HTTP ${response.status}`);
    const data = await response.json();
    if (data.error || data.exceededTransferLimit || !Array.isArray(data.features)) throw new Error(JSON.stringify(data.error || 'Incomplete gazetteer query'));
    return data.features;
  };
  const [geographic, projected] = await Promise.all([query(4326), query(7856)]);
  const xy = new Map(projected.map(f => [f.attributes.id, f.geometry]));
  const rank = ['POPULATION CENTRE', 'LOCALITY', 'WATERCOURSE', 'POINT', 'ROCK', 'BEACH', 'ISLAND GROUP', 'ISLAND', 'SPIT', 'PASSAGE'];
  const eligible = geographic.filter(f => rank.includes(f.attributes.feature) && f.geometry.x > 149 && f.geometry.y < -25 && f.geometry.y > -36);
  const output = {};
  for (const [id, wanted] of Object.entries(groups)) {
    const terrain = JSON.parse(fs.readFileSync(path.resolve(__dirname, `../viewer/public/tsunami-data/${id}.json`)));
    const bounds = terrain.extent || terrain.bounds;
    output[id] = wanted.map(name => {
      const distance = f => {
        const p = terrain.extent ? xy.get(f.attributes.id) : f.geometry;
        if (!p) return Infinity;
        const u = (p.x - bounds[0]) / (bounds[2] - bounds[0]), v = (bounds[3] - p.y) / (bounds[3] - bounds[1]);
        return Math.hypot(u - .5, v - .5);
      };
      const feature = eligible.filter(f => f.attributes.name.toLowerCase() === name.toLowerCase()).sort((a, b) => {
        // A matching name in another state must not outrank the local place.
        const nearA = distance(a), nearB = distance(b);
        if (Math.abs(nearA - nearB) > 2) return nearA - nearB;
        return rank.indexOf(a.attributes.feature) - rank.indexOf(b.attributes.feature) || nearA - nearB;
      })[0];
      if (!feature) throw new Error(`Missing reference place ${name}`);
      const p = terrain.extent ? xy.get(feature.attributes.id) : feature.geometry;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) throw new Error(`Invalid coordinate ${name}`);
      return { name, id: feature.attributes.id, feature: feature.attributes.feature,
        u: (p.x - bounds[0]) / (bounds[2] - bounds[0]), v: (bounds[3] - p.y) / (bounds[3] - bounds[1]) };
    });
    console.log(`${id}: ${output[id].length} reference places`);
  }
  const data = { source: 'Composite Gazetteer of Australia', sourceUrl: source,
    attribution: 'Geoscience Australia and the Queensland and NSW place naming authorities',
    note: 'Place-name reference points; accuracy varies. Not navigation or surveyed boundaries. Outside-grid points are listed separately, not moved onto the map.',
    prepared: new Date().toISOString(), scenes: output };
  fs.writeFileSync(path.resolve(__dirname, '../viewer/public/tsunami-data/places.json'), JSON.stringify(data) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
