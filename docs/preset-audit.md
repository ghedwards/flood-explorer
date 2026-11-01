# River preset gauge audit

Audited 31 October 2026 against [the published complete gauge catalogue](https://ghedwards.github.io/flood-explorer/data/national/gauges.geojson). Reproduce with `node scripts/audit-presets.js gauges.geojson`.

The old basin-name match selected Trevallyn Pond on the South Esk for the Tamar preset at Launceston. River names are now explicit preset metadata, and the selector matches the full watercourse name on the gauge. Carnarvon and Launceston retain their preset coordinates when no suitable nearby gauge exists. Grantham uses Gatton, with its distance called out below.

Catalogue: 3839 gauges. Match the intended river in the gauge name within 8 km; flag anchors beyond 5 km for review.

| Preset | Selected gauge | Distance | Review |
|---|---|---:|---|
| Ipswich, Bremer River (Qld) | Ipswich (Bremer River) | 0.24 km | Within 5 km |
| Logan River, Waterford (Qld) | Waterford (Logan River) | 0.76 km | Within 5 km |
| Grantham, Lockyer Creek (Qld) | Gatton (Lockyer Creek) | 7.77 km | The selected Lockyer Creek gauge is at Gatton, about 7.8 km away; it is not a gauge at Grantham. |
| Gympie, Mary River (Qld) | Gympie (Mary River) | 1.22 km | Within 5 km |
| Maryborough, Mary River (Qld) | Maryborough (Portside Alert) (Mary River) | 0.79 km | Within 5 km |
| Bundaberg, Burnett River (Qld) | Bundaberg (Burnett River) | 0.26 km | Within 5 km |
| Rockhampton, Fitzroy River (Qld) | Rockhampton (Fitzroy River) | 0.70 km | Within 5 km |
| Emerald, Nogoa River (Qld) | Emerald (Nogoa River) | 1.32 km | Within 5 km |
| Mackay, Pioneer River (Qld) | Mackay (Pioneer River) | 0.67 km | Within 5 km |
| Townsville, Ross River (Qld) | Aplin Weir (Ross River) | 2.03 km | Within 5 km |
| Ingham, Herbert River (Qld) | Ingham Pump Station (Herbert River) | 1.75 km | Within 5 km |
| Charleville, Warrego River (Qld) | Charleville (Warrego River) | 0.28 km | Within 5 km |
| St George, Balonne River (Qld) | St George (Balonne River) | 1.11 km | Within 5 km |
| Goondiwindi, Macintyre River (Qld) | Goondiwindi (Macintyre River) | 1.21 km | Within 5 km |
| Lismore, Wilsons River (NSW) | Lismore (Wilsons River) | 0.33 km | Within 5 km |
| Murwillumbah, Tweed River (NSW) | North Murwillumbah (Tweed River) | 0.59 km | Within 5 km |
| Grafton, Clarence River (NSW) | Grafton (Clarence River) | 0.78 km | Within 5 km |
| Kempsey, Macleay River (NSW) | Kempsey (Macleay River) | 0.91 km | Within 5 km |
| Port Macquarie, Hastings River (NSW) | Settlement Point (Hastings River) | 2.45 km | Within 5 km |
| Taree, Manning River (NSW) | Taree (Manning River) | 1.40 km | Within 5 km |
| Maitland, Hunter River (NSW) | Maitland Belmore Bridge (Hunter River) | 0.24 km | Within 5 km |
| Windsor, Hawkesbury River (NSW) | Windsor PWD (Hawkesbury River) | 0.38 km | Within 5 km |
| Liverpool, Georges River (NSW) | Liverpool (Georges River) | 1.38 km | Within 5 km |
| Moree, Mehi River (NSW) | Moree (Mehi River) | 0.68 km | Within 5 km |
| Dubbo, Macquarie River (NSW) | Dubbo (Macquarie River) | 2.91 km | Within 5 km |
| Forbes, Lachlan River (NSW) | Forbes Iron Bridge (Lachlan River) | 1.77 km | Within 5 km |
| Wagga Wagga, Murrumbidgee River (NSW) | Wagga Wagga (Murrumbidgee River) | 0.12 km | Within 5 km |
| Gundagai, Murrumbidgee River (NSW) | Gundagai (Murrumbidgee River) | 1.12 km | Within 5 km |
| Maribyrnong River, Melbourne (Vic) | Maribyrnong (Maribyrnong River) | 1.41 km | Within 5 km |
| Echuca, Murray River (Vic) | Echuca Wharf (Murray River) | 0.58 km | Within 5 km |
| Rochester, Campaspe River (Vic) | Rochester Town (Campaspe River) | 3.31 km | Within 5 km |
| Shepparton, Goulburn River (Vic) | Shepparton (Goulburn River) | 1.49 km | Within 5 km |
| Seymour, Goulburn River (Vic) | Seymour (Goulburn River) | 3.34 km | Within 5 km |
| Benalla, Broken River (Vic) | Benalla (Broken River) | 0.61 km | Within 5 km |
| Kerang, Loddon River (Vic) | Kerang (Murray Valley Highway Bridge) (Loddon River) | 1.05 km | Within 5 km |
| Traralgon, Traralgon Creek (Vic) | Traralgon Town (Traralgon Creek) | 0.40 km | Within 5 km |
| Bairnsdale, Mitchell River (Vic) | Bairnsdale (Mitchell River) | 2.37 km | Within 5 km |
| Murray Bridge, Murray River (SA) | Long Island (Murray Bridge) (River Murray) | 1.35 km | Within 5 km |
| Gawler, Gawler River (SA) | Gawler West (Gosford St) (Gawler River) | 0.01 km | Within 5 km |
| Guildford, Swan River, Perth (WA) | Meadow Street Bridge (Swan River) | 0.64 km | Within 5 km |
| Carnarvon, Gascoyne River (WA) | No suitable gauge; model starts at preset point | — | Nearest published Gascoyne gauge is Nine Mile Bridge, about 12 km away; keep the model centred on Carnarvon. |
| Fitzroy Crossing, Fitzroy River (WA) | Fitzroy Crossing (Fitzroy River) | 1.12 km | Within 5 km |
| Launceston, Tamar River (Tas) | No suitable gauge; model starts at preset point | — | Nearby gauges measure the North Esk and South Esk, not the Tamar; keep the Tamar model at the selected point. |
| Latrobe, Mersey River (Tas) | Latrobe Bridge (Mersey River) | 0.91 km | Within 5 km |
| Huonville, Huon River (Tas) | Huonville (Huon River) | 0.54 km | Within 5 km |
| Katherine, Katherine River (NT) | Katherine Bridge  (Katherine River) | 0.74 km | Within 5 km |

44 of 46 river presets anchored. 0 unexplained exceptions.

A catalogue match checks the selected gauge and distance; it does not validate terrain, gauge datum or model accuracy.
