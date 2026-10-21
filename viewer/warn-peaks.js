/* River heights in a Bureau of Meteorology flood warning's text.
 *
 *   "The Barcoo River at Blackall may peak near 2.60 metres Wednesday."
 *   "The Warrego River at Augathella may exceed the moderate flood level (5.00 m)."
 *   "The Bulloo River at Quilpie is currently at 4.31 metres and falling."
 *   "The Bulloo River at Quilpie peaked at 4.45 metres on Tuesday."
 *
 * Each height comes back with the river and place it belongs to (the
 * nearest "<River> at <Place>" before it in the sentence, else the one
 * the previous sentence was about) and what kind of height it is:
 *   peak    a predicted peak ("may peak near", "likely to reach")
 *   class   a flood class level the river may reach ("(5.00 m)"), with cls
 *   now     a current height ("currently at")
 *   peaked  a peak that has passed ("peaked at")
 * Heights are on the gauge board, as the Bureau gives them.
 */

const WATER = '(?:River|Creek|Brook|Rivulet|Anabranch|Branch|Lagoon)';
const WORD = "[A-Z][A-Za-z'’.-]*";
const LOC = new RegExp(`((?:${WORD}\\s+){0,3}${WATER})\\s+at\\s+((?:${WORD}|\\d+)(?:\\s+(?:${WORD}|\\d+))*)`, 'g');
const HEIGHT = /(\d{1,3}(?:\.\d{1,2})?)\s*(?:m|metres?|meters?)\b/g;
const TRAILING = /\s+(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Today|Tonight|January|February|March|April|May|June|July|August|September|October|November|December|And|With|The)\b.*$/;
const PREDICT = /\b(?:may|might|could|likely|expected|forecast|predicted|possible|will|peak(?:s|ing)?\s+(?:near|around|at|above|below)|reach|exceed|rise\s+(?:to|above)|approach)\b/i;

function sentences(text) {
  return String(text || '').replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+(?=[A-Z])|\n+/).map((s) => s.trim()).filter(Boolean);
}

export function parseWarningLevels(text) {
  const out = [];
  let carry = null;
  for (const s of sentences(text)) {
    const locs = [];
    for (const m of s.matchAll(LOC)) {
      const river = m[1].replace(/^(?:The|the)\s+/, '').trim();
      const place = m[2].replace(TRAILING, '').trim();
      if (place) locs.push({ at: m.index, river, place });
    }
    for (const h of s.matchAll(HEIGHT)) {
      const level = parseFloat(h[1]);
      if (!Number.isFinite(level) || level <= 0 || level > 200) continue;
      const before = locs.filter((l) => l.at < h.index);
      const loc = before.length ? before[before.length - 1] : carry;
      if (!loc) continue;
      const from = before.length ? before[before.length - 1].at : 0;
      const lead = s.slice(from, h.index);
      const tail = lead.slice(-80);
      let kind, cls = null;
      const clsM = /\b(minor|moderate|major)\s+flood\s+(?:level|classification)\s*\(\s*$/i.exec(tail);
      if (clsM) { kind = 'class'; cls = clsM[1].toLowerCase(); }
      else if (/\bpeaked\b|\breached\s+(?:a\s+)?peak\b/i.test(tail)) kind = 'peaked';
      else if (/\b(?:currently|is\s+at|was\s+at|now\s+at|steady\s+at|remains?\s+at|sitting\s+at)\b/i.test(tail) && !/\b(?:peak|reach|exceed)\b/i.test(tail.split(/currently|is at|was at|now at/i).pop())) kind = 'now';
      else if (PREDICT.test(tail) || /\bpeak\b/i.test(tail)) kind = 'peak';
      else continue;
      // a class level counts as a target only when the sentence predicts it
      const predicted = kind === 'peak' || (kind === 'class' && PREDICT.test(lead.replace(/\(\s*$/, '')));
      out.push({ river: loc.river, place: loc.place, level, kind, cls, predicted, text: s });
    }
    if (locs.length) carry = locs[locs.length - 1];
  }
  return out;
}

/* One target per place: the highest predicted peak, else the highest class
 * level the warning says the river may reach. */
export function warningTargets(text) {
  const by = new Map();
  for (const x of parseWarningLevels(text)) {
    if (!x.predicted) continue;
    const k = `${x.river.toLowerCase()}|${x.place.toLowerCase()}`;
    const old = by.get(k);
    const rank = (y) => (y.kind === 'peak' ? 1 : 0);
    if (!old || rank(x) > rank(old) || (rank(x) === rank(old) && x.level > old.level)) by.set(k, x);
  }
  return [...by.values()];
}

/* The gauge a target is about: by name ("Blackall", "Barcoo River at
 * Blackall", "Warilda (Langlo River)"), on the same river where the
 * gauge says which river it's on. gauges: GeoJSON features. */
const norm = (s) => String(s || '').toLowerCase().replace(/\briver\b|\bcreek\b|\br\.?\b|\bck\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export function gaugeForTarget(t, gauges, state) {
  const place = norm(t.place), river = norm(t.river).split(' ')[0];
  if (!place) return null;
  let best = null, bestScore = 0;
  for (const f of gauges || []) {
    const p = f.properties || {};
    if (state && p.state && String(p.state).toUpperCase().slice(0, 2) !== String(state).toUpperCase().slice(0, 2)) continue;
    const name = norm(p.name);
    const words = ` ${name} `;
    if (!words.includes(` ${place} `)) continue;
    const onRiver = river && (` ${norm(p.river_name)} ${norm(p.basin)} ${name} `).includes(` ${river} `);
    let score = 1;
    if (name === place || name.startsWith(`${place} `) || name.endsWith(` ${place}`)) score += 1;
    if (onRiver) score += 2;
    if (p.bom != null) score += 1;
    if (p.kind === 'forecast' || p.kind === 'flood') score += 0.5;
    if (score > bestScore) { best = f; bestScore = score; }
  }
  return bestScore >= 2 ? best : null;
}
