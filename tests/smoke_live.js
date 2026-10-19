// Exercise the live map, retaining screenshots and CI annotations.
// Usage: node tests/smoke_live.js [site URL]
const { chromium } = require("playwright");
const { appendFileSync } = require("node:fs");
const { isDeepStrictEqual } = require("node:util");

// Visual regression helper: capture the map region and compare against the
// baseline in tests/visual/<name>.png. A missing baseline seeds one (pass);
// UPDATE_VISUALS=1 rewrites baselines; a mismatch over threshold fails.
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch").default ?? require("pixelmatch");
const fs = require("node:fs");
const path = require("node:path");
const VIS_DIR = path.join(__dirname, "visual");
function snapVisual(name, page, failures) {
  return (async () => {
    fs.mkdirSync(VIS_DIR, { recursive: true });
    const buf = await page.screenshot({ fullPage: false });
    const cur = PNG.sync.read(buf);
    const base = path.join(VIS_DIR, name + ".png");
    if (!fs.existsSync(base) || process.env.UPDATE_VISUALS === "1") {
      fs.writeFileSync(base, buf);
      note("notice", `visual: seeded baseline ${name}`);
      return;
    }
    const baseImg = PNG.sync.read(fs.readFileSync(base));
    if (baseImg.width !== cur.width || baseImg.height !== cur.height) {
      fs.writeFileSync(path.join(VIS_DIR, name + ".actual.png"), buf);
      failures.push(`visual ${name}: size mismatch ${baseImg.width}x${baseImg.height} vs ${cur.width}x${cur.height}`);
      return;
    }
    const diff = new PNG({ width: cur.width, height: cur.height });
    const mismatched = pixelmatch(baseImg.data, cur.data, diff.data, cur.width, cur.height, { threshold: 0.1, ignoreAntialiasing: true });
    const frac = mismatched / (cur.width * cur.height);
    if (frac > 0.005) {
      fs.writeFileSync(path.join(VIS_DIR, name + ".actual.png"), buf);
      fs.writeFileSync(path.join(VIS_DIR, name + ".diff.png"), PNG.sync.write(diff));
      failures.push(`visual ${name}: ${Math.round(frac * 10000) / 100}% pixels differ (threshold 0.5%)`);
    }
  })();
}


// Empty collections in status responses count as missing data.
function truth(value) {
  if (Array.isArray(value) || typeof value === "string")
    return value.length > 0;
  if (value && Object.getPrototypeOf(value) === Object.prototype)
    return Object.keys(value).length > 0;
  return Boolean(value);
}
function get(object, key, fallback = null) {
  return Object.hasOwn(object, key) ? object[key] : fallback;
}
function startsWith(text, prefixes) {
  return Array.isArray(prefixes)
    ? prefixes.some((p) => text.startsWith(p))
    : text.startsWith(prefixes);
}
function formatValue(value) {
  return value && typeof value === "object"
    ? JSON.stringify(value)
    : String(value);
}
function appendSummary(text) {
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}

