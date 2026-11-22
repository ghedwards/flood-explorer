const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const result = spawnSync(
  process.platform === "win32" ? "npm.cmd" : "npm",
  ["outdated", "--json"],
  { encoding: "utf8", shell: process.platform === "win32" },
);
if (result.error) throw result.error;
if (result.stderr) process.stderr.write(result.stderr);
const report = JSON.parse(result.stdout || "{}");
// Status 1 is only informational when npm returned actual update records.
if (
  report.error ||
  ![0, 1].includes(result.status) ||
  (result.status === 1 &&
    !Object.values(report).every((p) => p.current && p.latest)) ||
  (result.status === 1 && !Object.keys(report).length)
) {
  console.error(report);
  process.exit(result.status || 1);
}
const text = JSON.stringify(report, null, 2) + "\n";
fs.writeFileSync("npm-outdated.txt", text);
console.log(text);
if (Object.keys(report).length)
  console.log("::warning::npm dependencies have available updates; see report");
if (process.env.GITHUB_STEP_SUMMARY)
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### npm outdated\n\n\`\`\`json\n${text}\`\`\`\n`,
  );
