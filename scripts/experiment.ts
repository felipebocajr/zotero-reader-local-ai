import { readFile, writeFile, mkdir, appendFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { LlamaClient } from "../src/client.ts";
import { DEFAULTS } from "../src/config.ts";
import { buildMessages } from "../src/prompt.ts";
import type { Paper } from "../src/types.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const resultsDir = resolve(root, process.env.LFM_RESULTS_DIR ?? "experiments/results");
await mkdir(resultsDir, { recursive: true });
const dataset = JSON.parse(await readFile(root + "/experiments/cases.json", "utf8"));
const papers = JSON.parse(await readFile(root + "/experiments/data/papers.json", "utf8"));
const lock = JSON.parse(await readFile(root + "/runtime.lock.json", "utf8"));
const binary = process.env.LFM_BINARY;
const gpuLayers = Number(process.env.LFM_GPU_LAYERS ?? "0");
const backend = gpuLayers === 0 ? "cpu" : "cuda";
const port = Number(process.env.LFM_EXPERIMENT_PORT ?? "18084");
const precisions = process.env.LFM_PRECISIONS?.split(",") ?? ["Q4_K_M", "Q8_0", "F16"];
const repetitions = 3;
const settings = { ...DEFAULTS, baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 600000 };
let gpu = "CPU only";
try { gpu = (await exec("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader"])) .stdout.trim(); } catch {}
const fingerprint = createHash("sha256").update(JSON.stringify({ lock, dataset, papers, settings, binary, gpuLayers, repetitions }))
  .update(await readFile(root + "/src/prompt.ts")).update(await readFile(root + "/src/client.ts"))
  .update(await readFile(root + "/scripts/serve.py")).digest("hex");
