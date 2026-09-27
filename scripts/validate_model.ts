import { readFile, mkdir, writeFile } from "node:fs/promises";
import { LlamaClient } from "../src/client.ts";
import { DEFAULTS } from "../src/config.ts";
import { buildMessages } from "../src/prompt.ts";
import type { Paper } from "../src/types.ts";

const root = new URL("../", import.meta.url);
const dataset = JSON.parse(await readFile(new URL("experiments/cases.json", root), "utf8"));
const manifest = JSON.parse(await readFile(new URL("experiments/data/papers.json", root), "utf8"));
const client = new LlamaClient(fetch, { ...DEFAULTS, baseUrl: process.env.LFM_SERVER_URL ?? "http://127.0.0.1:18080" });
const selected = ["attention-definition", "rmsnorm-cross-section", "llada-absent"];
const results = [];
await mkdir(new URL("experiments/results/", root), { recursive: true });
for (const id of selected) {
  const test = dataset.cases.find((c: { id: string }) => c.id === id);
  const info = manifest.find((p: { id: string }) => p.id === test.paper);
  const paper: Paper = { text: await readFile(new URL(`experiments/data/${test.paper}.txt`, root), "utf8"), title: info.title, totalPages: info.pages, extractedPages: info.pages };
  const started = performance.now();
  let firstTextMs: number | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  try {
    const result = await client.generate(buildMessages(paper, test.selectionPhrase, test.question), controller.signal,
      () => { firstTextMs ??= performance.now() - started; }, false);
    results.push({ id, ...result, firstTextMs, totalMs: performance.now() - started });
    console.log(`${id}: ${result.promptTokens} tokens, ${((performance.now() - started) / 1000).toFixed(1)} s\n${result.answer}\n`);
  } catch (error) {
    results.push({ id, status: "error", error: String(error), totalMs: performance.now() - started });
    console.error(id, String(error));
  } finally { clearTimeout(timer); }
  await writeFile(new URL("experiments/results/model-validation.json", root), JSON.stringify(results, null, 2) + "\n");
}
