# Licence, warranty and data terms

Read this before you use, host or rely on Flood Explorer. It is a plain-language summary,
not legal advice, and the providers' own terms always win. Checked against the providers'
pages on 8 November 2026; terms change, so check the source.

## The software: MIT, open source, no warranty

The code is open source under the [MIT licence](LICENSE). You may use, copy, modify and
redistribute it, including under the licence's conditions of keeping the copyright and
licence notice.

> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
> INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR
> PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
> FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
> DEALINGS IN THE SOFTWARE.

The warranty disclaimer covers the whole project: the code, the maps, the models and
everything the site shows.

## Not for emergency, safety or property decisions

Flood Explorer is a screening and learning tool built on coarse terrain (about 30 m) and
simple or experimental models. Results are **indicative only and can be wrong, late or
missing**. It is not an official warning or forecast. Do not use it to decide whether to
evacuate, to value, buy, insure, build or design anything, or to plan emergency response.
Use your council's flood maps, Bureau of Meteorology warnings and your State Emergency
Service (132 500; 000 in an emergency). Never enter floodwater. The radar forecast is a
made-up extrapolation of the latest rain picture and has not been tested on real rain.

## Not for commercial use

**This project, as published and hosted, is for non-commercial use only**, because it uses
data feeds whose terms do not allow commercial use. The MIT licence covers the *code*; it
does not give you any rights to the *data* the code fetches, and it does not override the
data providers' terms. So the code is free to reuse, but a service built from it that
pulls those feeds is not free to be run commercially.

| Feed the project uses | What its terms say | Source |
|---|---|---|
| Bureau of Meteorology anonymous data (warnings, river heights, readings by FTP) | "Free to access and **not for commercial use**"; customers needing continuity are pointed to the Bureau's Registered User Services | Bureau data-feeds page |
| Bureau of Meteorology website pages and radar images | Automated scraping is not allowed; radar images "may be subject to a data licence agreement"; commercial reuse needs written permission. This project's code does not scrape the Bureau's website or fetch its radar. | Bureau copyright page |
| RainViewer radar overlay on the map | The free API is for **personal and educational use**; past frames only, rate limited | RainViewer API pages |
| Esri World Imagery basemap | Licensed under the Esri Master License Agreement; the layer is not intended for exporting tiles for offline use. Read the agreement before any commercial use. | Esri item page |
| CARTO basemap tiles (the Streets basemap) | Free for non-commercial use up to 5 million requests a month; commercial use needs a registered commercial plan | CARTO basemaps page |
| Google Flood Hub / Flood Forecasting API (optional, needs an approved key) | Data offered at no charge under CC BY 4.0 (attribution), with access by approved key | Google developer page |
| QLDTraffic road events (optional) | The site's content "may only be used for personal or non-commercial purposes" except content specifically licensed CC BY 3.0 Australia; the developer page did not state the API data's licence, so treat it as non-commercial until confirmed | QLDTraffic copyright page |
| NSW Transport open data (optional, needs a key) | CC BY 4.0 unless otherwise stated, with attribution; an acceptable use policy and portal terms also apply | NSW Open Data data licence |
| OpenStreetMap tiles | No bulk downloading, prefetching or offline-area features; commercial services are warned access can be withdrawn at any time | OSM tile usage policy |
| Nominatim address search | At most 1 request a second and no heavy use; commercial applications are warned not to rely on it for paying customers | OSM Nominatim policy |
| Queensland Government address service (pick list while typing) | Public suggest and find endpoints that need no key; the service's own licence and usage limits were not found, so treat the service as for light, non-commercial use and check with the Queensland Government before any commercial use | Queensland Government spatial services |
| Overpass (buildings, roads and other OpenStreetMap data) | Commercial use should use self-hosted or paid Overpass servers; the data is ODbL with attribution | OSM wiki |
| Water Data Online rainfall and river data (Bureau, custodians) | Each custodian's terms apply | Bureau and custodians |
| Open government and research data under CC BY 4.0 or similar (Geoscience Australia DEM-H and DEA, Queensland Government, Brisbane City Council, ABS, Maritime Safety Queensland, AIMS and others listed in the [README](README.md#data-and-credits)) | Reuse, including commercial, **with attribution**, under each dataset's stated licence | README credits |

Read on 8 November 2026: the Bureau, RainViewer, Esri item, CARTO, OpenStreetMap policies, QLDTraffic copyright,
NSW data licence and Google's developer page. Not read in full: Esri's master agreement, Water Data Online's
per-custodian terms, the NSW portal terms PDF and the Google API terms. Do not read a missing restriction as permission.

## If you host your own copy

You are responsible for the data you serve and the terms you accept:

- Keep it non-commercial, or switch off the feeds above and obtain licences for what you use
  (for example the Bureau's Registered User Services, or a commercial radar provider).
- The broker never fetches radar. The optional `/v1/radar` endpoint serves a folder you fill,
  and you must have the right to serve what you put there (see [broker/README.md](broker/README.md)).
- Keep the attribution the licences require (see [README](README.md#data-and-credits)).
- Passing the project's MIT licence on to users does not pass on any data rights.

Changing the project's own licence to forbid commercial use of the code is a decision for
its owner. Today the code is MIT, which allows commercial use of the code; the
non-commercial limit above comes from the data.