const config = { fingerprint, runtime: lock, settings, backend, placementPolicy: "fixed-no-fallback", gpuLayers, binary: binary ?? `pinned ${backend.toUpperCase()}`, gpu, repetitions, cachePrompt: false, memorySamplingMs: { ram: 500, gpu: 1000 }, papers, started: new Date().toISOString() };
const configFile = resultsDir + "/experiment-config.json";
try {
  const previous = JSON.parse(await readFile(configFile, "utf8"));
  if (previous.fingerprint !== fingerprint) throw new Error("Configuração mudou. Use outro LFM_RESULTS_DIR para preservar os resultados existentes.");
} catch (error: any) { if (error.code !== "ENOENT") throw error; await writeFile(configFile, JSON.stringify(config, null, 2) + "\n"); }
const file = resultsDir + "/runs.jsonl";
let previous: any[] = [];
try { previous = (await readFile(file, "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
const completed = new Set(previous.map(row => `${row.precision}/${row.caseId}/${row.repeat}`));
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
let activeServer: ReturnType<typeof spawn> | undefined;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { interrupted = true; activeServer?.kill("SIGTERM"); });

for (const precision of precisions) {
  if (interrupted) break;
  const remaining = dataset.cases.some((test: any) => Array.from({ length: repetitions }, (_, i) => `${precision}/${test.id}/${i + 1}`).some(key => !completed.has(key)));
  if (!remaining) continue;
  if (!lock.model.variants[precision]) throw new Error("Precisão desconhecida: " + precision);
  const logPath = root + `/.runtime/experiment-${precision}.log`;
  const log = openSync(logPath, "a");
  const args = [root + "/scripts/serve.py", "--backend", backend, "--precision", precision, "--port", String(port), "--context", String(settings.contextTokens), "--threads", "8", "--gpu-layers", String(gpuLayers)];
  if (binary) args.push("--binary", binary);
  activeServer = spawn("python3", args, { cwd: root, stdio: ["ignore", log, log] });
  const server = activeServer;
  let launchError = "", ready = false;
  server.on("error", error => { launchError = String(error); });
  try {
    console.log(`Carregando ${precision}, camadas GPU=${gpuLayers}…`);
    for (let attempt = 0; attempt < 480 && !interrupted; attempt++) {
      if (server.exitCode !== null || launchError) break;
      try { ready = (await fetch(settings.baseUrl + "/health", { signal: AbortSignal.timeout(1000) })).ok; } catch {}
      if (ready) break;
      await pause(250);
    }
    if (!ready) {
      const tail = (await readFile(logPath, "utf8")).slice(-4000);
      throw new Error(/out of memory|failed to allocate|alloc.*failed/i.test(tail) ? "out-of-memory" : launchError || "server-start-failed; consulte " + logPath);
    }
    const client = new LlamaClient(fetch, settings);
    for (const test of dataset.cases) {
      const info = papers.find((p: any) => p.id === test.paper);
      const paper: Paper = { text: await readFile(root + `/experiments/data/${test.paper}.txt`, "utf8"), title: info.title, extractedPages: info.pages, totalPages: info.pages };
      for (let repeat = 1; repeat <= repetitions && !interrupted; repeat++) {
        const key = `${precision}/${test.id}/${repeat}`; if (completed.has(key)) continue;
        let ramPeakMiB = 0, ramHighwaterMiB = 0, gpuPeakMiB: number | null = null, gpuBusy = false;
        async function sampleRam() {
          try {
            const status = await readFile(`/proc/${server.pid}/status`, "utf8");
            ramPeakMiB = Math.max(ramPeakMiB, Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024);
            ramHighwaterMiB = Math.max(ramHighwaterMiB, Number(/VmHWM:\s+(\d+)/.exec(status)?.[1] ?? 0) / 1024);
          } catch {}
        }
        async function sampleGpu() {
          if (gpuBusy || !gpuLayers) return; gpuBusy = true;
          try {
            const output = await exec("nvidia-smi", ["--query-compute-apps=pid,used_gpu_memory", "--format=csv,noheader,nounits"], { timeout: 5000 });
            for (const line of output.stdout.split("\n")) { const [pid, memory] = line.split(",").map(value => Number(value.trim())); if (pid === server.pid && Number.isFinite(memory)) gpuPeakMiB = Math.max(gpuPeakMiB ?? 0, memory); }
          } catch {} finally { gpuBusy = false; }
        }
        await sampleRam(); await sampleGpu();
        const ramTimer = setInterval(() => { void sampleRam(); }, 500);
        const gpuTimer = setInterval(() => { void sampleGpu(); }, 1000);
        const start = performance.now(); let firstFinalTokenMs: number | null = null;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), settings.timeoutMs);
        let row: any = { fingerprint, precision, caseId: test.id, paperId: test.paper, repeat, paperSha256: info.sha256 };
        try {
          const generated = await client.generate(buildMessages(paper, test.selectionPhrase, test.question), controller.signal,
            () => { firstFinalTokenMs ??= performance.now() - start; }, false);
          row = { ...row, status: "ok", ...generated, firstFinalTokenMs, totalMs: performance.now() - start,
            words: generated.answer.split(/\s+/).length };
        } catch (error) { row = { ...row, status: "error", error: String(error), totalMs: performance.now() - start }; }
        finally { clearTimeout(timeout); clearInterval(ramTimer); clearInterval(gpuTimer); await sampleRam(); await sampleGpu(); }
        row = { ...row, ramPeakMiB, ramHighwaterMiB, gpuPeakMiB };
        await appendFile(file, JSON.stringify(row) + "\n"); completed.add(key); previous.push(row);
        console.log(`${completed.size}/135 ${precision} ${test.id} #${repeat}: ${row.status}, ${(row.totalMs / 1000).toFixed(1)} s`);
      }
      if (interrupted) break;
    }
  } catch (error) {
    console.error(precision, String(error));
    for (const test of dataset.cases) for (let repeat = 1; repeat <= repetitions; repeat++) {
      const key = `${precision}/${test.id}/${repeat}`; if (completed.has(key) || interrupted) continue;
      const row = { fingerprint, precision, caseId: test.id, paperId: test.paper, repeat, status: "startup-error", error: String(error) };
      await appendFile(file, JSON.stringify(row) + "\n"); completed.add(key); previous.push(row);
    }
  } finally {
    server.kill("SIGTERM");
    for (let i = 0; i < 40 && server.exitCode === null; i++) await pause(100);
    if (server.exitCode === null) server.kill("SIGKILL");
    closeSync(log); activeServer = undefined;
  }
}
const columns = ["precision", "caseId", "repeat", "status", "promptTokens", "completionTokens", "words", "firstFinalTokenMs", "totalMs", "ramPeakMiB", "ramHighwaterMiB", "gpuPeakMiB"];
await writeFile(resultsDir + "/metrics.csv", columns.join(",") + "\n" + previous.map(row => columns.map(key => row[key] ?? "").join(",")).join("\n") + "\n");
await writeFile(resultsDir + "/quality-review.csv", "precision,caseId,correctness_0_2,grounding_0_2,clarity_0_2,notes\n" + previous.filter(row => row.repeat === 1 && row.status === "ok").map(row => `${row.precision},${row.caseId},,,,`).join("\n") + "\n");
console.log(interrupted ? "Interrompido; resultados salvos para retomada com a mesma configuração." : `Comparação concluída. Resultados em ${resultsDir}.`);
