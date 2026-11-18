import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { splitRecursive } from "../src/chunking.ts";
import type { TextChunk } from "../src/chunking.ts";
import { EmbeddingClient, cosineSimilarity } from "../src/embeddings.ts";
import { buildMessages } from "../src/prompt.ts";
import { estimatePromptTokens } from "../src/tokens.ts";
import type { FetchLike, Paper } from "../src/types.ts";

interface CaseInfo { id: string; paper: string; selectionPhrase: string; question: string; evidenceSections: string[] }
interface Result {
  id: string;
  paper: string;
  evidenceSections: string[];
  anchor: number;
  anchorHeading?: string;
  our75: { chunks: number; tokens: number; hit: boolean; allHit: boolean; overBudget: boolean };
  megagon: { chunks: number; tokens: number; hit: boolean; allHit: boolean; overBudget: boolean; gap: number; cut: number; selectedTarget: number };
}

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const papersDir = resolve(process.argv[2] ?? resolve(root, ".runtime/zotero-splitter-corpus"));
const outPath = resolve(process.argv[3] ?? resolve(root, "experiments/results/retrieval-policy-comparison.json"));
const baseUrl = process.argv[4] ?? "http://127.0.0.1:18081";
const casesDoc = JSON.parse(await readFile(resolve(root, "experiments/cases.json"), "utf8")) as { papers: { id: string; title: string }[]; cases: CaseInfo[] };
const MAX_GROQ_INPUT_TOKENS = 5500;
const B = 5;

function normalize(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}
function sectionMatches(heading: string | undefined, evidence: string): boolean {
  const h = normalize(heading ?? "");
  const e = normalize(evidence).replace(/\.$/, "");
  if (!h || !e || e === "artigo completo") return false;
  if (e.includes("amostragem") || e.includes("sampling")) return /amostragem|sampling|appendix|apendice/.test(h);
  if (/^\d+(?:\.\d+)*$/.test(e)) return h.startsWith(e);
  return h.includes(e);
}
function estimate(paper: Paper, chunks: readonly TextChunk[], total: number, selection: string, question: string): number {
  return estimatePromptTokens(buildMessages(paper, selection, question, [], "en", "default", { chunks, totalChunks: total }));
}
function coverage(selected: ReadonlySet<number>, chunks: readonly TextChunk[], evidence: readonly string[]): { hit: boolean; allHit: boolean } {
  const sections = evidence.filter(section => normalize(section) !== "artigo completo");
  const covered = sections.map(section => [...selected].some(index => sectionMatches(chunks[index].heading, section)));
  return { hit: covered.some(Boolean), allHit: covered.length > 0 && covered.every(Boolean) };
}

const fetcher: FetchLike = (input, init) => fetch(input, init);
const client = new EmbeddingClient(fetcher, { baseUrl, model: "qwen3-embedding-0.6b", batchSize: 16 });
const results: Result[] = [];

