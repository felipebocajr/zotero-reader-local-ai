import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, DEFAULT_SEPARATORS, normalizePaperText, splitRecursive } from "../src/chunking.ts";
import type { ChunkBoundary, TextChunk } from "../src/chunking.ts";

const root = resolve(new URL("../", import.meta.url).pathname);
const inputs = process.argv.slice(2);
const paths = inputs.length ? inputs : [resolve(root, "experiments/data")];

async function filesUnder(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  return (await readdir(path)).filter(file => file.endsWith(".txt")).sort().map(file => resolve(path, file));
}

function boundaryCounts(chunks: readonly TextChunk[]): Record<ChunkBoundary, number> {
  const counts: Record<ChunkBoundary, number> = { paragraph: 0, line: 0, sentence: 0, word: 0, char: 0, end: 0 };
  for (const chunk of chunks) counts[chunk.boundary]++;
  return counts;
}

function naturalPercent(counts: Record<ChunkBoundary, number>, total: number): number {
  if (!total) return 0;
  return ((total - counts.char) / total) * 100;
}

function excerpt(value: string, fromEnd: boolean, length = 100): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return fromEnd ? compact.slice(-length) : compact.slice(0, length);
}

const rows: string[] = [];
const examples: string[] = [];
for (const file of (await Promise.all(paths.map(filesUnder))).flat()) {
  const source = normalizePaperText(await readFile(file, "utf8"));
  const chunks = splitRecursive(source);
  const counts = boundaryCounts(chunks);
  const maxCore = Math.max(...chunks.map(chunk => chunk.coreText.length));
  const maxText = Math.max(...chunks.map(chunk => chunk.text.length));
  const headings = new Set(chunks.map(chunk => chunk.heading).filter(Boolean)).size;
  rows.push([
    basename(file).padEnd(22),
    String(source.length).padStart(7),
    String(chunks.length).padStart(5),
    String(Math.round(source.length / Math.max(chunks.length, 1))).padStart(6),
    String(maxCore).padStart(6),
    String(maxText).padStart(6),
    `${naturalPercent(counts, chunks.length).toFixed(1)}%`.padStart(7),
    `${counts.paragraph}/${counts.line}/${counts.sentence}/${counts.word}/${counts.char}`.padStart(20),
    String(headings).padStart(4),
  ].join(" "));

  if (examples.length < 9) {
    for (const boundary of ["paragraph", "sentence", "word", "line"] as const) {
      const index = chunks.findIndex((chunk, position) => chunk.boundary === boundary && position + 1 < chunks.length);
      if (index < 0 || examples.some(example => example.includes(`[${basename(file)} ${boundary}]`))) continue;
      const current = chunks[index], next = chunks[index + 1];
      examples.push(`[${basename(file)} ${boundary}]\n` +
        `  fim  : …${excerpt(current.coreText, true, 110)}\n` +
        `  início: ${excerpt(next.coreText, false, 110)}…\n` +
        `  heading: ${current.heading ?? "(nenhum)"} | ${current.coreText.length} + ${next.coreText.length} chars`);
      if (examples.length >= 9) break;
    }
  }
}

console.log(`Splitter: chunkSize=${DEFAULT_CHUNK_SIZE}, overlap=${DEFAULT_CHUNK_OVERLAP}, separators=${JSON.stringify(DEFAULT_SEPARATORS)}`);
console.log("arquivo                 chars chunks  média  maxCore maxText natural  pár/linha/frase/palavra/char  head");
console.log(rows.join("\n"));
console.log("\nExemplos de fronteiras reais:");
console.log(examples.join("\n\n"));
