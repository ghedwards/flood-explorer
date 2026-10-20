// Dam model check: Lake Kurwongbah from a share link (dam report, gauge in
// the lake at 26 m). Records the dam outlet the model finds, the newly
// flooded area at 26 m and at the lake's normal level, and what a tap
// below the dam wall says; screenshots the view below the wall.
//   SITE_URL=http://127.0.0.1:8000/ OUT=shots node tests/dam-check.js
const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const URL = process.env.SITE_URL || "http://127.0.0.1:8000/";
const OUT = process.env.OUT || "shots";
const TAG = process.env.TAG || "dam";
const LINK = "#s=eyJ2IjoxLCJ2aWV3IjpbLTI3LjI3ODY3LDE1Mi45NTY5NSwxNS44NF0sInJlcG9ydHMiOlt7Im4iOjEsImlkIjoic3RvcmFnZToxMzcifV0sInBpbnMiOltdLCJjaGVja3MiOltdLCJhcmVhcyI6W3sibiI6MSwibmFtZSI6Ikxha2UgS3Vyd29uZ2JhaCIsImtpbmQiOiJyaXZlciIsImciOlstMjcuMjM4MjgsMTUyLjk1Njg5XSwiYyI6Wy0yNy4yMzgyOCwxNTIuOTU2ODldLCJoIjoxMCwicmlkIjoic3RvcmFnZToxMzciLCJwaW4iOm51bGwsInByZSI6bnVsbCwiY3RsIjp7ImdhdWdlTGV2ZWwiOiIyNiIsImJheUxldmVsIjoiMSIsInNsciI6IjAiLCJleHRyYSI6IjAiLCJncmFkIjoiMC4zIiwic3RyZWFtQXJlYSI6IjYzIiwiZmxvb2RUeXBlIjoicml2ZXIiLCJyYWluTW0iOiIxMDAiLCJzdG9ybUhvdXJzIjoiMSIsImdyb3VuZCI6InR5cGljYWwiLCJwaXBlcyI6IjQwIiwid2FybWluZyI6IjAifSwiZ3AiOlstMjcuMjM4NzMsMTUyLjk1NjU5XSwiY3AiOltdLCJzYSI6MS42MDAwMDY3ODE3NDY4NzY2LCJkZWYiOm51bGx9XSwiYWN0aXZlIjoxLCJzdHVkaWVzIjpbXX0";
const SPOT = [-27.2758, 152.9585];   // the hollow below the dam wall (the user's tap)

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const report = { url: URL, steps: [] };
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => report.steps.push({ pageerror: String(e).slice(0, 300) }));
  const read = () => page.evaluate(() => ({
    summary: document.getElementById("summaryLine").textContent,
    level: document.getElementById("gaugeLevel") && document.getElementById("gaugeLevel").value,
    dam: window.__floodDam ? window.__floodDam() : "no hook (before the fix)",
  }));
  try {
    await page.goto(URL + LINK, { waitUntil: "load", timeout: 90000 });
    await page.waitForFunction("window.__floodStatus && window.__floodStatus.local && window.__floodStatus.local.ok === true", null, { timeout: 180000 });
    await page.waitForTimeout(5000);
    report.at26 = await read();
    await page.evaluate(([la, lo]) => { window.__floodTapAt(la, lo); }, SPOT);
    await page.waitForTimeout(800);
    report.tap26 = await page.evaluate(() => document.getElementById("readout").textContent);
    await page.screenshot({ path: path.join(OUT, `${TAG}-26m.png`) });
    // the lake at its normal level (the elevation data's surface + 0.3 m)
    await page.evaluate(() => {
      const el = document.getElementById("gaugeLevel");
      window.__floodSetLevel(parseFloat(el.min));
    });
    report.minLevel = await page.evaluate(() => document.getElementById("gaugeLevel").min);
    await page.waitForTimeout(3000);
    report.atMin = await read();
    await page.evaluate(([la, lo]) => { window.__floodTapAt(la, lo); }, SPOT);
    await page.waitForTimeout(800);
    report.tapMin = await page.evaluate(() => document.getElementById("readout").textContent);
    await page.screenshot({ path: path.join(OUT, `${TAG}-min.png`) });
  } catch (e) {
    report.fatal = String(e).slice(0, 400);
  }
  fs.writeFileSync(path.join(OUT, `${TAG}.json`), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report));
  await browser.close();
})();
