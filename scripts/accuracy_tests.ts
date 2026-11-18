import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { LlamaClient } from "../src/client.ts";
import { DEFAULTS } from "../src/config.ts";
import { buildMessages } from "../src/prompt.ts";
import { detectLanguage, evaluateAnswer, formatIssues, wordCount, type AccuracyCheck, type ResponseLanguage } from "./accuracy_eval.ts";
import { JudgeClient, PROMPT_VERSION } from "./accuracy_judge.ts";
import type { Paper } from "../src/types.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const datasetPath = resolve(root, process.env.LFM_ACCURACY_DATASET ?? "experiments/accuracy-attention.json");
const dataset = JSON.parse(await readFile(datasetPath, "utf8"));
const papers = JSON.parse(await readFile(root + "experiments/data/papers.json", "utf8"));
const models = (process.env.LFM_ACCURACY_MODELS ?? process.env.LFM_ACCURACY_MODEL ?? "lfm2.5-2.6b")
  .split(",").map(value => value.trim()).filter(Boolean);
const precision = process.env.LFM_ACCURACY_PRECISION ?? "Q4_K_M";
const thinkBudget = process.env.LFM_ACCURACY_THINK_BUDGET ?? "512";
const contextTokens = Number(process.env.LFM_ACCURACY_CONTEXT ?? "32768");
const generationTokens = 4096;
const port = Number(process.env.LFM_ACCURACY_PORT ?? "18096");
const externalUrl = process.env.LFM_ACCURACY_URL;
const timeoutMs = Number(process.env.LFM_ACCURACY_TIMEOUT_MS ?? "600000");
const resultsDir = resolve(root, process.env.LFM_ACCURACY_RESULTS_DIR ?? "experiments/results");
const output = resolve(root, process.env.LFM_ACCURACY_OUTPUT ?? "experiments/results/accuracy-attention-q4.csv");
const evaluator = (process.env.LFM_ACCURACY_EVALUATOR ?? "regex").toLowerCase();
if (evaluator !== "regex" && evaluator !== "judge") throw new Error("LFM_ACCURACY_EVALUATOR deve ser regex ou judge.");
const summaryName = process.env.LFM_ACCURACY_SUMMARY ?? "accuracy-attention-summary.json";
const datasetMaxWords = Number(dataset.maxWords ?? 150);
const runId = new Date().toISOString();
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

interface AccuracyCase {
  id: string;
  paper: string;
  category: string;
  selectionPhrase: string;
  question: string;
  responseLanguage: ResponseLanguage;
  expected: string;
  checks?: AccuracyCheck[];
  keyfacts?: string[];
  evidence?: string;
  absent?: boolean;
  maxWords?: number;
}
interface Row {
  timestamp: string;
  run_id: string;
  model: string;
  precision: string;
  reasoning_budget: string;
  evaluator: string;
  case_id: string;
  category: string;
  response_language: string;
  detected_language: string;
  paper_id: string;
  selection: string;
  question: string;
  expected_answer: string;
  answer: string;
  status: string;
  word_count: number | string;
  content_passed: number | string;
  content_total: number | string;
  instruction_passed: number | string;
  instruction_total: number | string;
  language_passed: string;
  all_checks_passed: string;
  content_aligned: string;
  accuracy_percent: string;
  judge_model: string;
  claims: number | string;
  supported: number | string;
  contradicted: number | string;
  not_in_source: number | string;
  irrelevant: number | string;
  precision_percent: string;
  coverage_percent: string;
  format_issues: string;
  direct_answers_question: string;
  direct_no_unrequested: string;
  direct_didactic: string;
  directness_passed: string;
  directness_json: string;
  failed_checks: string;
  judge_json: string;
  prompt_tokens: number | string;
  completion_tokens: number | string;
  total_ms: number | string;
  error: string;
}
interface ServerHandle {
  process: ChildProcess;
  logPath: string;
  python: string;
}
interface SummaryRow {
  model: string;
  precision: string;
  cases: number;
  ok: number;
  errors: number;
  content_aligned: number;
  all_checks_passed: number;
  average_accuracy_percent: number;
  average_words: number;
  claims: number;
  supported: number;
  contradicted: number;
  not_in_source: number;
  fact_precision: number;
  contradiction_rate: number;
  coverage_rate: number | null;
  directness_passed: number;
  directness_rate: number;
  format_failures: number;
}

