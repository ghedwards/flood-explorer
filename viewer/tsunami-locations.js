// Shared scene catalogue for the picker, prefetch scripts and validation.
export const regionalLocations = [
  { id: 'moreton', name: 'Moreton Bay / Brisbane, Qld', lat: -27.45, lon: 153.75 },
  { id: 'gold-coast', name: 'Gold Coast / Tweed, Qld–NSW', lat: -28.1, lon: 154.05 },
  { id: 'coffs', name: 'Coffs Harbour, NSW', lat: -30.3, lon: 153.8 },
  { id: 'newcastle', name: 'Newcastle / Hunter coast, NSW', lat: -32.9, lon: 152.4 },
  { id: 'sydney', name: 'Sydney / Central Coast, NSW', lat: -33.85, lon: 151.95 },
  { id: 'sunshine-coast', name: 'Sunshine Coast, Qld', lat: -26.65, lon: 153.8 },
  { id: 'port-macquarie', name: 'Port Macquarie, NSW', lat: -31.43, lon: 153.65 },
  { id: 'wollongong', name: 'Wollongong / Illawarra, NSW', lat: -34.42, lon: 151.65 },
];
export const estuaryLocations = [
  { id: 'gold-coast-seaway', name: 'Gold Coast / Broadwater & Seaway, Qld · terrain test', cell: 50, extent: [537500, 6905500, 545500, 6910300], seaEdges: ['east', 'north'], sourceTarget: [130, 32], parent: { id: 'gold-coast', source: [154.3, -28.0] } },
  { id: 'pine-estuary', name: 'Pine River / Moreton Bay, Qld · terrain test', extent: [504000, 6979500, 508000, 6981900], seaEdges: ['east'], sourceTarget: [142, 48], parent: { id: 'moreton', source: [154.3, -27.3] } },
  { id: 'brisbane-mouth', name: 'Brisbane River mouth, Qld · terrain test', extent: [513500, 6970000, 517500, 6972400], seaEdges: ['north'], sourceTarget: [70, 14], parent: { id: 'moreton', source: [154.3, -27.3] } },
  { id: 'currumbin', name: 'Currumbin Creek / Gold Coast, Qld · terrain test', extent: [545500, 6887000, 549500, 6889400], seaEdges: ['east', 'north'], sourceTarget: [135, 30], parent: { id: 'gold-coast', source: [154.3, -28.0] } },
];
export const estuaryIds = estuaryLocations.map(location => location.id);
export const regionalIds = regionalLocations.map(location => location.id);
