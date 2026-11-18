import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { splitRecursive, DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from "../src/chunking.ts";
import type { TextChunk } from "../src/chunking.ts";
import { EmbeddingClient, cosineSimilarity, EMBEDDING_DEFAULT_MODEL } from "../src/embeddings.ts";
import type { FetchLike } from "../src/types.ts";

interface PaperInfo { id: string; title: string }
interface CaseInfo {
  id: string;
  paper: string;
  selectionPhrase: string;
  question: string;
  evidenceSections: string[];
}
interface RankedChunk { index: number; heading?: string; score: number }

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const argv = process.argv.slice(2);
function argument(name: string, fallback?: string): string | undefined {
  const index = argv.indexOf("--" + name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}
const papersDir = resolve(argument("papers-dir", resolve(root, "experiments/data"))!);
const casesPath = resolve(argument("cases", resolve(root, "experiments/cases.json"))!);
const outPath = resolve(argument("out", resolve(root, "experiments/results/embedding-retrieval-qwen3-0.6b.json"))!);
const baseUrl = argument("base-url", "http://127.0.0.1:18081")!;
const model = argument("model", EMBEDDING_DEFAULT_MODEL)!;
const limit = Number(argument("limit", "0"));
const topK = [5, 8, 12, 20];
const QUERY_INSTRUCTION = "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ";

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

function sectionMatches(heading: string | undefined, evidence: string): boolean {
  const value = normalize(heading ?? "");
  const wanted = normalize(evidence).replace(/\.$/, "");
  if (!value || !wanted || wanted === "artigo completo") return false;
  if (wanted.includes("amostragem") || wanted.includes("sampling")) {
    return /amostragem|sampling|appendix|apendice/.test(value);
  }
  if (/^\d+(?:\.\d+)*$/.test(wanted)) return value.startsWith(wanted);
  return value.includes(wanted);
}

function findAnchor(chunks: readonly TextChunk[], phrase: string): number | undefined {
  const wanted = normalize(phrase);
  return chunks.find(chunk => normalize(chunk.coreText).includes(wanted))?.index;
}

function rank(vector: Float32Array, documents: readonly Float32Array[]): number[] {
  return documents.map((document, index) => ({ index, score: cosineSimilarity(vector, document) }))
    .sort((left, right) => right.score - left.score)
    .map(item => item.index);
}

function evidenceMetrics(ranked: readonly number[], chunks: readonly TextChunk[], evidenceSections: readonly string[], k: number) {
  const sections = evidenceSections.filter(section => normalize(section) !== "artigo completo");
  const top = ranked.slice(0, k);
  const covered = sections.map(section => top.some(index => sectionMatches(chunks[index].heading, section)));
  return {
    hit: covered.some(Boolean),
    allHit: covered.length > 0 && covered.every(Boolean),
    covered: covered.filter(Boolean).length,
    sections: covered.length,
  };
}

function firstEvidenceRank(ranked: readonly number[], chunks: readonly TextChunk[], evidenceSections: readonly string[]): number | undefined {
  const sections = evidenceSections.filter(section => normalize(section) !== "artigo completo");
  const position = ranked.findIndex(index => sections.some(section => sectionMatches(chunks[index].heading, section)));
  return position >= 0 ? position + 1 : undefined;
}

const casesDocument = JSON.parse(await readFile(casesPath, "utf8")) as { papers: PaperInfo[]; cases: CaseInfo[] };
const allCases = limit > 0 ? casesDocument.cases.slice(0, limit) : casesDocument.cases;
const casesByPaper = new Map<string, CaseInfo[]>();
for (const testCase of allCases) {
  const list = casesByPaper.get(testCase.paper) ?? [];
  list.push(testCase);
  casesByPaper.set(testCase.paper, list);
}

const fetcher: FetchLike = (input, init) => fetch(input, init);
const client = new EmbeddingClient(fetcher, { baseUrl, model });
const papers: PaperInfo[] = casesDocument.papers.filter(paper => casesByPaper.has(paper.id));
const modes = [
  { id: "instruction", prefix: QUERY_INSTRUCTION },
  { id: "plain", prefix: "" },
] as const;
const summary: Record<string, any> = {};
for (const mode of modes) summary[mode.id] = { cases: 0, skippedFullArticle: 0, hits: Object.fromEntries(topK.map(k => [k, 0])), allHits: Object.fromEntries(topK.map(k => [k, 0])), mrr: 0 };
const caseResults: any[] = [];
const documentResults: any[] = [];
const started = Date.now();

for (const paper of papers) {
  const text = await readFile(resolve(papersDir, paper.id + ".txt"), "utf8");
  const chunks = splitRecursive(text);
  const documentTexts = chunks.map(chunk => chunk.heading ? `${chunk.heading}\n${chunk.coreText}` : chunk.coreText);
  const documentsStarted = Date.now();
  process.stderr.write(`Embeddings: ${paper.id} (${chunks.length} chunks)… `);
  const documentVectors = await client.embed(documentTexts);
  const documentSeconds = (Date.now() - documentsStarted) / 1000;
  process.stderr.write(`${documentSeconds.toFixed(1)}s\n`);
  documentResults.push({ paper: paper.id, title: paper.title, chunks: chunks.length, seconds: Number(documentSeconds.toFixed(2)) });

  const paperCases = casesByPaper.get(paper.id) ?? [];
  const queryVectors = new Map<string, Float32Array[]>();
  for (const mode of modes) {
    queryVectors.set(mode.id, await client.embed(paperCases.map(testCase => mode.prefix + testCase.question)));
  }

  for (const [caseIndex, testCase] of paperCases.entries()) {
    const fullArticle = testCase.evidenceSections.some(section => normalize(section) === "artigo completo");
    const anchorIndex = findAnchor(chunks, testCase.selectionPhrase);
    const entry: any = {
      id: testCase.id,
      paper: testCase.paper,
      question: testCase.question,
      evidenceSections: testCase.evidenceSections,
      anchorChunk: anchorIndex,
      anchorHeading: anchorIndex === undefined ? undefined : chunks[anchorIndex].heading,
      modes: {},
    };
    for (const mode of modes) {
      const ranked = rank(queryVectors.get(mode.id)![caseIndex], documentVectors);
      const metrics = Object.fromEntries(topK.map(k => [k, evidenceMetrics(ranked, chunks, testCase.evidenceSections, k)]));
      const firstRank = firstEvidenceRank(ranked, chunks, testCase.evidenceSections);
      const top = ranked.slice(0, 8).map(index => ({
        index,
        heading: chunks[index].heading,
        score: Number(cosineSimilarity(queryVectors.get(mode.id)![caseIndex], documentVectors[index]).toFixed(4)),
      }));
      entry.modes[mode.id] = { top, firstEvidenceRank: firstRank, mrr: firstRank ? 1 / firstRank : 0, metrics };
      if (!fullArticle) {
        summary[mode.id].cases++;
        for (const k of topK) {
          if (metrics[k].hit) summary[mode.id].hits[k]++;
          if (metrics[k].allHit) summary[mode.id].allHits[k]++;
        }
        summary[mode.id].mrr += firstRank ? 1 / firstRank : 0;
      } else {
        summary[mode.id].skippedFullArticle++;
      }
    }
    caseResults.push(entry);
    process.stderr.write(`  ${testCase.id}: anchor=${anchorIndex ?? "?"} ` +
      modes.map(mode => `${mode.id}=${entry.modes[mode.id].firstEvidenceRank ?? "–"}`).join(" ") + "\n");
  }
}

for (const mode of modes) {
  const data = summary[mode.id];
  data.mrr = data.cases ? Number((data.mrr / data.cases).toFixed(3)) : 0;
}

const report = {
  generatedAt: new Date().toISOString(),
  model,
  baseUrl,
  dimensions: 1024,
  chunkSize: DEFAULT_CHUNK_SIZE,
  chunkOverlap: DEFAULT_CHUNK_OVERLAP,
  queryInstruction: QUERY_INSTRUCTION.trim(),
  papersDir,
  papers: documentResults,
  summary,
  cases: caseResults,
  seconds: Number(((Date.now() - started) / 1000).toFixed(1)),
};
await writeFile(outPath, JSON.stringify(report, null, 2));

console.log(`Modelo: ${model} · ${report.dimensions} dimensões · ${report.papers.reduce((sum, paper) => sum + paper.chunks, 0)} chunks`);
console.log("modo         casos  hit@5  hit@8 hit@12 hit@20   MRR  all@12  all@20  completos");
for (const mode of modes) {
  const data = summary[mode.id];
  const row = [
    mode.id.padEnd(12),
    String(data.cases).padStart(5),
    ...[5, 8, 12, 20].map(k => String(data.hits[k]).padStart(6)),
    data.mrr.toFixed(3).padStart(6),
    String(data.allHits[12]).padStart(7),
    String(data.allHits[20]).padStart(7),
    String(data.skippedFullArticle).padStart(10),
  ];
  console.log(row.join(" "));
}
console.log(`\nJSON: ${outPath}`);
