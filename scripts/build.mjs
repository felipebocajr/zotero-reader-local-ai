import { build } from "esbuild";
import { mkdir, cp, readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const stage = new URL("../dist/addon/", import.meta.url);
await mkdir(stage, { recursive: true });
await cp(new URL("../addon/", import.meta.url), stage, { recursive: true });
await mkdir(new URL("licenses/", stage), { recursive: true });
for (const [name, file] of [
  ["katex", "LICENSE"], ["markdown-it", "LICENSE"],
  ["entities", "LICENSE"], ["linkify-it", "LICENSE"], ["mdurl", "LICENSE"],
  ["punycode.js", "LICENSE-MIT.txt"], ["uc.micro", "LICENSE.txt"],
]) {
  await cp(new URL(`../node_modules/${name}/${file}`, import.meta.url), new URL(`licenses/${name}.txt`, stage));
}
await build({ entryPoints: [root + "/src/index.ts"], outfile: fileURLToPath(new URL("reader-local-ai.js", stage)),
  bundle: true, format: "iife", globalName: "ReaderLocalAI", target: "firefox140", loader: { ".css": "text" }, legalComments: "none" });
const manifest = JSON.parse(await readFile(new URL("manifest.json", stage), "utf8"));
const result = spawnSync("python3", [root + "/scripts/package_xpi.py", fileURLToPath(stage), root + `/dist/reader-local-ai-${manifest.version}.xpi`], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
