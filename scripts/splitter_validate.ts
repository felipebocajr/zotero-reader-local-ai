import { readdir, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_SEPARATORS,
  findHeadingSpans,
  normalizePaperText,
  splitRecursive,
} from "../src/chunking.ts";
import type { ChunkBoundary } from "../src/chunking.ts";

const root = resolve(new URL("../", import.meta.url).pathname);
const inputs = process.argv.slice(2);
const directories = (inputs.length ? inputs : [resolve(root, "experiments/data"), resolve(root, ".runtime/zotero-splitter-corpus")]);

async function filesUnder(path: string): Promise<string[]> {
  try {
    const info = await stat(path);
    if (info.isFile()) return [path];
    return (await readdir(path)).filter(file => file.endsWith(".txt")).sort().map(file => resolve(path, file));
  } catch {
    return [];
  }
}

const results: any[] = [];
let failed = false;
for (const directory of directories) {
  const files = await filesUnder(directory);
  for (const file of files) {
    const source = normalizePaperText(await readFile(file, "utf8"));
    const chunks = splitRecursive(source);
    const headingSpans = findHeadingSpans(source);
    const errors: string[] = [];
    if (!chunks.length) errors.push("no chunks");
    const boundaries: Record<ChunkBoundary, number> = { paragraph: 0, line: 0, sentence: 0, word: 0, char: 0, end: 0 };
    for (const chunk of chunks) {
      boundaries[chunk.boundary]++;
      if (chunk.coreText.length > DEFAULT_CHUNK_SIZE) errors.push(`chunk ${chunk.index} core is ${chunk.coreText.length} chars`);
      if (chunk.text.length > DEFAULT_CHUNK_SIZE + DEFAULT_CHUNK_OVERLAP) errors.push(`chunk ${chunk.index} prompt is ${chunk.text.length} chars`);
      if (!chunk.text.trim()) errors.push(`chunk ${chunk.index} is empty`);
      if (source.slice(chunk.start, chunk.end) !== chunk.coreText) errors.push(`chunk ${chunk.index} offsets do not match the source`);
      if (chunk.start < 0 || chunk.end > source.length || chunk.start >= chunk.end) errors.push(`chunk ${chunk.index} has invalid offsets`);
      if (headingSpans.some(heading => heading.start > chunk.start && heading.start < chunk.end)) {
        errors.push(`chunk ${chunk.index} crosses a section heading`);
      }
    }
    for (let index = 1; index < chunks.length; index++) {
      if (chunks[index].start < chunks[index - 1].end) errors.push(`chunk ${index} overlaps the previous core`);
    }
    if (chunks.map(chunk => chunk.coreText).join("").replace(/\s+/g, "") !== source.replace(/\s+/g, "")) {
      errors.push("splitter lost non-whitespace text");
    }
    const natural = chunks.filter(chunk => chunk.boundary !== "char").length;
    if (boundaries.char) errors.push(`${boundaries.char} chunk(s) ended inside an unbroken token`);
    if (errors.length) failed = true;
    results.push({
      source: basename(directory) === "zotero-splitter-corpus" ? "zotero-pdfworker" : "pdftotext-corpus",
      file: basename(file),
      chars: source.length,
      chunks: chunks.length,
      maxCoreChars: Math.max(...chunks.map(chunk => chunk.coreText.length)),
      maxPromptChars: Math.max(...chunks.map(chunk => chunk.text.length)),
      naturalPercent: chunks.length ? Number(((natural / chunks.length) * 100).toFixed(1)) : 0,
      boundaries,
      headings: headingSpans.length,
      errors,
    });
  }
}

const report = {
  splitter: {
    chunkSize: DEFAULT_CHUNK_SIZE,
    chunkOverlap: DEFAULT_CHUNK_OVERLAP,
    separators: DEFAULT_SEPARATORS,
    estimatedTokensPerChunk: Math.ceil((DEFAULT_CHUNK_SIZE + DEFAULT_CHUNK_OVERLAP) / 3.5),
  },
  directories: directories.map(directory => basename(directory)),
  passed: !failed,
  results,
};
console.log(JSON.stringify(report, null, 2));
if (failed) process.exitCode = 1;
