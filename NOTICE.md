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
| Esri World Imagery basemap | Check Esri's terms before any commercial use | Esri terms |
| Google Flood Hub / Flood Forecasting API (optional, needs an approved key) | Provided under Google's terms and approval; check them | Google |
| Queensland and NSW traffic APIs (optional, need keys) | Provided under each agency's terms and API keys; check them | Agency pages |
| OpenStreetMap tiles, Overpass and Nominatim | Public servers with usage policies that limit heavy and automated use; data is ODbL with attribution | OSM policies |
| Water Data Online rainfall and river data (Bureau, custodians) | Each custodian's terms apply | Bureau and custodians |
| Open government and research data under CC BY 4.0 or similar (Geoscience Australia DEM-H and DEA, Queensland Government, Brisbane City Council, ABS, Maritime Safety Queensland, AIMS and others listed in the [README](README.md#data-and-credits)) | Reuse, including commercial, **with attribution**, under each dataset's stated licence | README credits |

Rows marked "check" are ones I have not read in full. Do not read a missing restriction as
permission.

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
