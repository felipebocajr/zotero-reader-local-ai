import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { LlamaClient } from "../src/client.ts";
import { DEFAULTS } from "../src/config.ts";
import { buildMessages } from "../src/prompt.ts";
import type { Paper } from "../src/types.ts";

// One full-paper inference. Run separately from the precision comparison.
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("experiments/data/papers.json", root), "utf8"));
const info = manifest.find((paper: { id: string }) => paper.id === "attention");
const paper: Paper = { text: await readFile(new URL("experiments/data/attention.txt", root), "utf8"),
  title: info.title, extractedPages: info.pages, totalPages: info.pages };
const backend = process.env.LFM_SMOKE_BACKEND ?? "cpu";
if (!["cpu", "cuda", "auto"].includes(backend)) throw new Error("LFM_SMOKE_BACKEND must be cpu, cuda or auto");
const precision = process.env.LFM_SMOKE_PRECISION ?? "Q4_K_M";
if (!["Q4_K_M", "Q8_0", "F16"].includes(precision)) throw new Error("Invalid LFM_SMOKE_PRECISION");
const model = process.env.LFM_SMOKE_MODEL ?? DEFAULTS.model;
const responseLanguage = process.env.LFM_SMOKE_LANGUAGE ?? DEFAULTS.responseLanguage;
if (responseLanguage !== "pt-BR" && responseLanguage !== "en") throw new Error("LFM_SMOKE_LANGUAGE must be pt-BR or en");
const client = new LlamaClient(fetch, { ...DEFAULTS, model, responseLanguage, baseUrl: process.env.LFM_SERVER_URL ?? "http://127.0.0.1:18087" });
const started = performance.now();
let firstVisibleMs: number | null = null;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), DEFAULTS.timeoutMs);
let row;
const question = process.env.LFM_SMOKE_QUESTION ?? "Explique a atenção por produto escalar escalonado descrita neste trecho.";
try {
  const generated = await client.generate(buildMessages(paper, "Scaled Dot-Product Attention",
    question, [], responseLanguage), controller.signal,
    () => { firstVisibleMs ??= performance.now() - started; }, false);
  if (generated.promptTokens !== generated.timings?.prompt_n) throw new Error("Preflight token count differs from actual server input");
  row = { status: "ok", question, model, responseLanguage, backend, precision, pages: info.pages, paperSha256: info.sha256,
    preflightMatchesRuntime: true, ...generated, firstVisibleMs, totalMs: performance.now() - started };
} catch (error) { row = { status: "error", model, responseLanguage, backend, precision, error: String(error), totalMs: performance.now() - started }; }
finally { clearTimeout(timer); }
const output = process.env.LFM_SMOKE_OUTPUT ? resolve(process.env.LFM_SMOKE_OUTPUT)
  : new URL(`experiments/results/${backend}-smoke.json`, root);
await writeFile(output, JSON.stringify(row, null, 2) + "\n");
console.log(`${backend}: ${row.status}, ${(row.totalMs / 1000).toFixed(1)} s`);
if (row.status !== "ok") process.exitCode = 1;
