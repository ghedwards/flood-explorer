const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const site = path.resolve(__dirname, "../../site");
test("production entry points are relative and service worker includes lazy bundles", () => {
  const html = fs.readFileSync(path.join(site, "index.html"), "utf8");
  assert.doesNotMatch(
    html,
    /(?:src|href)=["'](?:https?:)?\/\/(?:unpkg|cdn\.jsdelivr|fonts\.)/,
  );
  const entries = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((p) => !p.startsWith("http") && !p.startsWith("#"));
  for (const file of entries) {
    assert.ok(!file.startsWith("/"), `absolute entry point: ${file}`);
    assert.ok(fs.existsSync(path.join(site, file)), `missing asset: ${file}`);
  }
  const sw = fs.readFileSync(path.join(site, "sw.js"), "utf8");
  assert.ok(!sw.includes("__BUILD__"));
  const files = JSON.parse(sw.match(/const BUILD_ASSETS = (\[.*?\]);/)[1]);
  for (const file of files)
    assert.ok(
      fs.existsSync(path.join(site, file)),
      `missing cached asset: ${file}`,
    );
  for (const pattern of [
    /map-libs-.*\.js$/,
    /geotiff-.*\.js$/,
    /flood-worker-.*\.js$/,
    /inertial-worker-.*\.js$/,
    /dam-worker-.*\.js$/,
    /\.wasm$/,
    /\.woff2$/,
  ])
    assert.ok(
      files.some((p) => pattern.test(p)),
      `missing cache group: ${pattern}`,
    );
});
