/* The Tsunami panel's "latest international bulletin": the Pacific Tsunami Warning Center's newest bulletin, as the live-data broker keeps it
 * (rust/flood-feeds/src/tsunami.rs, fetched every 15 minutes). It is NOT an Australian warning. Australia's official tsunami warnings come from the Joint Australian
 * Tsunami Warning Centre (Bureau of Meteorology), whose machine-readable feed is for registered users only, so the panel links to the Bureau instead. A missing, empty or old
 * answer says nothing about whether there is a threat, and the text never suggests otherwise. */

export const BOM_TSUNAMI_URL = 'https://www.bom.gov.au/tsunami/';
const LEVEL_TEXT = { warning: 'Warning', watch: 'Watch', advisory: 'Advisory', information: 'Information statement' };
const HOUR = 3.6e6;
const STALE_FEED_HOURS = 3;     // the broker refreshes every 15 minutes; much older than that and its feed is not updating
const RECENT_HOURS = 24;

export function ageText(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const h = (now - t) / HOUR;
  if (h < 0) return 'just now';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes ago`;
  if (h < 48) return `${Math.round(h)} hours ago`;
  return `${Math.round(h / 24)} days ago`;
}

/* What to show for the broker's `tsunami` document ({ fetched, items }) or null/undefined when the broker did not give one.
 * state: 'unavailable' (nothing usable), 'stale' (the broker's copy is old), 'ok'. Items are newest first, at most three. `active` is a watch, warning or advisory issued
 * in the last 24 hours: the only kind the panel draws attention to. */
export function bulletinView(doc, now = Date.now(), limit = 3) {
  if (!doc || !Array.isArray(doc.items)) return { state: 'unavailable', items: [] };
  const fetched = Date.parse(doc.fetched);
  const items = doc.items.filter((x) => x && LEVEL_TEXT[x.level] && Number.isFinite(Date.parse(x.issued))).slice(0, limit).map((x) => {
    const hours = (now - Date.parse(x.issued)) / HOUR;
    return {
      level: x.level, levelText: LEVEL_TEXT[x.level], region: String(x.region || ''), nearby: x.nearby === true, ageText: ageText(x.issued, now), issued: x.issued,
      magnitudeText: Number.isFinite(x.magnitude) ? `M${x.magnitude.toFixed(1)}` : '', active: x.level !== 'information' && hours <= RECENT_HOURS,
      bulletin: /^https:\/\/www\.tsunami\.gov\//.test(x.bulletin || '') ? x.bulletin : null,
    };
  });
  const stale = !Number.isFinite(fetched) || (now - fetched) / HOUR > STALE_FEED_HOURS;
  return { state: stale ? 'stale' : 'ok', fetchedText: Number.isFinite(fetched) ? ageText(doc.fetched, now) : '', items };
}

/* The panel's HTML. `escape` is the page's HTML escaper; every value that came from the feed goes through it. */
export function bulletinHtml(view, escape) {
  const official = `<a href="${BOM_TSUNAMI_URL}" target="_blank" rel="noopener">Bureau of Meteorology tsunami warnings ↗</a>`;
  const caveat = `<p class="hint">This is an international bulletin from NOAA's Pacific Tsunami Warning Center, not an Australian warning. Australia's official tsunami warnings are issued by the Joint Australian Tsunami Warning Centre (Bureau of Meteorology): ${official}. Not seeing a bulletin here does not mean there is no threat.</p>`;
  if (view.state === 'unavailable') return `<p class="hint">Live bulletins are not available right now.</p>${caveat}`;
  const rows = view.items.map((x) => `<li class="ts-bulletin${x.active ? ' ts-bulletin-active' : ''}"><b>${escape(x.levelText)}</b>${x.magnitudeText ? ` · ${escape(x.magnitudeText)}` : ''} · ${escape(x.region)}${x.nearby ? ' <span class="hint">(western Pacific / Indian Ocean)</span>' : ''}<br><span class="hint">Issued ${escape(x.ageText)}${x.active ? ' · within the last 24 hours' : ''}${x.bulletin ? ` · <a href="${escape(x.bulletin)}" target="_blank" rel="noopener">bulletin ↗</a>` : ''}</span></li>`).join('');
  const none = '<p class="hint">The feed holds no bulletin.</p>';
  const stale = view.state === 'stale' ? `<p class="hint ts-bulletin-stale">The live data service has not refreshed this feed${view.fetchedText ? ` since ${escape(view.fetchedText)}` : ''}; it may be out of date.</p>` : '';
  return `${stale}${rows ? `<ul class="ts-bulletins">${rows}</ul>` : none}${caveat}`;
}