const URL = process.argv[2] || "http://localhost:8000/";
var KEY = [];
var KEY_WORDS = [
  "New tools",
  "Data status",
  "Offline reload",
  "Council layers",
  "Sea levels",
  "Storm pipes",
  "Rating at",
  "First load",
  "Keyboard",
  "Tides at",
  "Sea reached",
  "Recorded flood over time",
  "Flood over time",
  "Levees",
  "Storm tide",
  "Presets checked",
  "Recorded floods",
  "Best match",
  "Impact",
  "Storm",
  "Joined",
  "Share link",
  "Satellite check",
  "Presets anchored",
  "Presets on LiDAR",
  "Phone Layers",
  "Council layer",
  "Downloads",
  "Rain radar",
  "Address search",
  "Flood warnings",
  "Echuca",
  "Extended model",
  "Area study",
];
function note(level, msg) {
  if (level === "notice") {
    console.log(msg);
    if (truth(startsWith(msg, KEY_WORDS))) {
      KEY.push(msg.slice(0, 900));
    }
    return undefined;
  }
  console.log(`::${formatValue(level)}::${formatValue(msg)}`);
}
async function main() {
  var failures = [];
  const browser = await chromium.launch();
  try {
    var page = await browser.newPage({
      viewport: { width: 1280, height: 900 },
    });
    var errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) =>
      m.type() === "error" ? errors.push(m.text()) : null,
    );
    await page.goto(URL, { waitUntil: "networkidle", timeout: 90000 });
    var status = async () => await page.evaluate("window.__floodStatus || {}");
    // ---- Australia-wide view (the default)
    try {
      await page.waitForFunction(
        "window.__floodStatus && window.__floodStatus.national && window.__floodStatus.national.loaded && window.__floodStatus.mode === 'map'",
        null,
        { timeout: 60000 },
      );
      var nat = get(await status(), "national", {});
      // first load: how long until the map was ready, and what it downloaded
      var load = await page.evaluate(() => {
        const nav = performance.getEntriesByType("navigation")[0] || {};
        const res = performance.getEntriesByType("resource");
        const own = res.filter((r) => r.name.includes(location.host));
        const kb = (list) =>
          Math.round(
            list.reduce((s, r) => s + (r.transferSize || 0), 0) / 1024,
          );
        const big = own
          .slice()
          .sort((x, y) => (y.transferSize || 0) - (x.transferSize || 0))
          .slice(0, 4)
          .map(
            (r) =>
              `${r.name.split("/").pop()} ${Math.round((r.transferSize || 0) / 1024)} KB`,
          );
        return {
          domReadyMs: Math.round(nav.domContentLoadedEventEnd || 0),
          mapReadyMs: Math.round(performance.now()),
          ownKB: kb(own),
          allKB: kb(res),
          requests: res.length,
          biggest: big,
        };
      });
      note("notice", `First load: ${formatValue(JSON.stringify(load))}`);
      // the flood model: Rust compiled to WebAssembly (JavaScript if it can't load)
      try {
        await page.waitForFunction(
          "window.__floodStatus.engine === 'rust'",
          null,
          { timeout: 15000 },
        );
      } catch (error) {
        // A timeout is assessed by the checks below.
      }
      var engine = await page.evaluate("window.__floodStatus.engine");
      if (engine === "rust") {
        note("notice", "Flood model: Rust (WebAssembly)");
      } else {
        failures.push(
          `the Rust flood model did not load (engine: ${formatValue(engine)})`,
        );
      }
      // keyboard: Tab reaches the map, and Enter on it looks at the middle
      await page.focus("#lmap");
      await page.keyboard.press("Enter");
      await page.waitForTimeout(800);
      var pop = await page.evaluate(
        "!!document.querySelector('.leaflet-popup .spot-add, .leaflet-popup')",
      );
      note(
        truth(pop) ? "notice" : "warning",
        `Keyboard: Enter on the map ${formatValue(truth(pop) ? "opens" : "did not open")} the spot popup`,
      );
      await page.keyboard.press("Escape");
      // fluid wheel zoom: zooms in around the cursor in small steps
      var z0 = await page.evaluate("window.__floodZoom()");
      await page.mouse.move(640, 450);
      for (var _ = 0; _ < 3; _++) {
        await page.mouse.wheel(0, -120);
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(1200);
      var z1 = await page.evaluate("window.__floodZoom()");
      console.log(`Wheel zoom: ${formatValue(z0)} -> ${formatValue(z1)}`);
      if (!truth(z1 > z0 + 0.5 && z1 < z0 + 3)) {
        failures.push(
          `smooth wheel zoom did not zoom in as expected: ${formatValue(z0)} -> ${formatValue(z1)}`,
        );
      }
      await page.mouse.move(640, 450);
      for (_ = 0; _ < 3; _++) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(60);
      }
      await page.waitForTimeout(1200);
      note("notice", `National view: ${formatValue(JSON.stringify(nat))}`);
      if (!truth(get(nat, "gauges"))) {
        failures.push("the national view has no gauges");
      }
    } catch (error) {
      failures.push(
        `the national view did not load: ${formatValue(JSON.stringify(await status()))}`,
      );
    }
    // zoomed out over Australia: the stitched water image and scaled DEA tiles
    await page.evaluate(async () => {
      await window.__floodTestZoom(-26.5, 134, 5);
    });
    var name = "Water seen by satellite since 1987 (DEA)";
    await page.evaluate(
      async (...args) => {
        await (([n]) => window.__floodSetOverlay(n, true))(...args);
      },
      [name],
    );
    await page.waitForTimeout(6000);
    var st = await page.evaluate(
      (n) => window.__floodStatus.overlays[n] || {},
      name,
    );
    if (!truth(get(st, "image"))) {
      failures.push(
        `national water image did not show at zoom 5: ${formatValue(st)}`,
      );
    }
    await page.screenshot({ path: "smoke-z5-water.png" });
    await page.evaluate(
      async (...args) => {
        await (([n]) => window.__floodSetOverlay(n, false))(...args);
      },
      [name],
    );
    var dea = "Latest satellite, infrared (DEA)";
    await page.evaluate(async (...args) => {
      await ((n) => window.__floodSetBasemap(n))(...args);
    }, dea);
    try {
      await page.waitForFunction(
        `window.__floodStatus.basemaps[${formatValue(JSON.stringify(dea))}].loaded > 0`,
        null,
        { timeout: 40000 },
      );
    } catch (error) {
      // A timeout is assessed by the checks below.
    }
    var bst = await page.evaluate((n) => window.__floodStatus.basemaps[n], dea);
    if (!truth(bst) || !truth(get(bst, "loaded"))) {
      failures.push(`DEA basemap drew nothing at zoom 5: ${formatValue(bst)}`);
    }
    await page.screenshot({ path: "smoke-z5-dea.png" });
    await page.evaluate(async (...args) => {
      await ((n) => window.__floodSetBasemap(n))(...args);
    }, "Satellite (Esri)");
    console.log(
      `Zoomed-out checks: water image ${formatValue(st)}, DEA basemap ${formatValue(bst)}`,
    );
    appendSummary(
      `- Zoom 5: water image ${formatValue(JSON.stringify(st))}; DEA basemap ${formatValue(JSON.stringify(bst))}\n`,
    );
    if (
      truth(
        await page.evaluate(
          "window.__floodOpenReport ? window.__floodOpenReport(0) : false",
        ),
      )
    ) {
      await page.waitForTimeout(500);
      var rep = ((await page.textContent("#reportBody")) || "")
        .trim()
        .replaceAll(
          `
`,
          " ",
        );
      note("notice", `Report: ${formatValue(rep.slice(0, 260))}`);
    }
    await page.screenshot({ path: "smoke-national.png" });
    await snapVisual("national", page, failures);
    if (
      truth(
        await page.evaluate(
          "window.__floodOpenDam ? window.__floodOpenDam('Wivenhoe') : false",
        ),
      )
    ) {
      try {
        await page.waitForFunction(
          "window.__floodStatus.waterbodies && window.__floodStatus.waterbodies.ok !== undefined",
          null,
          { timeout: 30000 },
        );
      } catch (error) {
        // A timeout is assessed by the checks below.
      }
      var wb = get(await status(), "waterbodies", {});
      var dam = ((await page.textContent("#reportBody")) || "")
        .trim()
        .replaceAll(
          `
`,
          " ",
        );
      // coverage builds up over several runs, so a missing dam is a warning
      note(
        truth(get(wb, "ok")) ? "notice" : "warning",
        `Dam report water history ${formatValue(JSON.stringify(wb))}: ${formatValue(dam.slice(0, 300))}`,
      );
      await page.screenshot({ path: "smoke-dam.png" });
      rep = get(await status(), "report", {});
      if (get(rep, "count", 0) < 2) {
        failures.push(`expected two reports side by side: ${formatValue(rep)}`);
      }
      console.log(`Reports open: ${formatValue(rep)}`);
    }
    // NSW flood planning layer over Sydney's Parramatta River
    await page.evaluate(async () => {
      await (window.__floodTestZoom &&
        window.__floodTestZoom(-33.815, 151.0, 14));
    });
    await page.evaluate(
      async (...args) => {
        await (([n]) => window.__floodSetOverlay(n, true))(...args);
      },
      ["NSW flood planning areas (state)"],
    );
    await page.waitForTimeout(8000);
    var nsw = await page.evaluate(
      "window.__floodStatus.overlays['NSW flood planning areas (state)'] || null",
    );
    note(
      truth(nsw) && truth(get(nsw, "features")) ? "notice" : "error",
      `NSW layer at Parramatta: ${formatValue(JSON.stringify(nsw))}`,
    );
    if (!truth(truth(nsw) && truth(get(nsw, "features")))) {
      failures.push(
        `NSW flood planning layer did not draw: ${formatValue(nsw)}`,
      );
    }
    await page.screenshot({ path: "smoke-nsw.png" });
    // and zoomed out to the Sydney region, beyond the server's own limit
    var before_nsw = truth(nsw) ? get(nsw, "features", 0) : 0;
    await page.evaluate(async () => {
      await window.__floodTestZoom(-33.8, 151.0, 9);
    });
    await page.waitForTimeout(8000);
    var nsw9 = await page.evaluate(
      "window.__floodStatus.overlays['NSW flood planning areas (state)'] || null",
    );
    note("notice", `NSW layer at zoom 9: ${formatValue(JSON.stringify(nsw9))}`);
    if (!truth(truth(nsw9) && get(nsw9, "features", 0) > before_nsw)) {
      failures.push(
        `NSW flood planning layer did not draw zoomed out: ${formatValue(nsw9)}`,
      );
    }
    await page.screenshot({ path: "smoke-nsw-z9.png" });
    await page.evaluate(
      async (...args) => {
        await (([n]) => window.__floodSetOverlay(n, false))(...args);
      },
      ["NSW flood planning areas (state)"],
    );
    for (var [label, args] of [
      ["river", [-27.4741, 153.0305, { kind: "river", name: "Brisbane City" }]],
      ["coast", [-27.37, 153.17, { kind: "coast", name: "Brisbane Bar" }]],
    ]) {
      var before_updates = get(await status(), "overlayUpdates", 0);
      await page.evaluate(async (...args) => {
        await (([la, lo, o]) => {
          window.__floodModelHere(la, lo, o);
        })(...args);
      }, args);
      try {
        await page.waitForFunction(
          "window.__floodStatus.local && (window.__floodStatus.local.ok === true || window.__floodStatus.local.ok === false)",
          null,
          { timeout: 120000 },
        );
        await page.waitForFunction(
          `window.__floodStatus.overlayUpdates > ${formatValue(before_updates)}`,
          null,
          { timeout: 20000 },
        );
      } catch (error) {
        // A timeout is assessed by the checks below.
      }
      var loc = get(await status(), "local", {});
      var stats = (await page.innerText("#stats")).replaceAll(
        `
`,
        " ",
      );
      note(
        truth(get(loc, "ok")) ? "notice" : "error",
        `Model ${formatValue(label)}: ${formatValue(JSON.stringify(loc))} | ${formatValue(stats.slice(0, 160))}`,
      );
      if (!truth(get(loc, "ok"))) {
        failures.push(
          `on-demand ${formatValue(label)} model failed: ${formatValue(loc)}`,
        );
      }
      await page.screenshot({ path: `smoke-model-${formatValue(label)}.png` });
    }
    // ---- both modelled areas stay on the map; switch back to the first
    var areas = await page.evaluate(
      "window.__floodAreaInfo ? window.__floodAreaInfo() : []",
    );
    if (areas.length < 2 || !truth(areas.map((a) => a["drawn"]).every(truth))) {
      failures.push(`expected two drawn modelled areas: ${formatValue(areas)}`);
    }
    if (truth(areas)) {
      await page.evaluate(async (...args) => {
        await ((k) => window.__floodActivateArea(k))(...args);
      }, areas[0]["key"]);
      await page.waitForTimeout(800);
      var after_switch = await page.evaluate("window.__floodAreaInfo()");
      if (!truth(after_switch[0]["active"])) {
        failures.push(
          `switching back to the first area failed: ${formatValue(after_switch)}`,
        );
      }
      var stats_first = (await page.innerText("#stats")).replaceAll(
        `
`,
        " ",
      );
      console.log(
        `Areas: ${formatValue(areas)}; after switch ${formatValue(after_switch)}; stats ${formatValue(stats_first)}`,
      );
      appendSummary(`- Areas: ${formatValue(JSON.stringify(after_switch))}\n`);
    }
    await page.screenshot({ path: "smoke-two-areas.png" });
    // ‹ › in the Scenario panel select the next modelled place; Places follows
    if (areas.length >= 2) {
      var act0 = (await page.evaluate("window.__floodAreaInfo()"))
        .filter((a) => truth(a["active"]))
        .map((a) => a["key"]);
      await page.locator("#scenarioNext").click();
      await page.waitForTimeout(800);
      var act1 = (await page.evaluate("window.__floodAreaInfo()"))
        .filter((a) => truth(a["active"]))
        .map((a) => a["key"]);
      var sel = await page.evaluate("window.__floodStatus.selectedPlace");
      if (isDeepStrictEqual(act0, act1) || sel === null) {
        failures.push(
          `Scenario › did not move to the next flood scenario: ${formatValue(act0)} -> ${formatValue(act1)}, selected ${formatValue(sel)}`,
        );
      }
      console.log(
        `Scenario step: ${formatValue(act0)} -> ${formatValue(act1)}, selected ${formatValue(sel)}`,
      );
    }
    // ---- a model started from a report shares the report's number,
    //      and the number can be hidden and shown from Places
    await page.evaluate(async () => {
      await window.__floodOpenPanel("panel-report");
    });
    var dam_btn = page
      .locator(".report-card", { hasText: "Wivenhoe" })
      .locator(".js-model");
    if (truth(await dam_btn.count())) {
      var before_key = get(get(await status(), "local") || {}, "key");
      await dam_btn.first().click();
      try {
        await page.waitForFunction(
          `window.__floodStatus.local && window.__floodStatus.local.ok !== undefined && window.__floodStatus.local.key !== ${formatValue(JSON.stringify(before_key))}`,
          null,
          { timeout: 120000 },
        );
        await page.waitForFunction(
          "window.__floodAreaInfo().every(a => a.drawn)",
          null,
          { timeout: 20000 },
        );
      } catch (error) {
        // A timeout is assessed by the checks below.
      }
      var places = await page.evaluate("window.__floodPlaces()");
      var linked = places
        .filter((p) => truth(truth(p["report"]) && truth(p["area"])))
        .map((p) => p);
      if (
        !truth(linked) ||
        !(get(linked[0], "reportName") || "").includes("Wivenhoe")
      ) {
        failures.push(
          `model from the Wivenhoe report did not share its number: ${formatValue(places)}`,
        );
      } else {
        var n = linked[0]["n"];
        await page.evaluate(async (...args) => {
          await ((n) => window.__floodSetPlaceHidden(n, true))(...args);
        }, n);
        var hid = (await page.evaluate("window.__floodPlaces()"))
          .filter((p) => truth(p["n"] === n))
          .map((p) => p)[0];
        await page.evaluate(async (...args) => {
          await ((n) => window.__floodSetPlaceHidden(n, false))(...args);
        }, n);
        var shown = (await page.evaluate("window.__floodPlaces()"))
          .filter((p) => truth(p["n"] === n))
          .map((p) => p)[0];
        if (hid["onMap"] || !truth(hid["hidden"]) || !truth(shown["onMap"])) {
          failures.push(
            `hiding/showing place ${formatValue(n)} failed: hidden=${formatValue(hid)} shown=${formatValue(shown)}`,
          );
        }
        console.log(
          `Places: ${formatValue(places)}; hide->${formatValue(hid)}; show->${formatValue(shown)}`,
        );
        // the Places panel reaches the report and the flood scenario
        await page.evaluate(async () => {
          await window.__floodSetPlacesCollapsed(false);
        });
        await page.waitForTimeout(300);
        if (!truth(await page.locator("#areaList").isVisible())) {
          failures.push("the Places list is not visible");
        }
        await page.evaluate(async () => {
          await window.__floodOpenPanel("panel-layers");
        });
        await page
          .locator(
            `#placesCard [data-act='report'][data-n='${formatValue(n)}']`,
          )
          .click();
        await page.waitForTimeout(400);
        var rep_open =
          truth(await page.locator("#panel-report").isVisible()) &&
          truth(await page.locator("#areaList").isVisible());
        // choosing the row works like tapping its number on the map
        await page
          .locator(`#placesCard [data-num='${formatValue(n)}']`)
          .click();
        await page.waitForTimeout(800);
        if ((await page.evaluate("window.__floodStatus.selectedPlace")) !== n) {
          failures.push(
            `choosing place ${formatValue(n)} in Places did not select it`,
          );
        }
        var scen_open =
          truth(await page.locator("#panel-scenario").isVisible()) &&
          truth(await page.locator("#areaList").isVisible());
        var title = (await page.textContent("#scenarioPlace")) || "";
        if (
          !truth(
            truth(rep_open) &&
              truth(scen_open) &&
              truth(startsWith(title, `${formatValue(n)}.`)),
          )
        ) {
          failures.push(
            `Places actions failed: report panel ${formatValue(rep_open)}, scenario panel ${formatValue(scen_open)}, title ${JSON.stringify(title)}`,
          );
        }
        console.log(
          `Places actions: report ${formatValue(rep_open)}, scenario ${formatValue(scen_open)}, title ${JSON.stringify(title)}`,
        );
        appendSummary(`- Places: ${formatValue(JSON.stringify(places))}\n`);
      }
      await page.evaluate(async () => {
        await window.__floodOpenPanel("panel-scenario");
      });
      await page.screenshot({ path: "smoke-places.png" });
    } else {
      failures.push("no Wivenhoe report card to model from");
    }
    // ---- detailed Brisbane model
    await page.selectOption("#area", "brisbane");
    await page.evaluate(async () => {
      await window.__floodOpenPanel("panel-scenario");
    });
    try {
      await page.waitForFunction(
        "window.__floodStatus && window.__floodStatus.area === 'brisbane' && window.__floodStatus.mode === 'map' && window.__floodAreaInfo().some(a => a.key === 'brisbane' && a.active && a.drawn)",
        null,
        { timeout: 60000 },
      );
    } catch (error) {
      failures.push(
        `street map did not finish loading: ${formatValue(JSON.stringify(await status()))}`,
      );
    }
    var s1 = await status();
    var fhs = get(s1, "floodhub") || {};
    var fh_text = ((await page.textContent("#floodhubBody")) || "")
      .trim()
      .replaceAll(
        `
`,
        " ",
      );
    note(
      "notice",
      `Flood Hub panel (${formatValue(JSON.stringify(fhs))}): ${formatValue(fh_text.slice(0, 200))}`,
    );
    if (!truth(get(fhs, "loaded"))) {
      failures.push("the Flood Hub forecast file did not load");
    }
    var area = await page.$eval(
      "#area",
      (e) => e.options[e.selectedIndex].textContent,
    );
    var stats_2011 = (await page.innerText("#stats")).replaceAll(
      `
`,
      " ",
    );
    if (get(s1, "mode") === "map") {
      var box = await page.locator("#lmap").boundingBox();
      await page.evaluate(async () => {
        await window.__floodTapAt(-27.52, 152.98);
      });
      try {
        await page.waitForSelector(".leaflet-popup-content", { timeout: 5000 });
        var popup = await page.innerText(".leaflet-popup-content");
      } catch (error) {
        popup = "";
        failures.push("tapping the map did not open a popup");
      }
      var before = await status();
      await page.click("#events .chip:nth-child(5)");
      try {
        await page.waitForFunction(
          `window.__floodStatus.overlayUpdates > ${formatValue(get(before, "overlayUpdates", 0))}`,
          null,
          { timeout: 10000 },
        );
      } catch (error) {
        failures.push("changing the scenario did not redraw the flood layer");
      }
      await page.waitForTimeout(500);
      var after = await status();
      if (get(after, "floodPixels", 0) <= get(before, "floodPixels", 0)) {
        failures.push(
          `1893 should flood more than 2011: ${formatValue(get(before, "floodPixels"))} -> ${formatValue(get(after, "floodPixels"))}`,
        );
      }
      // moving the gauge onto a small creek must not be possible
      await page.evaluate(async () => {
        await window.__floodOpenPanel("panel-layers");
      });
      await page.check("#moveGauge");
      await page.evaluate(async () => {
        await window.__floodTapAt(-27.52, 152.98);
      });
      await page.waitForTimeout(500);
      var moved = await page.innerText("#readout");
      note("notice", `Tap with gauge moving on: ${formatValue(moved)}`);
      if (moved.includes("Gauge moved") && moved.includes("dry")) {
        failures.push(`gauge moved onto dry ground: ${formatValue(moved)}`);
      }
      await page.uncheck("#moveGauge");
      await page.evaluate(async () => {
        await window.__floodOpenPanel("panel-scenario");
      });
      // every basemap in the switcher should load tiles at Brisbane
      var names = await page.evaluate(
        "Object.keys(window.__floodStatus.basemaps || {})",
      );
      for (name of names) {
        await page.evaluate(async (...args) => {
          await ((n) => window.__floodSetBasemap(n))(...args);
        }, name);
        try {
          await page.waitForFunction(
            `window.__floodStatus.basemaps[${formatValue(JSON.stringify(name))}].loaded > 0`,
            null,
            { timeout: 25000 },
          );
        } catch (error) {
          // A timeout is assessed by the checks below.
        }
        st = await page.evaluate((n) => window.__floodStatus.basemaps[n], name);
        note(
          "notice",
          `Basemap ${formatValue(name)}: ${formatValue(st["loaded"])} tiles loaded, ${formatValue(st["errors"])} errors`,
        );
        if (st["loaded"] === 0) {
          failures.push(
            `basemap '${formatValue(name)}' loaded no tiles (${formatValue(st["errors"])} errors)`,
          );
        }
        var safe = Array.from(name.toLowerCase())
          .map((ch) => (truth(/^[\p{L}\p{N}]+$/u.test(ch)) ? ch : "-"))
          .join("");
        await page.screenshot({ path: `smoke-${formatValue(safe)}.png` });
      }
      if (truth(names)) {
        await page.evaluate(async (...args) => {
          await ((n) => window.__floodSetBasemap(n))(...args);
        }, names[0]);
      }
      // council likelihood layers zoomed out: pre-rendered images
      await page.evaluate(async () => {
        await (window.__floodTestZoom &&
          window.__floodTestZoom(-27.47, 153.02, 11));
      });
      await page.waitForTimeout(1500);
      for (name of [
        "Creek flooding likelihood (council)",
        "Overland flow likelihood (council)",
      ]) {
        await page.evaluate(
          async (...args) => {
            await (([n]) => window.__floodSetOverlay(n, true))(...args);
          },
          [name],
        );
        await page.waitForTimeout(5000);
        st = await page.evaluate(
          (n) => window.__floodStatus.overlays[n] || {},
          name,
        );
        note(
          truth(get(st, "image")) ? "notice" : "error",
          `Layer ${formatValue(name)} at zoom 11: ${formatValue(JSON.stringify(st))}`,
        );
        if (!truth(get(st, "image"))) {
          failures.push(
            `council layer '${formatValue(name)}' did not show its zoomed-out image`,
          );
        }
        safe = Array.from(name.toLowerCase())
          .map((ch) => (truth(/^[\p{L}\p{N}]+$/u.test(ch)) ? ch : "-"))
          .join("")
          .slice(0, 30);
        await page.screenshot({ path: `smoke-z11-${formatValue(safe)}.png` });
        await page.evaluate(
          async (...args) => {
            await (([n]) => window.__floodSetOverlay(n, false))(...args);
          },
          [name],
        );
      }
      // council flood layers close in: switch each one on
      await page.evaluate(async () => {
        await (window.__floodTestZoom &&
          window.__floodTestZoom(-27.47, 153.02, 15));
      });
      await page.waitForTimeout(2000);
      var elsewhere = [
        ...new Set(
          (
            await page.evaluate(
              "window.__floodCouncilLayers ? window.__floodCouncilLayers() : []",
            )
          ).map((c) => c["name"]),
        ),
      ];
      var ov = (
        await page.evaluate("Object.keys(window.__floodStatus.overlays || {})")
      )
        .filter((n) => truth(!elsewhere.includes(n)))
        .map((n) => n);
      if (!truth(ov)) {
        failures.push("no council flood layers were offered");
      }
      for (name of ov) {
        await page.evaluate(
          async (...args) => {
            await (([n]) => window.__floodSetOverlay(n, true))(...args);
          },
          [name],
        );
        await page.waitForTimeout(8000);
        st = await page.evaluate((n) => window.__floodStatus.overlays[n], name);
        note(
          "notice",
          `Layer ${formatValue(name)}: ${formatValue(st["features"])} features, ${formatValue(st["errors"])} errors`,
        );
        if (st["features"] === 0) {
          failures.push(
            `council layer '${formatValue(name)}' drew no features (${formatValue(st["errors"])} errors)`,
          );
        }
        safe = Array.from(name.toLowerCase())
          .map((ch) => (truth(/^[\p{L}\p{N}]+$/u.test(ch)) ? ch : "-"))
          .join("")
          .slice(0, 40);
        await page.screenshot({ path: `smoke-layer-${formatValue(safe)}.png` });
        await page.evaluate(
          async (...args) => {
            await (([n]) => window.__floodSetOverlay(n, false))(...args);
          },
          [name],
        );
      }
      // other councils' flood layers, each at its own test spot
      var drawn = [];
      for (var c of await page.evaluate(
        "window.__floodCouncilLayers ? window.__floodCouncilLayers() : []",
      )) {
        if (!truth(get(c, "test"))) {
          continue;
        }
        var [lat, lon] = c["test"];
        await page.evaluate(
          async (...args) => {
            await (([la, lo, z]) =>
              window.__floodTestZoom && window.__floodTestZoom(la, lo, z))(
              ...args,
            );
          },
          [lat, lon, Math.max(14, (get(c, "minZoom") || 12) + 2)],
        );
        await page.waitForTimeout(1500);
        await page.evaluate(
          async (...args) => {
            await (([n]) => window.__floodSetOverlay(n, true))(...args);
          },
          [c["name"]],
        );
        try {
          await page.waitForFunction(
            (n) => (window.__floodStatus.overlays[n] || {}).features > 0,
            c["name"],
            { timeout: 25000 },
          );
        } catch (error) {
          // A timeout is assessed by the checks below.
        }
        st =
          (await page.evaluate(
            (n) => window.__floodStatus.overlays[n],
            c["name"],
          )) || {};
        drawn.push(
          `${formatValue(c["name"])}: ${formatValue(get(st, "features", 0))}/${formatValue(get(st, "errors", 0))}`,
        );
        if (!truth(get(st, "features"))) {
          note(
            "warning",
            `Council layer ${formatValue(c["name"])} drew nothing at its test spot (${formatValue(get(st, "errors", 0))} errors)`,
          );
        }
        await page.evaluate(
          async (...args) => {
            await (([n]) => window.__floodSetOverlay(n, false))(...args);
          },
          [c["name"]],
        );
      }
      note("notice", "Council layers (drawn/errors): " + drawn.join(" | "));
      await page.click("#events .chip:nth-child(3)");
      await page.waitForTimeout(800);
    } else {
      [popup, after] = ["", s1];
    }
    // ---- a pin dropped on the map becomes a place; modelling it keeps its number
    await page.selectOption("#area", "australia");
    await page.waitForTimeout(1500);
    // a gauge dot shows a popup with an add button instead of adding itself
    var reps_before = get(get(await status(), "report") || {}, "count", 0);
    if (
      truth(
        await page.evaluate(
          "window.__floodTapDot ? window.__floodTapDot('forecast', 5) : false",
        ),
      )
    ) {
      await page.waitForTimeout(400);
      var dot_popup = page.locator(".spot-popup .spot-name");
      var reps_mid = get(get(await status(), "report") || {}, "count", 0);
      await page.screenshot({ path: "smoke-dot-popup.png" });
      if (!truth(await dot_popup.count()) || reps_mid !== reps_before) {
        failures.push(
          `gauge dot popup missing or added a report on tap: popup ${formatValue(await dot_popup.count())}, reports ${formatValue(reps_before)}->${formatValue(reps_mid)}`,
        );
      } else {
        await page.locator(".spot-popup .spot-add").first().click();
        await page.waitForTimeout(500);
        var reps_after = get(get(await status(), "report") || {}, "count", 0);
        if (reps_after !== reps_before + 1) {
          failures.push(
            `adding a gauge from its popup did not open a report: ${formatValue(reps_before)}->${formatValue(reps_after)}`,
          );
        }
        console.log(
          `Dot popup: reports ${formatValue(reps_before)}->${formatValue(reps_after)}`,
        );
      }
    }
    // adding a place while another flood scenario is active switches the Scenario panel to it
    var infos = await page.evaluate("window.__floodAreaInfo()");
    if (truth(infos)) {
      await page.evaluate(async (...args) => {
        await ((k) => window.__floodActivateArea(k))(...args);
      }, infos[0]["key"]);
      await page.waitForTimeout(500);
    }
    // tapping an empty spot offers a single add-a-place button
    await page.evaluate(async () => {
      await (window.__floodTestZoom &&
        window.__floodTestZoom(-27.62, 152.76, 11));
    });
    await page.waitForTimeout(800);
    await page.evaluate(async () => {
      await window.__floodTapAt(-27.62, 152.76);
    });
    await page.waitForTimeout(400);
    var spot = page.locator(".spot-popup .spot-add");
    await page.screenshot({ path: "smoke-spot-popup.png" });
    if (truth(await spot.count()) && truth(await spot.first().isVisible())) {
      var n_before = (await page.evaluate("window.__floodPlaces()")).length;
      await spot.first().click();
      await page.waitForTimeout(300);
      var places_now = await page.evaluate("window.__floodPlaces()");
      var pin_n =
        places_now.length > n_before
          ? Math.max(
              ...places_now.filter((p) => truth(p["pin"])).map((p) => p["n"]),
            )
          : await page.evaluate("window.__floodAddPin(-27.62, 152.76)");
    } else {
      failures.push(
        "tapping an empty spot did not offer the add-a-place button",
      );
      pin_n = await page.evaluate("window.__floodAddPin(-27.62, 152.76)");
    }
    before = get(get(await status(), "local") || {}, "key");
    // its model options sit at the top of the Scenario panel, not in Places
    await page.waitForTimeout(300);
    if (
      get(await status(), "modelOptions") !== pin_n ||
      !truth(
        await page.locator("#scenarioModel [data-model='model']").isVisible(),
      )
    ) {
      failures.push(
        `Scenario panel did not offer to model new place ${formatValue(pin_n)}: ${formatValue(get(await status(), "modelOptions"))}`,
      );
      await page.evaluate(async (...args) => {
        await ((n) => window.__floodPlaceAction("model", n))(...args);
      }, pin_n);
    } else {
      await page.locator("#scenarioModel [data-model='model']").click();
    }
    try {
      await page.waitForFunction(
        `window.__floodStatus.local && window.__floodStatus.local.ok !== undefined && (window.__floodStatus.local.ok === false || window.__floodStatus.local.key !== ${formatValue(JSON.stringify(before))})`,
        null,
        { timeout: 90000 },
      );
    } catch (error) {
      // A timeout is assessed by the checks below.
    }
    var pin_place = (await page.evaluate("window.__floodPlaces()"))
      .filter((p) => truth(p["n"] === pin_n))
      .map((p) => p);
    console.log(`Pinned place: ${formatValue(pin_place)}`);
    if (
      !truth(
        truth(pin_place) &&
          truth(pin_place[0]["pin"]) &&
          truth(pin_place[0]["area"]),
      )
    ) {
      failures.push(
        `pinned place ${formatValue(pin_n)} was not modelled under its own number: ${formatValue(pin_place)}`,
      );
    }
    await page.screenshot({ path: "smoke-pin.png" });
    // ---- a level point pins the surface along the river
    if (truth(pin_place) && truth(pin_place[0]["area"])) {
      var lp0 = get(await status(), "levelPoints", 0) || 0;
      await page.evaluate(async () => {
        await window.__floodAddLevelPoint(-27.6, 152.8);
      });
      await page.waitForTimeout(600);
      var lp1 = get(await status(), "levelPoints", 0) || 0;
      if (lp1 !== lp0 + 1) {
        failures.push(
          `adding a level point failed: ${formatValue(lp0)} -> ${formatValue(lp1)}`,
        );
      }
      try {
        var sat = await page.evaluate("window.__floodSatCheck()");
      } catch (e) {
        sat = { ok: false, error: String(e).slice(0, 200) };
      }
      note(
        truth(sat) && truth(get(sat, "ok")) ? "notice" : "warning",
        `Satellite check of the pinned model: ${formatValue(JSON.stringify(sat))}; LiDAR share ${formatValue(get(get(await status(), "local") || {}, "lidar"))}`,
      );
      // storm mode: flash flooding on the same model
      var fl = await page.evaluate(
        "window.__floodSetStorm('flash', 80, 1, 'typical')",
      );
      var stats_fl = (await page.innerText("#stats")).replaceAll(
        `
`,
        " ",
      );
      // stormwater pipes: once the buildings have loaded, built-up land drains
      try {
        await page.waitForFunction(
          "window.__floodStatus.impact && !window.__floodStatus.impact.loading",
          null,
          { timeout: 90000 },
        );
      } catch (error) {
        // A timeout is assessed by the checks below.
      }
      var fp = await page.evaluate(
        "window.__floodSetStorm('flash', 80, 1, 'typical')",
      );
      note(
        truth(fp) && get(fp, "pipedMm", 0) > 0 ? "notice" : "warning",
        `Storm pipes: ${formatValue(truth(fp) ? get(fp, "pipedMm") : null)} mm piped from ${formatValue(truth(fp) ? Number(get(fp, "urbanKm2", 0).toFixed(1)) : 0)} km² of built-up land; overland ${formatValue(Number(get(fl, "overlandKm2", 0).toFixed(1)))} → ${formatValue(truth(fp) ? Number(get(fp, "overlandKm2", 0).toFixed(1)) : "?")} km²`,
      );
      var fb = await page.evaluate("window.__floodSetStorm('both', 80, 1)");
      await page.screenshot({ path: "smoke-storm.png" });
      await page.evaluate(async () => {
        await window.__floodSetStorm("river");
      });
      note(
        "notice",
        `Storm 80 mm in 1 h: ${formatValue(JSON.stringify(fl))} | ${formatValue(stats_fl.slice(0, 140))}`,
      );
      if (
        !truth(
          truth(fl) &&
            get(fl, "excessMm", 0) > 0 &&
            get(fl, "creekKm2", 0) > 0 &&
            truth(fb) &&
            get(fb, "mode") === "both",
        )
      ) {
        failures.push(
          `storm (flash flood) mode failed: ${formatValue(fl)} / ${formatValue(fb)}`,
        );
      }
    }
    var wst = get(await status(), "warnings");
    note(
      "notice",
      `Flood warnings in the app: ${formatValue(JSON.stringify(wst))}; gauges ringed: ${formatValue(get(await status(), "warnedGauges"))}`,
    );
    // ---- extending a model rebuilds it over a 40 km window, keeping its number
    if (truth(pin_place) && truth(pin_place[0]["area"])) {
      var ext = null;
      try {
        ext = await page.evaluate("window.__floodExtendModel()");
        await page.waitForFunction(
          "window.__floodAreaInfo().every(a => a.drawn)",
          null,
          { timeout: 30000 },
        );
      } catch (e) {
        ext = `error: ${formatValue(e)}`;
      }
      loc = get(await status(), "local") || {};
      var ext_place = (await page.evaluate("window.__floodPlaces()"))
        .filter((p) => truth(p["n"] === pin_n))
        .map((p) => p);
      console.log(
        `Extend model: ${formatValue(ext)}; local ${formatValue(loc)}; place ${formatValue(ext_place)}`,
      );
      note("notice", `Extended model: ${formatValue(JSON.stringify(loc))}`);
      if (
        ext !== true ||
        get(loc, "km") !== 40 ||
        !truth(truth(ext_place) && truth(ext_place[0]["area"]))
      ) {
        failures.push(
          `extending the model failed: ${formatValue(ext)}, ${formatValue(loc)}, ${formatValue(ext_place)}`,
        );
      }
      await page.screenshot({ path: "smoke-extended.png" });
    }
    // ---- studying an area pulls in gauges, dams and several models
    try {
      var study = await page.evaluate(
        "window.__floodStudyArea(-28.95, 153.10, -28.65, 153.45)",
      );
    } catch (e) {
      study = { ok: false, error: String(e).slice(0, 300) };
    }
    console.log(`Area study: ${formatValue(study)}`);
    note(
      "notice",
      `Area study near Lismore: ${formatValue(JSON.stringify(study))}`,
    );
    if (
      !truth(
        truth(study) &&
          truth(get(study, "ok")) &&
          get(study, "models", 0) >= 2 &&
          get(study, "gauges", 0) >= 1,
      )
    ) {
      failures.push(`area study failed: ${formatValue(study)}`);
    }
    await page.screenshot({ path: "smoke-study.png" });
    // neighbouring models in the study can be joined into one water surface
    try {
      infos = await page.evaluate("window.__floodAreaInfo()");
      if (truth(infos)) {
        await page.evaluate(async (...args) => {
          await ((k) => window.__floodActivateArea(k))(...args);
        }, infos.at(-1)["key"]);
        await page.waitForTimeout(1500);
      }
      var joined = await page.evaluate("window.__floodJoinNeighbours()");
    } catch (e) {
      joined = `error: ${formatValue(e)}`;
    }
    note("notice", `Joined overlapping models: ${formatValue(joined)}`);
    if (!truth(Number.isInteger(joined)) || joined < 1) {
      failures.push(
        `joining overlapping study models failed: ${formatValue(joined)}`,
      );
    }
    var studies = await page.evaluate(
      "window.__floodStudies ? window.__floodStudies() : []",
    );
    var stored = await page.evaluate(
      "(() => { try { return JSON.parse(localStorage.getItem('floodExplorer.studies.v1') || '[]').length; } catch (e) { return -1; } })()",
    );
    var rows = await page.locator("#placesCard [data-study]").count();
    console.log(
      `Studies: ${formatValue(studies)}; stored ${formatValue(stored)}; rows ${formatValue(rows)}`,
    );
    if (
      !truth(
        truth(studies) &&
          truth(studies.at(-1)["loaded"]) &&
          stored >= 1 &&
          rows >= 1,
      )
    ) {
      failures.push(
        `the studied area was not kept: ${formatValue(studies)}, stored ${formatValue(stored)}, rows ${formatValue(rows)}`,
      );
    }
    // the box tool itself: button arms it, a drag draws the box
    await page.locator("#studyArea").click();
    var armed = await page.locator("#studyHint").isVisible();
    await page.locator("#studyCancel").click();
    if (!truth(armed)) {
      failures.push("the Study an area button did not arm the box tool");
    }
    // ---- council overland-flow layers draw where they cover
    for (var cl of await page.evaluate(
      "window.__floodCouncilLayers ? window.__floodCouncilLayers() : []",
    )) {
      await page.evaluate(
        async (...args) => {
          await (([la, lo, z]) => window.__floodTestZoom(la, lo, z))(...args);
        },
        [cl["test"][0], cl["test"][1], Math.max(14, cl["minZoom"] + 1)],
      );
      await page.evaluate(
        async (...args) => {
          await (([n]) => window.__floodSetOverlay(n, true))(...args);
        },
        [cl["name"]],
      );
      await page.waitForTimeout(8000);
      var cst = await page.evaluate(
        (n) => window.__floodStatus.overlays[n] || null,
        cl["name"],
      );
      note(
        truth(cst) && truth(get(cst, "features")) ? "notice" : "warning",
        `Council layer ${formatValue(cl["name"])}: ${formatValue(JSON.stringify(cst))}`,
      );
      await page.screenshot({
        path: `smoke-council-${formatValue(cl["name"].trim().split(/\s+/)[0].toLowerCase())}.png`,
      });
      await page.evaluate(
        async (...args) => {
          await (([n]) => window.__floodSetOverlay(n, false))(...args);
        },
        [cl["name"]],
      );
    }
    // ---- downloads of the active model
    var n_rect = await page.evaluate(
      "window.__floodGeoJSON ? window.__floodGeoJSON() : -1",
    );
    var n_tiff = await page.evaluate(
      "window.__floodDepthTiffBytes ? window.__floodDepthTiffBytes() : -1",
    );
    note(
      "notice",
      `Downloads: GeoJSON ${formatValue(n_rect)} rectangles, GeoTIFF ${formatValue(n_tiff)} bytes`,
    );
    if (!truth(truth(n_rect) && n_rect > 0 && n_tiff > 1000)) {
      failures.push(
        `downloads failed: geojson ${formatValue(n_rect)}, tiff ${formatValue(n_tiff)}`,
      );
    }
    // ---- rain radar overlay
    if (
      truth(
        await page.evaluate(
          ([n]) => window.__floodSetOverlay(n, true),
          ["Rain radar, latest (RainViewer)"],
        ),
      )
    ) {
      await page.waitForTimeout(4000);
      var rd = get(await status(), "radar");
      note(
        truth(rd) && truth(get(rd, "ok")) ? "notice" : "warning",
        `Rain radar: ${formatValue(JSON.stringify(rd))}`,
      );
      await page.evaluate(
        async (...args) => {
          await (([n]) => window.__floodSetOverlay(n, false))(...args);
        },
        ["Rain radar, latest (RainViewer)"],
      );
    } else {
      failures.push("the rain radar overlay is missing");
    }
    // ---- address search
    await page.fill("#searchInput", "Lismore NSW");
    await page.press("#searchInput", "Enter");
    try {
      await page.waitForFunction(
        "window.__floodStatus.search && window.__floodStatus.search.results !== undefined || (window.__floodStatus.search && window.__floodStatus.search.ok === false)",
        null,
        { timeout: 15000 },
      );
    } catch (error) {
      // A timeout is assessed by the checks below.
    }
    var srch = get(await status(), "search");
    note(
      truth(srch) && truth(get(srch, "results")) ? "notice" : "warning",
      `Address search: ${formatValue(JSON.stringify(srch))}`,
    );
    await page.evaluate(async () => {
      await window.__floodGoTo(-28.809, 153.2765, "Lismore");
    });
    await page.waitForTimeout(1500);
    var hit = get(await status(), "searchHit");
    if (!truth(truth(hit) && truth(get(hit, "inModel")))) {
      failures.push(
        `a search result inside the Lismore study did not report its flood depth: ${formatValue(hit)}`,
      );
    }
    await page.screenshot({ path: "smoke-search.png" });
    var sess = {
      v: 1,
      reports: [],
      pins: [{ n: 3, lat: -27.62, lon: 152.76, name: "Shared pin" }],
      areas: [
        {
          n: 3,
          name: "Shared pin",
          kind: "river",
          g: [-27.62, 152.76],
          c: [-27.62, 152.76],
          h: 10,
          pin: 3,
          ctl: null,
          cp: [[-27.6, 152.8, 99.5, "Shared level"]],
        },
      ],
      active: 3,
      studies: [],
    };
    var tok = Buffer.from(JSON.stringify(sess)).toString("base64url");
    var p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await p2.goto(URL + "#s=" + tok, {
      waitUntil: "domcontentloaded",
      timeout: 90000,
    });
    try {
      await p2.waitForFunction(
        "window.__floodStatus && window.__floodStatus.restore && window.__floodStatus.restore.ok !== undefined",
        null,
        { timeout: 120000 },
      );
    } catch (error) {
      // A timeout is assessed by the checks below.
    }
    var rs = await p2.evaluate("window.__floodStatus.restore || null");
    var shared = await p2.evaluate(
      "window.__floodPlaces ? window.__floodPlaces() : []",
    );
    var lp = await p2.evaluate("window.__floodStatus.levelPoints");
    note(
      "notice",
      `Share link restore: ${formatValue(JSON.stringify(rs))}; places ${formatValue(JSON.stringify(shared))}; level points ${formatValue(lp)}`,
    );
    if (
      !truth(
        truth(rs) &&
          truth(get(rs, "ok")) &&
          truth(
            shared
              .map((x) => x["n"] === 3 && truth(x["pin"]) && truth(x["area"]))
              .some(truth),
          ),
      )
    ) {
      failures.push(
        `share link did not reopen its place: ${formatValue(rs)}, ${formatValue(shared)}`,
      );
    }
    await p2.screenshot({ path: "smoke-share.png" });
    await p2.close();
    // ---- impact counts and recorded-flood accuracy at Rockhampton
    before = get(get(await status(), "local") || {}, "key");
    await page.selectOption("#area", "preset:rockhampton");
    try {
      await page.waitForFunction(
        `window.__floodStatus.local && window.__floodStatus.local.ok !== undefined && window.__floodStatus.local.key !== ${formatValue(JSON.stringify(before))}`,
        null,
        { timeout: 90000 },
      );
    } catch (error) {
      // A timeout is assessed by the checks below.
    }
    try {
      var recs = await page.evaluate("window.__floodFindRecorded()");
    } catch (e) {
      recs = `error: ${formatValue(e)}`;
    }
    note("notice", `Recorded floods at Rockhampton: ${formatValue(recs)}`);
    if (!truth(truth(Array.isArray(recs)) && truth(recs))) {
      failures.push(
        `no recorded floods found at Rockhampton: ${formatValue(recs)}`,
      );
    } else {
      try {
        var fit = await page.evaluate(
          (id) => window.__floodFitRecorded(id),
          recs[0],
        );
      } catch (e) {
        fit = { error: String(e).slice(0, 200) };
      }
      note(
        "notice",
        `Best match to ${formatValue(recs[0])}: ${formatValue(JSON.stringify(fit))}`,
      );
      if (!truth(fit) || get(fit, "error") || get(fit, "csi", 0) <= 0) {
        failures.push(
          `matching the recorded flood failed: ${formatValue(fit)}`,
        );
      }
    }
    try {
      var imp = await page.evaluate("window.__floodCountImpact()");
    } catch (e) {
      imp = { error: String(e).slice(0, 200) };
    }
    note(
      truth(imp) && truth(get(imp, "buildings")) ? "notice" : "warning",
      `Impact at Rockhampton: ${formatValue(JSON.stringify(imp))}`,
    );
    if (
      truth(imp) &&
      truth(get(imp, "buildings")) &&
      get(imp, "damage") === null
    ) {
      failures.push(`impact count has no damage estimate: ${formatValue(imp)}`);
    }
    if (
      truth(imp) &&
      truth(get(imp, "error")) &&
      !get(imp, "error", "").includes("OpenStreetMap") &&
      !get(imp, "error", "").includes("Failed to fetch")
    ) {
      failures.push(`impact count failed: ${formatValue(imp)}`);
    }
    await page.screenshot({ path: "smoke-impact.png" });
    await snapVisual("impact", page, failures);
    // ---- the flood over time: road closures and places cut off
    try {
      var tlr = await page.evaluate("window.__floodRunTimeline()");
    } catch (e) {
      tlr = { error: String(e).slice(0, 300) };
    }
    note(
      "notice",
      `Flood over time at Rockhampton: ${formatValue(JSON.stringify(tlr))}`,
    );
    if (
      !truth(
        truth(tlr) && get(tlr, "steps", 0) > 10 && !truth(get(tlr, "error")),
      )
    ) {
      failures.push(`flood over time failed: ${formatValue(tlr)}`);
    } else {
      if (!truth(get(tlr, "routed"))) {
        failures.push(
          `flood over time wasn't routed below the gauge: ${formatValue(tlr)}`,
        );
      }
    }
    await page.screenshot({ path: "smoke-timeline.png" });
    await snapVisual("timeline", page, failures);
    // ---- hazard classes, comparing scenarios, the property check, a dam release
    var extra = {};
    try {
      var hz = await page.evaluate("window.__floodColorMode('hazard')");
      extra["hazard"] = get(hz, "hazard");
      await page.screenshot({ path: "smoke-hazard.png" });
      var lvl0 = await page.evaluate(
        "parseFloat(document.getElementById('gaugeLevel').value)",
      );
      await page.evaluate(async () => {
        await window.__floodPin();
      });
      await page.evaluate(async (...args) => {
        await ((v) => window.__floodSetLevel(v))(...args);
      }, lvl0 + 1.0);
      await page.waitForTimeout(1500);
      var cmp = await page.evaluate("window.__floodColorMode('compare')");
      extra["compare"] = get(cmp, "compare");
      await page.screenshot({ path: "smoke-compare.png" });
      await page.evaluate(async (...args) => {
        await ((v) => window.__floodSetLevel(v))(...args);
      }, lvl0);
      await page.evaluate(async () => {
        await window.__floodColorMode("depth");
      });
      spot = await page.evaluate(
        "window.__floodGaugeLatLng ? window.__floodGaugeLatLng() : null",
      );
      if (truth(spot)) {
        extra["property"] = await page.evaluate(
          ([la, lo]) =>
            window.__floodCheckProperty(
              la + 0.004,
              lo + 0.004,
              "Near the gauge",
            ),
          spot,
        );
        await page.screenshot({ path: "smoke-property.png" });
      }
      await page.evaluate(async () => {
        await window.__floodRelease(40, 10, 36);
      });
      var rel = await page.evaluate("window.__floodRunTimeline()");
      extra["release"] = truth(rel) ? get(rel, "release") : null;
      await page.evaluate(async () => {
        await window.__floodRelease(0, 10, 36);
      });
    } catch (e) {
      extra["error"] = String(e).slice(0, 300);
    }
    note(
      "notice",
      `New tools at Rockhampton: ${formatValue(JSON.stringify(extra))}`,
    );
    if (
      !truth(
        truth(get(extra, "hazard")) &&
          extra["hazard"].reduce((a, b) => a + b, 0) > 0,
      )
    ) {
      failures.push(`hazard classes failed: ${formatValue(extra)}`);
    }
    if (
      !truth(
        truth(get(extra, "compare")) && get(extra["compare"], "onlyNow", 0) > 0,
      )
    ) {
      failures.push(`scenario comparison failed: ${formatValue(extra)}`);
    }
    if (
      get(extra, "property") !== null &&
      !truth(get(extra["property"], "inModel"))
    ) {
      failures.push(`property check failed: ${formatValue(extra)}`);
    }
    if (get(extra, "release") === null || extra["release"] <= 0) {
      note(
        "warning",
        `Dam release made no difference: ${formatValue(get(extra, "release"))}`,
      );
    }
    var ds = await page.evaluate(
      "window.__floodDataStatus ? window.__floodDataStatus() : null",
    );
    note("notice", `Data status: ${formatValue(JSON.stringify(ds))}`);
    // ---- on a phone, a swipe scrolls the Layers panel
    var mctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    var mp = await mctx.newPage();
    await mp.goto(URL, { waitUntil: "domcontentloaded", timeout: 90000 });
    try {
      await mp.waitForFunction(
        "window.__floodStatus && window.__floodStatus.national && window.__floodStatus.national.loaded",
        null,
        { timeout: 60000 },
      );
    } catch (error) {
      // A timeout is assessed by the checks below.
    }
    await mp.evaluate(async () => {
      await window.__floodOpenPanel("panel-layers");
    });
    await mp.waitForTimeout(800);
    var cdp = await mctx.newCDPSession(mp);
    box = await mp.locator("#panel-layers").boundingBox();
    var body = mp.locator("#panel-layers > .sheet-body");
    var [sh, chh] = await body.evaluate((e) => [
      e.scrollHeight,
      e.clientHeight,
    ]);
    if (truth(box) && sh > chh + 20) {
      var y0 = box["y"] + box["height"] - 60;
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x: 200, y: y0 }],
      });
      for (var k = 1; k < 13; k++) {
        await cdp.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: 200, y: y0 - (250 * k) / 12 }],
        });
        await mp.waitForTimeout(16);
      }
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await mp.waitForTimeout(600);
      var top = await body.evaluate((e) => e.scrollTop);
      note(
        "notice",
        `Phone Layers panel: swipe scrolled to ${formatValue(top)} of ${formatValue(sh - chh)}`,
      );
      if (top <= 0) {
        failures.push("a swipe does not scroll the Layers panel on a phone");
      }
    }
    await mp.screenshot({ path: "smoke-phone-layers.png" });
    await mctx.close();
    // ---- every preset in the menu models successfully
    var results = [];
    // every preset when SMOKE_PRESETS=all (nightly / on demand), otherwise
    // a quick sample covering each kind: river (NSW, Vic, WA) and coast
    var which = process.env["SMOKE_PRESETS"] ?? "all";
    var quick = ["lismore", "echuca", "carnarvon", "goldcoast"];
    var presets = await page.evaluate("window.__floodPresets || []");
    if (which !== "all") {
      presets = presets
        .filter((x) => truth(quick.includes(x["id"])))
        .map((x) => x);
    }
    note(
      "notice",
      `Presets checked: ${formatValue(presets.length)} (${formatValue(which)})`,
    );
    var seas = [];
    for (var pre of presets) {
      before = get(get(await status(), "local") || {}, "key");
      await page.selectOption("#area", `preset:${formatValue(pre["id"])}`);
      try {
        await page.waitForFunction(
          `window.__floodStatus.local && window.__floodStatus.local.ok !== undefined && (window.__floodStatus.local.ok === false || window.__floodStatus.local.key !== ${formatValue(JSON.stringify(before))})`,
          null,
          { timeout: 90000 },
        );
      } catch (error) {
        // A timeout is assessed by the checks below.
      }
      loc = get(await status(), "local") || {};
      var snap = get(await status(), "snap") || {};
      stats = truth(get(loc, "ok"))
        ? (await page.innerText("#stats")).replaceAll(
            `
`,
            " ",
          )
        : "";
      var same = await page.evaluate(
        (p) =>
          (window.__floodAreaInfo() || []).some(
            (a) => a.active && p.startsWith(a.name),
          ),
        pre["name"],
      );
      results.push({
        id: pre["id"],
        ok:
          truth(truth(get(loc, "ok"))) && (get(loc, "key") !== before || same),
        ms: get(loc, "ms"),
        error: get(loc, "error"),
        snap: snap,
        stats: stats.slice(0, 120),
        anchor: get(await status(), "presetAnchor"),
        lidar: get(loc, "lidar"),
        kind: get(pre, "kind"),
      });
      await page.screenshot({
        path: `smoke-preset-${formatValue(pre["id"])}.png`,
      });
      if (pre["id"] === "lismore" && truth(get(loc, "ok"))) {
        // levees: find mapped ones, draw one, then make them all fail
        try {
          var fd = await page.evaluate("window.__floodFindDefences()");
          var st_in = (await page.innerText("#stats")).replaceAll(
            `
`,
            " ",
          );
          var dl = await page.evaluate(
            "window.__floodDrawLevee([[-28.800, 153.268], [-28.812, 153.282]], 4)",
          );
          var ff = await page.evaluate("window.__floodLeveesFail(true)");
          var st_out = (await page.innerText("#stats")).replaceAll(
            `
`,
            " ",
          );
          await page.evaluate(async () => {
            await window.__floodLeveesFail(false);
          });
        } catch (e) {
          [fd, dl, ff, st_in, st_out] = [
            { error: String(e).slice(0, 300) },
            null,
            null,
            "",
            "",
          ];
        }
        note(
          "notice",
          `Levees at Lismore: found ${formatValue(JSON.stringify(fd))}; after drawing ${formatValue(JSON.stringify(dl))}; all fail ${formatValue(JSON.stringify(ff))} | intact: ${formatValue(st_in.slice(0, 90))} | failed: ${formatValue(st_out.slice(0, 90))}`,
        );
        if (
          !truth(
            truth(dl) &&
              get(dl, "levees", 0) >= 1 &&
              truth(ff) &&
              get(ff, "failed", 0) >= 1,
          )
        ) {
          failures.push(
            `levee tools failed: ${formatValue(fd)} / ${formatValue(dl)} / ${formatValue(ff)}`,
          );
        }
        await page.screenshot({ path: "smoke-levees.png" });
      }
      if (truth(get(loc, "ok"))) {
        var sea = await page.evaluate(
          "window.__floodSeaInfo ? window.__floodSeaInfo() : null",
        );
        seas.push(
          `${formatValue(pre["id"])}: ${formatValue(JSON.stringify(sea))}`,
        );
        if (
          ["goldcoast", "carnarvon"].includes(pre["id"]) &&
          truth(sea) &&
          !truth(get(sea, "hasSea"))
        ) {
          failures.push(
            `tides not offered on the coast at ${formatValue(pre["id"])}: ${formatValue(sea)}`,
          );
        }
        if (pre["id"] === "carnarvon") {
          var tp = await page.evaluate(
            "window.__floodTidePort ? window.__floodTidePort() : null",
          );
          note(
            truth(tp) && get(tp, "src") === "eot20" ? "notice" : "warning",
            `Tides at Carnarvon (national tide model): ${formatValue(JSON.stringify(tp))}`,
          );
        }
        if (
          ["echuca", "lismore"].includes(pre["id"]) &&
          truth(sea) &&
          truth(get(sea, "hasSea"))
        ) {
          failures.push(
            `tides offered inland at ${formatValue(pre["id"])}: ${formatValue(sea)}`,
          );
        }
      }
      if (pre["id"] === "goldcoast" && truth(get(loc, "ok"))) {
        var tide = await page.evaluate(
          "window.__floodStormTide('hat', 2.0, 0.3)",
        );
        note(
          "notice",
          `Storm tide at Gold Coast: ${formatValue(JSON.stringify(tide))}`,
        );
        if (
          !truth(
            truth(tide) &&
              get(tide, "port") === "Gold Coast Seaway" &&
              3.0 < get(tide, "bay", 0) &&
              get(tide, "bay", 0) < 4.0,
          )
        ) {
          failures.push(`storm tide builder failed: ${formatValue(tide)}`);
        }
      }
      if (pre["id"] === "echuca" && truth(get(loc, "ok"))) {
        try {
          var vrec = await page.evaluate("window.__floodFindRecorded()");
        } catch (e) {
          vrec = `error: ${formatValue(e)}`;
        }
        note(
          "notice",
          `Recorded floods at Echuca (Victoria): ${formatValue(vrec)}; ${formatValue(JSON.stringify(get(await status(), "vicRecorded")))}`,
        );
        var n_cls = await page.evaluate(
          "window.__floodApplyGaugeLevels ? window.__floodApplyGaugeLevels('major') : -1",
        );
        note(
          "notice",
          `Echuca major flood class applied at ${formatValue(n_cls)} gauge(s); level points ${formatValue(get(await status(), "levelPoints"))}`,
        );
        var rh = await page.evaluate(
          "window.__floodRatingHere ? window.__floodRatingHere() : null",
        );
        note(
          "notice",
          `Rating at Echuca's gauge: ${formatValue(JSON.stringify(rh))}`,
        );
        // the October 2022 flood's hourly readings drive flood over time
        var evs = await page.evaluate(
          "window.__floodEventsHere ? window.__floodEventsHere() : []",
        );
        if (truth(evs)) {
          try {
            var tle = await page.evaluate(
              (id) => window.__floodRunTimeline(id),
              evs[0],
            );
          } catch (e) {
            tle = { error: String(e).slice(0, 300) };
          }
          note(
            "notice",
            `Recorded flood over time at Echuca (${formatValue(evs)}): ${formatValue(JSON.stringify(tle))}`,
          );
          if (
            !truth(
              truth(tle) &&
                get(tle, "event") === evs[0] &&
                get(tle, "steps", 0) > 10,
            )
          ) {
            failures.push(
              `recorded flood over time failed: ${formatValue(tle)}`,
            );
          }
          await page.screenshot({ path: "smoke-timeline-recorded.png" });
        } else {
          note(
            "warning",
            "No recorded flood readings near Echuca (events.json missing or not matched)",
          );
        }
      }
    }
    note("notice", "Sea reached below the gauge: " + seas.join(" | "));
    var loose = results
      .filter((r) =>
        truth(
          get(r, "kind") === "river" &&
            !truth(get(get(r, "anchor") || {}, "gauge")),
        ),
      )
      .map((r) => r["id"]);
    var anchored = results
      .filter((r) => truth(get(get(r, "anchor") || {}, "gauge")))
      .map(
        (r) =>
          `${formatValue(r["id"])}→${formatValue(r["anchor"]["gauge"])} (${formatValue(r["anchor"]["km"])} km)`,
      );
    note(
      "notice",
      `Presets anchored to a BoM gauge: ${formatValue(anchored.length)}; not anchored: ${formatValue(loose.join(", ") || "none")}`,
    );
    note("notice", "Anchors: " + anchored.join("; ").slice(0, 1800));
    var lid = results
      .filter((r) => truth((get(r, "lidar") || 0) >= 0.2))
      .map((r) => r["id"]);
    note(
      "notice",
      `Presets on LiDAR terrain: ${formatValue(lid.length)} of ${formatValue(results.length)}`,
    );
    var bad = results.filter((r) => truth(!truth(r["ok"]))).map((r) => r);
    appendSummary(
      `### Presets
` + results.map((r) => `- ${formatValue(JSON.stringify(r))}\n`).join(""),
    );
    console.log("Presets:", JSON.stringify(results));
    if (truth(bad)) {
      failures.push(
        `${formatValue(bad.length)} preset(s) failed: ` +
          bad
            .map((r) => `${formatValue(r["id"])}: ${formatValue(r["error"])}`)
            .join("; "),
      );
    }
    await page.screenshot({ path: "smoke.png", fullPage: false });
    // ---- offline: with the network cut, the site still opens from the
    // service worker's cache and rebuilds the saved places from cached terrain
    var off = {};
    try {
      off["sw"] = await page.evaluate(
        "navigator.serviceWorker ? Promise.race([navigator.serviceWorker.ready.then((r) => !!r.active), new Promise((ok) => setTimeout(() => ok(false), 15000))]) : false",
      );
      await page.context().setOffline(true);
      await page.reload({ waitUntil: "load", timeout: 60000 });
      await page.waitForFunction(
        "window.__floodStatus && window.__floodStatus.national && window.__floodStatus.national.loaded",
        null,
        { timeout: 60000 },
      );
      await page.waitForTimeout(20000);
      st = await status();
      Object.assign(off, {
        gauges: get(get(st, "national") || {}, "gauges"),
        pill: await page.isVisible("#offlinePill"),
        online: get(get(st, "offline") || {}, "online"),
        restore: get(st, "restore"),
        mode: get(st, "mode"),
      });
      await page.screenshot({ path: "smoke-offline.png" });
    } catch (e) {
      off["error"] = String(e).slice(0, 300);
    } finally {
      await page.context().setOffline(false);
    }
    note(
      truth(get(off, "gauges")) ? "notice" : "warning",
      `Offline reload: ${formatValue(JSON.stringify(off))}`,
    );
    if (truth(get(off, "sw")) && !truth(get(off, "gauges"))) {
      failures.push(`site did not open offline: ${formatValue(off)}`);
    }
    errors = errors.filter((e) => truth(!e.includes("favicon"))).map((e) => e);
    // A third-party service that drops a request shows up as a browser network
    // log (CORS-less error reply / ERR_FAILED); the app retries and reports it,
    // so note these rather than failing the build on someone else's outage
    var network = errors
      .filter((e) =>
        truth(
          e.includes("blocked by CORS policy") ||
            startsWith(e, "Failed to load resource"),
        ),
      )
      .map((e) => e);
    errors = errors.filter((e) => truth(!network.includes(e))).map((e) => e);
    if (truth(network)) {
      note(
        "warning",
        "Third-party network errors: " +
          network.slice(0, 3).join(" | ").slice(0, 900),
      );
    }
    if (truth(errors)) {
      failures.push("page errors: " + errors.slice(0, 5).join(" | "));
    }
    note(
      "notice",
      `Area: ${formatValue(area)}. 2011 stats: ${formatValue(stats_2011)}`,
    );
    note(
      "notice",
      `Map status: ${formatValue(JSON.stringify(s1))}; after 1893: flood pixels ${formatValue(get(after, "floodPixels"))}`,
    );
    if (truth(popup)) {
      note("notice", `Popup: ${formatValue(popup)}`);
    }
    if (truth(KEY)) {
      // GitHub cuts long annotations short: split the key results into a
      // few notes of about 3,500 characters (it shows 10 notes per step)
      var [chunks, cur] = [[], ""];
      for (k of KEY) {
        var line = k.replaceAll("%", "%25").replaceAll(
          `
`,
          " ",
        );
        if (truth(cur) && cur.length + line.length > 3500) {
          chunks.push(cur);
          cur = "";
        }
        cur = truth(cur) ? `${formatValue(cur)}%0A${formatValue(line)}` : line;
      }
      if (truth(cur)) {
        chunks.push(cur);
      }
      for (let [i, c] of chunks.slice(0, 6).entries()) {
        console.log(
          `::notice title=Key results ${formatValue(i + 1)} of ${formatValue(Math.min(6, chunks.length))}::` +
            c,
        );
      }
      appendSummary(
        `### Key results
` + KEY.map((k) => `- ${formatValue(k)}\n`).join(""),
      );
    }
    for (var f of failures) {
      note("error", f);
    }
    if (!truth(failures)) {
      note("notice", "Interactive map smoke test passed");
    }
    return truth(failures) ? 1 : 0;
  } finally {
    await browser.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error(
      "::error::" + String(error.stack || error).replaceAll("\n", "%0A"),
    );
    process.exitCode = 1;
  });
