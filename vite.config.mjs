import { defineConfig } from "vite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig({
  root: path.join(root, "viewer"),
  base: "./",
  build: {
    outDir: path.join(root, "site"),
    emptyOutDir: false,
    assetsInlineLimit: 0,
    target: "es2022",
  },
  worker: { format: "es" },
  // the commit this site was built from, shown with logged problems
  // and the live data broker's address (broker/; none: build data only)
  define: {
    "import.meta.env.VITE_BUILD": JSON.stringify((process.env.GITHUB_SHA || "dev").slice(0, 8)),
    "import.meta.env.VITE_BROKER": JSON.stringify(process.env.FLOOD_BROKER_URL || ""),
    // where the map's readings come from: "build" (default) or "runtime"
    "import.meta.env.VITE_DATA_SOURCE": JSON.stringify(process.env.DATA_SOURCE || "build"),
  },
  server: {
    host: "127.0.0.1",
    port: 8000,
    proxy: fs.existsSync(path.join(root, "viewer/data"))
      ? undefined
      : {
          "/data": {
            target: "https://ghedwards.github.io/flood-explorer",
            changeOrigin: true,
          },
        },
  },
  preview: {
    host: "127.0.0.1",
    port: 8000,
    proxy: {
      "/data": {
        target: "https://ghedwards.github.io/flood-explorer",
        changeOrigin: true,
      },
    },
  },
  plugins: [
    {
      name: "flood-offline-shell",
      generateBundle(_options, bundle) {
        const files = Object.keys(bundle).sort();
        const hash = createHash("sha256");
        for (const name of files) {
          hash.update(name);
          hash.update(
            bundle[name].type === "chunk"
              ? bundle[name].code
              : bundle[name].source,
          );
        }
        const sw = fs
          .readFileSync(path.join(root, "viewer/sw.js"), "utf8")
          .replace("__BUILD__", hash.digest("hex").slice(0, 16))
          .replace(
            "const BUILD_ASSETS = [];",
            `const BUILD_ASSETS = ${JSON.stringify(files)};`,
          );
        this.emitFile({ type: "asset", fileName: "sw.js", source: sw });
        // Keep redistribution notices alongside the bundled assets.
        const deps = JSON.parse(
          fs.readFileSync(path.join(root, "package.json"), "utf8"),
        ).dependencies;
        for (const name of Object.keys(deps))
          this.emitFile({
            type: "asset",
            fileName: `licenses/${name.replaceAll("/", "-")}.txt`,
            source: fs.readFileSync(
              path.join(root, "node_modules", name, "LICENSE"),
            ),
          });
      },
    },
  ],
});