function csv(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function pythonCandidates(): { command: string; prefix: string[] }[] {
  if (process.env.PYTHON) return [{ command: process.env.PYTHON, prefix: [] }];
  if (process.platform === "win32") return [
    { command: "python", prefix: [] },
    { command: "py", prefix: ["-3"] },
    { command: "python3", prefix: [] },
  ];
  return [{ command: "python3", prefix: [] }, { command: "python", prefix: [] }];
}

async function waitForHealth(server: ChildProcess, logPath: string, spawnError: () => string): Promise<boolean> {
  for (let attempt = 0; attempt < 360; attempt++) {
    if (server.exitCode !== null || spawnError()) return false;
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok) return true;
    } catch {}
    await pause(500);
  }
  const tail = await readFile(logPath, "utf8").catch(() => "");
  throw new Error("O servidor não ficou pronto em 180 s. Log: " + logPath + "\n" + tail.slice(-4000));
}

async function startServer(model: string): Promise<ServerHandle> {
  await mkdir(root + ".runtime", { recursive: true });
  for (const candidate of pythonCandidates()) {
    const logPath = root + `.runtime/accuracy-${model}-${precision}.log`;
    const logFd = openSync(logPath, "a");
    const args = [...candidate.prefix, root + "scripts/serve.py", "--model", model, "--precision", precision,
      "--port", String(port), "--context", String(contextTokens)];
    const server = spawn(candidate.command, args, { cwd: root, env: { ...process.env, LLAMA_ARG_THINK_BUDGET: thinkBudget }, stdio: ["ignore", logFd, logFd] });
    closeSync(logFd);
    let error = "";
    server.on("error", value => { error = String(value); });
    if (await waitForHealth(server, logPath, () => error)) return { process: server, logPath, python: candidate.command };
    server.kill("SIGTERM");
    for (let i = 0; i < 30 && server.exitCode === null; i++) await pause(100);
    if (server.exitCode === null) server.kill("SIGKILL");
    if (!error.includes("ENOENT")) {
      const tail = await readFile(logPath, "utf8").catch(() => "");
      throw new Error("Falha ao iniciar o runtime. Log: " + logPath + "\n" + tail.slice(-4000));
    }
  }
  throw new Error("Python não encontrado. Defina PYTHON com o caminho do interpretador.");
}

async function stopServer(server: ChildProcess | undefined): Promise<void> {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  for (let i = 0; i < 100 && server.exitCode === null; i++) await pause(100);
  if (server.exitCode === null) server.kill("SIGKILL");
}

function paperFor(id: string): Paper {
  const info = papers.find((paper: any) => paper.id === id);
  if (!info) throw new Error("Paper desconhecido: " + id);
  return {
    text: requireText(id),
    title: info.title,
    extractedPages: info.pages,
    totalPages: info.pages,
  };
}

function requireText(id: string): string {
  return paperTexts.get(id) ?? "";
}

const paperTexts = new Map<string, string>();
for (const info of papers) paperTexts.set(info.id, await readFile(root + `experiments/data/${info.id}.txt`, "utf8"));

const allRows: Row[] = [];
const summaries: SummaryRow[] = [];
const judge = evaluator === "judge" ? new JudgeClient() : undefined;
let activeServer: ChildProcess | undefined;
let interrupted = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { interrupted = true; void stopServer(activeServer); });
}

