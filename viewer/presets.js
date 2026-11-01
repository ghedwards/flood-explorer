// Preset locations and intended rivers are separate from their display labels.
export const PRESETS = [
  { id: 'ipswich', name: 'Ipswich, Bremer River (Qld)', state: 'Qld', lat: -27.6135, lon: 152.7625, kind: 'river', river: 'Bremer River' },
  { id: 'logan', name: 'Logan River, Waterford (Qld)', state: 'Qld', lat: -27.6960, lon: 153.1440, kind: 'river', river: 'Logan River' },
  { id: 'grantham', name: 'Grantham, Lockyer Creek (Qld)', state: 'Qld', lat: -27.5790, lon: 152.2010, kind: 'river', river: 'Lockyer Creek', anchorNote: 'The selected Lockyer Creek gauge is at Gatton, about 7.8 km away; it is not a gauge at Grantham.' },
  { id: 'gympie', name: 'Gympie, Mary River (Qld)', state: 'Qld', lat: -26.1835, lon: 152.6620, kind: 'river', river: 'Mary River' },
  { id: 'maryborough', name: 'Maryborough, Mary River (Qld)', state: 'Qld', lat: -25.5340, lon: 152.7050, kind: 'river', river: 'Mary River' },
  { id: 'bundaberg', name: 'Bundaberg, Burnett River (Qld)', state: 'Qld', lat: -24.8650, lon: 152.3480, kind: 'river', river: 'Burnett River' },
  { id: 'rockhampton', name: 'Rockhampton, Fitzroy River (Qld)', state: 'Qld', lat: -23.3765, lon: 150.5125, kind: 'river', river: 'Fitzroy River' },
  { id: 'emerald', name: 'Emerald, Nogoa River (Qld)', state: 'Qld', lat: -23.5240, lon: 148.1550, kind: 'river', river: 'Nogoa River' },
  { id: 'mackay', name: 'Mackay, Pioneer River (Qld)', state: 'Qld', lat: -21.1410, lon: 149.1820, kind: 'river', river: 'Pioneer River' },
  { id: 'townsville', name: 'Townsville, Ross River (Qld)', state: 'Qld', lat: -19.2880, lon: 146.7900, kind: 'river', river: 'Ross River' },
  { id: 'ingham', name: 'Ingham, Herbert River (Qld)', state: 'Qld', lat: -18.6400, lon: 146.1600, kind: 'river', river: 'Herbert River' },
  { id: 'charleville', name: 'Charleville, Warrego River (Qld)', state: 'Qld', lat: -26.4020, lon: 146.2350, kind: 'river', river: 'Warrego River' },
  { id: 'stgeorge', name: 'St George, Balonne River (Qld)', state: 'Qld', lat: -28.0370, lon: 148.5820, kind: 'river', river: 'Balonne River' },
  { id: 'goondiwindi', name: 'Goondiwindi, Macintyre River (Qld)', state: 'Qld', lat: -28.5400, lon: 150.3100, kind: 'river', river: 'Macintyre River' },
  { id: 'lismore', name: 'Lismore, Wilsons River (NSW)', state: 'NSW', lat: -28.8090, lon: 153.2765, kind: 'river', river: 'Wilsons River' },
  { id: 'murwillumbah', name: 'Murwillumbah, Tweed River (NSW)', state: 'NSW', lat: -28.3270, lon: 153.3960, kind: 'river', river: 'Tweed River' },
  { id: 'grafton', name: 'Grafton, Clarence River (NSW)', state: 'NSW', lat: -29.6915, lon: 152.9355, kind: 'river', river: 'Clarence River' },
  { id: 'kempsey', name: 'Kempsey, Macleay River (NSW)', state: 'NSW', lat: -31.0800, lon: 152.8380, kind: 'river', river: 'Macleay River' },
  { id: 'portmacquarie', name: 'Port Macquarie, Hastings River (NSW)', state: 'NSW', lat: -31.4300, lon: 152.9050, kind: 'river', river: 'Hastings River' },
  { id: 'taree', name: 'Taree, Manning River (NSW)', state: 'NSW', lat: -31.9030, lon: 152.4620, kind: 'river', river: 'Manning River' },
  { id: 'maitland', name: 'Maitland, Hunter River (NSW)', state: 'NSW', lat: -32.7280, lon: 151.5560, kind: 'river', river: 'Hunter River' },
  { id: 'windsor', name: 'Windsor, Hawkesbury River (NSW)', state: 'NSW', lat: -33.6045, lon: 150.8225, kind: 'river', river: 'Hawkesbury River' },
  { id: 'liverpool', name: 'Liverpool, Georges River (NSW)', state: 'NSW', lat: -33.9250, lon: 150.9320, kind: 'river', river: 'Georges River' },
  { id: 'moree', name: 'Moree, Mehi River (NSW)', state: 'NSW', lat: -29.4710, lon: 149.8450, kind: 'river', river: 'Mehi River' },
  { id: 'dubbo', name: 'Dubbo, Macquarie River (NSW)', state: 'NSW', lat: -32.2470, lon: 148.6000, kind: 'river', river: 'Macquarie River' },
  { id: 'forbes', name: 'Forbes, Lachlan River (NSW)', state: 'NSW', lat: -33.3850, lon: 148.0100, kind: 'river', river: 'Lachlan River' },
  { id: 'wagga', name: 'Wagga Wagga, Murrumbidgee River (NSW)', state: 'NSW', lat: -35.1030, lon: 147.3680, kind: 'river', river: 'Murrumbidgee River' },
  { id: 'gundagai', name: 'Gundagai, Murrumbidgee River (NSW)', state: 'NSW', lat: -35.0650, lon: 148.1050, kind: 'river', river: 'Murrumbidgee River' },
  { id: 'maribyrnong', name: 'Maribyrnong River, Melbourne (Vic)', state: 'Vic', lat: -37.7760, lon: 144.8890, kind: 'river', river: 'Maribyrnong River' },
  { id: 'echuca', name: 'Echuca, Murray River (Vic)', state: 'Vic', lat: -36.1240, lon: 144.7520, kind: 'river', river: 'Murray River' },
  { id: 'rochester', name: 'Rochester, Campaspe River (Vic)', state: 'Vic', lat: -36.3630, lon: 144.7050, kind: 'river', river: 'Campaspe River' },
  { id: 'shepparton', name: 'Shepparton, Goulburn River (Vic)', state: 'Vic', lat: -36.3720, lon: 145.4070, kind: 'river', river: 'Goulburn River' },
  { id: 'seymour', name: 'Seymour, Goulburn River (Vic)', state: 'Vic', lat: -37.0270, lon: 145.1460, kind: 'river', river: 'Goulburn River' },
  { id: 'benalla', name: 'Benalla, Broken River (Vic)', state: 'Vic', lat: -36.5510, lon: 145.9830, kind: 'river', river: 'Broken River' },
  { id: 'kerang', name: 'Kerang, Loddon River (Vic)', state: 'Vic', lat: -35.7320, lon: 143.9200, kind: 'river', river: 'Loddon River' },
  { id: 'traralgon', name: 'Traralgon, Traralgon Creek (Vic)', state: 'Vic', lat: -38.1950, lon: 146.5360, kind: 'river', river: 'Traralgon Creek' },
  { id: 'bairnsdale', name: 'Bairnsdale, Mitchell River (Vic)', state: 'Vic', lat: -37.8320, lon: 147.6200, kind: 'river', river: 'Mitchell River' },
  { id: 'murraybridge', name: 'Murray Bridge, Murray River (SA)', state: 'SA', lat: -35.1180, lon: 139.2750, kind: 'river', river: 'Murray River' },
  { id: 'gawler', name: 'Gawler, Gawler River (SA)', state: 'SA', lat: -34.6010, lon: 138.7360, kind: 'river', river: 'Gawler River' },
  { id: 'guildford', name: 'Guildford, Swan River, Perth (WA)', state: 'WA', lat: -31.9000, lon: 115.9700, kind: 'river', river: 'Swan River' },
  { id: 'carnarvon', name: 'Carnarvon, Gascoyne River (WA)', state: 'WA', lat: -24.8800, lon: 113.6650, kind: 'river', river: 'Gascoyne River', anchorNote: 'Nearest published Gascoyne gauge is Nine Mile Bridge, about 12 km away; keep the model centred on Carnarvon.' },
  { id: 'fitzroycrossing', name: 'Fitzroy Crossing, Fitzroy River (WA)', state: 'WA', lat: -18.1960, lon: 125.5780, kind: 'river', river: 'Fitzroy River' },
  { id: 'launceston', name: 'Launceston, Tamar River (Tas)', state: 'Tas', lat: -41.4330, lon: 147.1430, kind: 'river', river: 'Tamar River', anchorNote: 'Nearby gauges measure the North Esk and South Esk, not the Tamar; keep the Tamar model at the selected point.' },
  { id: 'latrobe', name: 'Latrobe, Mersey River (Tas)', state: 'Tas', lat: -41.2370, lon: 146.4140, kind: 'river', river: 'Mersey River' },
  { id: 'huonville', name: 'Huonville, Huon River (Tas)', state: 'Tas', lat: -43.0300, lon: 147.0480, kind: 'river', river: 'Huon River' },
  { id: 'katherine', name: 'Katherine, Katherine River (NT)', state: 'NT', lat: -14.4660, lon: 132.2635, kind: 'river', river: 'Katherine River' },
  { id: 'cairns', name: 'Cairns waterfront (Qld)', state: 'Qld', lat: -16.9200, lon: 145.7800, kind: 'coast' },
  { id: 'herveybay', name: 'Hervey Bay (Qld)', state: 'Qld', lat: -25.2880, lon: 152.8400, kind: 'coast' },
  { id: 'maroochydore', name: 'Maroochydore, Sunshine Coast (Qld)', state: 'Qld', lat: -26.6530, lon: 153.0920, kind: 'coast' },
  { id: 'goldcoast', name: 'Gold Coast Broadwater (Qld)', state: 'Qld', lat: -27.9650, lon: 153.4100, kind: 'coast' },
  { id: 'ballina', name: 'Ballina, Richmond River mouth (NSW)', state: 'NSW', lat: -28.8700, lon: 153.5650, kind: 'coast' },
  { id: 'newcastle', name: 'Newcastle harbour (NSW)', state: 'NSW', lat: -32.9250, lon: 151.7800, kind: 'coast' },
  { id: 'elwood', name: 'Elwood, Port Phillip (Vic)', state: 'Vic', lat: -37.8830, lon: 144.9810, kind: 'coast' },
  { id: 'lakesentrance', name: 'Lakes Entrance (Vic)', state: 'Vic', lat: -37.8810, lon: 147.9810, kind: 'coast' },
  { id: 'portadelaide', name: 'Port Adelaide (SA)', state: 'SA', lat: -34.8460, lon: 138.5050, kind: 'coast' },
  { id: 'mandurah', name: 'Mandurah (WA)', state: 'WA', lat: -32.5300, lon: 115.7230, kind: 'coast' },
  { id: 'hobart', name: 'Hobart, Derwent estuary (Tas)', state: 'Tas', lat: -42.8820, lon: 147.3330, kind: 'coast' },
  { id: 'darwin', name: 'Darwin harbour (NT)', state: 'NT', lat: -12.4630, lon: 130.8420, kind: 'coast' },
];

// Prefer a flood-forecast gauge on the intended river within 8 km. Match
// the gauge name, not its basin: a basin also contains tributaries and dams.
const riverWords = text => text.toLowerCase().replace(/\br\b/g, 'river').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
export function presetGauge(p, gauges) {
  if (p.kind !== 'river' || !p.river) return null;
  const river = riverWords(p.river);
  const reversed = river.replace(/^(.*) (river|creek)$/, '$2 $1');
  const rank = { forecast: 0, information: 1, river: 2 };
  let best = null;
  for (const f of gauges || []) {
    const q = f.properties;
    if (!(q.kind in rank)) continue;
    const name = ` ${riverWords(q.name || '')} `;
    if (!river || (!name.includes(` ${river} `) && !name.includes(` ${reversed} `))) continue;
    const [lon, lat] = f.geometry.coordinates;
    const dy = (lat - p.lat) * 110.574;
    const dx = (lon - p.lon) * 111.32 * Math.cos((lat + p.lat) / 2 * Math.PI / 180);
    const km = Math.hypot(dx, dy);
    if (!Number.isFinite(km) || km > 8) continue;
    const score = rank[q.kind] * 3 + km;
    if (!best || score < best.score) best = { f, km, score, named: true };
  }
  return best;
}