for (const paperInfo of casesDoc.papers) {
  const paperCases = casesDoc.cases.filter(item => item.paper === paperInfo.id && !item.evidenceSections.some(section => normalize(section) === "artigo completo"));
  if (!paperCases.length) continue;
  const text = await readFile(resolve(papersDir, paperInfo.id + ".txt"), "utf8");
  const paper: Paper = { text, title: paperInfo.title, extractedPages: 1, totalPages: 1, signature: paperInfo.id + "-policy" };
  const chunks = splitRecursive(text);
  const documents = chunks.map(chunk => chunk.heading ? `${chunk.heading}\n${chunk.coreText}` : chunk.coreText);
  const vectors = await client.embed(documents);
  const queryVectors = await client.embed(paperCases.map(item =>
    `Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ${item.question}`));
  for (const [caseIndex, item] of paperCases.entries()) {
    const scores = vectors.map(vector => cosineSimilarity(queryVectors[caseIndex], vector));
    const rankedAll = chunks.map((_, index) => index).sort((left, right) => scores[right] - scores[left]);
    const ranked = rankedAll.filter(index => !/^(references?|bibliography)$/i.test(chunks[index].heading ?? ""));
    const wanted = normalize(item.selectionPhrase);
    const matching = chunks.filter(chunk => normalize(chunk.coreText).includes(wanted));
    const anchor = matching.length
      ? matching.reduce((best, chunk) => scores[chunk.index] > scores[best.index] ? chunk : best).index
      : ranked[0];
    const anchorHeading = chunks[anchor].heading;
    const mandatory = new Set<number>([anchor]);
    for (const offset of [-1, 1]) {
      const neighbor = anchor + offset;
      if (neighbor >= 0 && neighbor < chunks.length && chunks[neighbor].heading === anchorHeading) mandatory.add(neighbor);
    }

    const topScore = scores[ranked[0]];
    const closeEnough = ranked.filter(index => scores[index] >= topScore * 0.75).length;
    const ourTarget = Math.min(12, Math.max(4, closeEnough));
    const ourSelected = new Set(mandatory);
    for (const index of ranked) {
      if (ourSelected.size >= ourTarget) break;
      ourSelected.add(index);
    }

    const n = ranked.length;
    const sortedScores = ranked.map(index => scores[index]);
    const searchEnd = Math.min(n - 2, Math.max(0, Math.floor(n * 0.9) - 1));
    let gapIndex = 0, largestGap = -Infinity;
    for (let index = 0; index <= searchEnd; index++) {
      const gap = sortedScores[index] - sortedScores[index + 1];
      if (gap > largestGap) { largestGap = gap; gapIndex = index; }
    }
    const cut = gapIndex + 1;
    const megagonTarget = Math.min(n, cut + B);
    const megagonSelected = new Set(mandatory);
    for (const index of ranked) {
      if (megagonSelected.size >= megagonTarget) break;
      megagonSelected.add(index);
    }

    const build = (selected: ReadonlySet<number>) => {
      const chosen = [...selected].map(index => chunks[index]).sort((left, right) => left.start - right.start);
      return { chunks: chosen.length, tokens: estimate(paper, chosen, chunks.length, item.selectionPhrase, item.question), ...coverage(selected, chunks, item.evidenceSections) };
    };
    const ours = build(ourSelected);
    const mega = build(megagonSelected);
    results.push({
      id: item.id, paper: item.paper, evidenceSections: item.evidenceSections,
      anchor, anchorHeading,
      our75: { chunks: ours.chunks, tokens: ours.tokens, hit: ours.hit, allHit: ours.allHit, overBudget: ours.tokens > MAX_GROQ_INPUT_TOKENS },
      megagon: { chunks: mega.chunks, tokens: mega.tokens, hit: mega.hit, allHit: mega.allHit, overBudget: mega.tokens > MAX_GROQ_INPUT_TOKENS,
        gap: Number(largestGap.toFixed(4)), cut, selectedTarget: megagonTarget },
    });
    process.stderr.write(`${item.id}: 75%=${ours.chunks}/${ours.tokens}t Mega=${mega.chunks}/${mega.tokens}t\n`);
  }
}

const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);
const summary = {
  cases: results.length,
  our75: {
    avgChunks: Number(average(results.map(item => item.our75.chunks)).toFixed(1)),
    avgTokens: Math.round(average(results.map(item => item.our75.tokens))),
    hit: results.filter(item => item.our75.hit).length,
    allHit: results.filter(item => item.our75.allHit).length,
    overBudget: results.filter(item => item.our75.overBudget).length,
  },
  megagon: {
    avgChunks: Number(average(results.map(item => item.megagon.chunks)).toFixed(1)),
    avgTokens: Math.round(average(results.map(item => item.megagon.tokens))),
    hit: results.filter(item => item.megagon.hit).length,
    allHit: results.filter(item => item.megagon.allHit).length,
    overBudget: results.filter(item => item.megagon.overBudget).length,
  },
};
const report = { generatedAt: new Date().toISOString(), papersDir, model: "qwen3-embedding-0.6b", dimensions: 1024,
  policy: { our75: "score >= 75% of top, min 4, max 12, anchor+neighbors, references removed",
    megagon: "largest score gap in top 90%, cut + 5 buffer, anchor+neighbors, references removed" },
  maxGroqInputTokens: MAX_GROQ_INPUT_TOKENS, summary, results };
await writeFile(outPath, JSON.stringify(report, null, 2));

console.log("caso                         75% chunks/tokens  Mega chunks/tokens  evidência 75/Mega");
for (const item of results) {
  console.log(`${item.id.padEnd(28)} ${String(item.our75.chunks).padStart(3)} / ${String(item.our75.tokens).padStart(5)}       ${String(item.megagon.chunks).padStart(3)} / ${String(item.megagon.tokens).padStart(5)}       ${item.our75.allHit ? "all" : item.our75.hit ? "any" : "no "} / ${item.megagon.allHit ? "all" : item.megagon.hit ? "any" : "no"}`);
}
console.log("\nResumo");
console.log(JSON.stringify(summary, null, 2));
console.log("JSON:", outPath);