function average(rows: Row[], field: keyof Row): number {
  const values = rows.map(row => Number(row[field])).filter(value => Number.isFinite(value));
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

const columns: (keyof Row)[] = ["timestamp", "run_id", "model", "precision", "reasoning_budget", "evaluator",
  "case_id", "category", "response_language", "detected_language", "paper_id", "selection", "question",
  "expected_answer", "answer", "status", "word_count", "content_passed", "content_total", "instruction_passed",
  "instruction_total", "language_passed", "all_checks_passed", "content_aligned", "accuracy_percent",
  "judge_model", "claims", "supported", "contradicted", "not_in_source", "irrelevant", "precision_percent",
  "coverage_percent", "format_issues", "direct_answers_question", "direct_no_unrequested", "direct_didactic",
  "directness_passed", "directness_json", "failed_checks", "judge_json", "prompt_tokens", "completion_tokens", "total_ms", "error"];

async function writeCsv(path: string): Promise<void> {
  await mkdir(resultsDir, { recursive: true });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, columns.join(",") + "\n" + allRows.map(row => columns.map(column => csv(row[column])).join(",")).join("\n") + "\n");
}

try {
  if (externalUrl && models.length !== 1) throw new Error("LFM_ACCURACY_URL aceita apenas um modelo por execução.");
  for (const model of models) {
    if (interrupted) break;
    const baseUrl = externalUrl ?? `http://127.0.0.1:${port}`;
    const server = externalUrl ? undefined : await startServer(model);
    activeServer = server?.process;
    const client = new LlamaClient(fetch, { ...DEFAULTS, baseUrl, model,
      contextTokens, generationTokens, timeoutMs });
    console.log(`Modelo ${model}, ${precision}, contexto ${contextTokens}, servidor ${baseUrl}, avaliador ${evaluator}`);
    try {
      for (const test of dataset.cases as AccuracyCase[]) {
        if (interrupted) break;
        const paper = paperFor(test.paper);
        const row: Row = {
          timestamp: runId, run_id: `${model}/${precision}`, model, precision, reasoning_budget: thinkBudget,
          evaluator, case_id: test.id, category: test.category,
          response_language: test.responseLanguage, detected_language: "", paper_id: test.paper,
          selection: test.selectionPhrase, question: test.question, expected_answer: test.expected, answer: "",
          status: "error", word_count: "", content_passed: "", content_total: "", instruction_passed: "",
          instruction_total: "", language_passed: "", all_checks_passed: "", content_aligned: "",
          accuracy_percent: "", judge_model: "", claims: "", supported: "", contradicted: "",
          not_in_source: "", irrelevant: "", precision_percent: "", coverage_percent: "",
          format_issues: "", direct_answers_question: "", direct_no_unrequested: "", direct_didactic: "",
          directness_passed: "", directness_json: "",
          failed_checks: "", judge_json: "", prompt_tokens: "", completion_tokens: "", total_ms: "", error: "",
        };
        const started = performance.now();
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const messages = buildMessages(paper, test.selectionPhrase, test.question);
          const generated = await client.generate(messages, controller.signal, () => {}, false);
          const base = {
            status: "ok", answer: generated.answer, prompt_tokens: generated.promptTokens,
            completion_tokens: generated.completionTokens ?? "", total_ms: Math.round(performance.now() - started),
          };
          if (evaluator === "judge") {
            const judged = await judge!.evaluate(test.question, generated.answer, paper.text, test.keyfacts ?? []);
            const words = wordCount(generated.answer);
            const detectedLanguage = detectLanguage(generated.answer);
            const languagePassed = detectedLanguage === test.responseLanguage;
            const reasoningLeak = /<\/?(?:think|reasoning)>|reasoning_content/i.test(generated.answer);
            const issues = formatIssues(generated.answer);
            const limit = test.maxWords ?? datasetMaxWords;
            const instructionPassed = words <= limit && !reasoningLeak && issues.length === 0;
            const contentAligned = judged.claims.length > 0 && judged.contradicted === 0 && judged.notInSource === 0;
            const directness = judged.directness;
            const directnessPassed = judged.directnessPassed;
            const failed = judged.claims.filter(claim => claim.label === "contradicted" || claim.label === "not_in_source")
              .map(claim => `${claim.label}:${claim.id}`);
            if (issues.length) failed.push(`format:${issues.join(",")}`);
            if (!directnessPassed) failed.push("directness");
            Object.assign(row, base, {
              evaluator: "judge", judge_model: judged.judgeModel,
              word_count: words, detected_language: detectedLanguage,
              claims: judged.claims.length, supported: judged.supported, contradicted: judged.contradicted,
              not_in_source: judged.notInSource, irrelevant: judged.irrelevant,
              precision_percent: (judged.precision * 100).toFixed(1),
              coverage_percent: judged.coverageRate === null ? "" : (judged.coverageRate * 100).toFixed(1),
              format_issues: issues.join(";"),
              direct_answers_question: String(directness.answersQuestion),
              direct_no_unrequested: String(directness.noUnrequestedContent),
              direct_didactic: String(directness.didactic),
              directness_passed: String(directnessPassed),
              directness_json: JSON.stringify(directness),
              judge_json: JSON.stringify(judged.claims),
              content_passed: judged.supported, content_total: judged.claims.length,
              instruction_passed: instructionPassed ? 1 : 0, instruction_total: 1,
              language_passed: String(languagePassed),
              all_checks_passed: String(contentAligned && languagePassed && instructionPassed && directnessPassed),
              content_aligned: String(contentAligned && languagePassed),
              accuracy_percent: (judged.precision * 100).toFixed(1),
              failed_checks: failed.join(";"),
            });
            console.log(`${contentAligned && languagePassed && instructionPassed && directnessPassed ? "PASS" : "FAIL"} ${test.id}: ` +
              `${judged.supported}/${judged.claims.length} suportados, ${judged.contradicted} contraditos, ` +
              `${judged.notInSource} fora da fonte, ${(judged.precision * 100).toFixed(1)}%` +
              (judged.coverageRate === null ? "" : `, cobertura ${(judged.coverageRate * 100).toFixed(1)}%`) +
              `, direção ${directnessPassed ? "ok" : "falhou"}` +
              (row.failed_checks ? ` — ${row.failed_checks}` : ""));
          } else {
            if (!test.checks?.length) throw new Error(`Caso ${test.id} não tem checks para o avaliador regex.`);
            const evaluation = evaluateAnswer(generated.answer, test.checks);
            Object.assign(row, base, {
              word_count: evaluation.wordCount,
              content_passed: evaluation.contentPassed, content_total: evaluation.contentTotal,
              instruction_passed: evaluation.instructionPassed, instruction_total: evaluation.instructionTotal,
              language_passed: evaluation.languagePassed === null ? "" : String(evaluation.languagePassed),
              all_checks_passed: String(evaluation.allChecksPassed), content_aligned: String(evaluation.contentAligned),
              detected_language: evaluation.detectedLanguage,
              accuracy_percent: evaluation.accuracyPercent.toFixed(1),
              failed_checks: evaluation.failedChecks.join(";"),
            });
            console.log(`${evaluation.allChecksPassed ? "PASS" : "FAIL"} ${test.id}: ${evaluation.contentPassed}/${evaluation.contentTotal} conteúdo, ` +
              `${evaluation.instructionPassed}/${evaluation.instructionTotal} instrução, ${evaluation.accuracyPercent.toFixed(1)}%` +
              (evaluation.failedChecks.length ? ` — ${evaluation.failedChecks.join(",")}` : ""));
          }
        } catch (error) {
          Object.assign(row, { status: "error", error: String(error), total_ms: Math.round(performance.now() - started) });
          console.error(`ERROR ${test.id}: ${String(error)}`);
        } finally {
          clearTimeout(timer);
        }
        allRows.push(row);
        await writeCsv(output);
      }
    } finally {
      await stopServer(server?.process);
      activeServer = undefined;
    }
    const rows = allRows.filter(row => row.model === model && row.status === "ok");
    const claimCount = rows.reduce((sum, row) => sum + (Number(row.claims) || 0), 0);
    const supported = rows.reduce((sum, row) => sum + (Number(row.supported) || 0), 0);
    const contradicted = rows.reduce((sum, row) => sum + (Number(row.contradicted) || 0), 0);
    const coverageRows = rows.filter(row => row.coverage_percent !== "");
    summaries.push({
      model, precision, cases: allRows.filter(row => row.model === model).length,
      ok: rows.length, errors: allRows.filter(row => row.model === model && row.status !== "ok").length,
      content_aligned: rows.filter(row => row.content_aligned === "true").length,
      all_checks_passed: rows.filter(row => row.all_checks_passed === "true").length,
      average_accuracy_percent: average(rows, "accuracy_percent"),
      average_words: average(rows, "word_count"),
      claims: claimCount, supported, contradicted,
      not_in_source: rows.reduce((sum, row) => sum + (Number(row.not_in_source) || 0), 0),
      fact_precision: claimCount ? supported / claimCount : 0,
      contradiction_rate: claimCount ? contradicted / claimCount : 0,
      coverage_rate: coverageRows.length ? average(coverageRows, "coverage_percent") / 100 : null,
      directness_passed: rows.filter(row => row.directness_passed === "true").length,
      directness_rate: rows.length ? rows.filter(row => row.directness_passed === "true").length / rows.length : 0,
      format_failures: rows.filter(row => row.format_issues !== "").length,
    });
  }
} finally {
  await stopServer(activeServer);
  await mkdir(resultsDir, { recursive: true });
  await writeCsv(output);
  await writeFile(resultsDir + "/" + summaryName, JSON.stringify({
    timestamp: runId, dataset: dataset.source, paper: dataset.paper ?? dataset.papers ?? null,
    datasetPath: relative(root, datasetPath), precision, contextTokens, thinkBudget, evaluator,
    judgeModel: judge?.config.model ?? null, promptVersion: evaluator === "judge" ? PROMPT_VERSION : null,
    cases: dataset.cases.length, models: summaries,
    total: { cases: allRows.length, ok: allRows.filter(row => row.status === "ok").length,
      content_aligned: allRows.filter(row => row.content_aligned === "true").length,
      all_checks_passed: allRows.filter(row => row.all_checks_passed === "true").length,
      claims: allRows.reduce((sum, row) => sum + (Number(row.claims) || 0), 0),
      supported: allRows.reduce((sum, row) => sum + (Number(row.supported) || 0), 0),
      contradicted: allRows.reduce((sum, row) => sum + (Number(row.contradicted) || 0), 0),
      not_in_source: allRows.reduce((sum, row) => sum + (Number(row.not_in_source) || 0), 0) },
  }, null, 2) + "\n");
  console.log(`\nCSV: ${output}`);
  console.log(`Resumo: ${resultsDir}/${summaryName}`);
  for (const summary of summaries) {
    console.log(`${summary.model}: ${summary.content_aligned}/${summary.ok} alinhados, ` +
      `${summary.average_accuracy_percent.toFixed(1)}% de checks, ${summary.average_words.toFixed(1)} palavras/resposta, ${summary.errors} erros`);
    if (evaluator === "judge") {
      console.log(`  fidelidade ${(summary.fact_precision * 100).toFixed(1)}%, contradições ${(summary.contradiction_rate * 100).toFixed(1)}%, ` +
        `fora da fonte ${summary.not_in_source}, cobertura ${summary.coverage_rate === null ? "n/d" : (summary.coverage_rate * 100).toFixed(1) + "%"}, ` +
        `direção ${(summary.directness_rate * 100).toFixed(1)}%, formato ${summary.format_failures} falhas`);
    }
  }
}
