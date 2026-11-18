import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  findHeadingSpans,
  normalizePaperText,
  splitRecursive,
} from "../src/chunking.ts";

const sentence = (number: number): string => `Sentence ${number} ` + "word ".repeat(70) + ". ";

test("short adjacent paragraphs stay in one chunk", () => {
  const text = "First paragraph.\n\nSecond paragraph.";
  const chunks = splitRecursive(text, { chunkSize: 100, chunkOverlap: 10 });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].coreText, text);
  assert.equal(chunks[0].boundary, "end");
});

test("an oversized paragraph is split at sentence boundaries", () => {
  const text = [1, 2, 3, 4, 5].map(sentence).join("");
  const chunks = splitRecursive(text, { chunkSize: 1000, chunkOverlap: 80 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.coreText.length <= 1000);
  for (const chunk of chunks.slice(0, -1)) assert.equal(chunk.boundary, "sentence");
  // No sentence was cut in the middle: every chunk after the first begins on a word.
  for (const chunk of chunks.slice(1)) assert.match(chunk.coreText, /^Sentence \d/);
});

test("falls back to line boundaries when sentence punctuation is absent", () => {
  const line = "table row without punctuation ".repeat(8) + "\n";
  const chunks = splitRecursive(line.repeat(10), { chunkSize: 600, chunkOverlap: 50 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks.slice(0, -1)) assert.equal(chunk.boundary, "line");
});

test("an oversized sentence is split at word boundaries, never inside a word", () => {
  const text = "word ".repeat(500) + "end.";
  const chunks = splitRecursive(text, { chunkSize: 400, chunkOverlap: 40 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.coreText.length <= 400);
  for (const chunk of chunks.slice(0, -1)) assert.equal(chunk.boundary, "word");
  for (const chunk of chunks.slice(1)) assert.ok(chunk.coreText.startsWith("word"));
  assert.equal(chunks[chunks.length - 1].coreText.trimEnd().endsWith("end."), true);
});

test("unbroken text falls back to character chunks", () => {
  const chunks = splitRecursive("x".repeat(2500), { chunkSize: 1000, chunkOverlap: 100 });
  assert.deepEqual(chunks.map(chunk => chunk.coreText.length), [1000, 1000, 500]);
  assert.equal(chunks[0].boundary, "char");
  assert.equal(chunks[1].boundary, "char");
  assert.equal(chunks[2].boundary, "end");
});

test("overlap starts on a word boundary and does not accumulate", () => {
  const text = "alpha ".repeat(300);
  const chunks = splitRecursive(text, { chunkSize: 600, chunkOverlap: 100 });
  assert.ok(chunks.length >= 3);
  for (let index = 1; index < chunks.length; index++) {
    const current = chunks[index];
    assert.ok(current.textStart < current.start, "expected an overlap prefix");
    const prefix = text.slice(current.textStart, current.start);
    assert.ok(prefix.length <= 100);
    assert.ok(prefix.startsWith("alpha"));
    assert.ok(chunks[index - 1].coreText.endsWith(prefix));
    assert.ok(current.text.startsWith(prefix));
  }
});

test("headings are attached, but formulas and table rows are not headings", () => {
  const text = "2. Methods\n\n" + "Method text. ".repeat(5) + "\n\n3. Results\n\n" + "Result text. ".repeat(5);
  const chunks = splitRecursive(text, { chunkSize: 120, chunkOverlap: 0 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, "2. Methods");
  assert.equal(chunks[1].heading, "3. Results");
  const [formula] = splitRecursive("2 D1 (p, q)\n\nBody text.");
  assert.equal(formula.heading, undefined);
  const [table] = splitRecursive("5-shot 77.0 77.4\n\nBody text.");
  assert.equal(table.heading, undefined);
  const glued = normalizePaperText("1Introduction\nBody\n\n5.1Baselines\nBody\n\n6.1Which Weight Matrices?\nBody");
  assert.deepEqual(findHeadingSpans(glued).map(heading => heading.text),
    ["1Introduction", "5.1Baselines", "6.1Which Weight Matrices?"]);
  const falsePositives = normalizePaperText(
    "1Princeton University 2Meta 3NVIDIA\n\n" +
    "3.Compute fractional part:x frac =x− ⌊x⌋\n\n" +
    "4.Evaluate polynomial to get 2 xfrac\n\n" +
    "1FlashAttention-3does not run on B200\n\n" +
    "5.1Baselines\nBody");
  assert.deepEqual(findHeadingSpans(falsePositives).map(heading => heading.text), ["5.1Baselines"]);
  const lowercaseHeading = normalizePaperText("4.2 Gradient Analysis\nBody\n\n5 pRMSNorm\nThe re-scaling invariance...");
  assert.deepEqual(findHeadingSpans(lowercaseHeading).map(heading => heading.text), ["4.2 Gradient Analysis", "5 pRMSNorm"]);
});

test("chunks never cross a detected section heading", () => {
  const text = "Title\n\n1 Introduction\n\n" + "Intro sentence. ".repeat(40) +
    "\n\n2 Methods\n\n" + "Method sentence. ".repeat(40) +
    "\n\nReferences\n\n[1] A. Author. A paper title. 2024.";
  const chunks = splitRecursive(text, { chunkSize: 500, chunkOverlap: 50 });
  const headings = findHeadingSpans(text);
  for (const chunk of chunks) {
    for (const heading of headings) {
      assert.equal(heading.start > chunk.start && heading.start < chunk.end, false,
        `chunk ${chunk.index} crosses heading ${heading.text}`);
    }
  }
  assert.ok(chunks.some(chunk => chunk.heading === "1 Introduction"));
  assert.ok(chunks.some(chunk => chunk.heading === "2 Methods"));
  assert.ok(chunks.some(chunk => chunk.heading === "References"));
  assert.ok(chunks.filter(chunk => chunk.heading === "1 Introduction").length > 1);
});

test("CRLF and Zotero page form feeds are normalized", () => {
  const chunks = splitRecursive("Ação — atenção: 1,5×.\r\n\r\nPróximo parágrafo.\n\n\n\fTerceira página.", { chunkSize: 200 });
  assert.equal(chunks.length, 1);
  assert.match(chunks[0].coreText, /Ação — atenção/);
  assert.equal(chunks[0].coreText.includes("\r"), false);
  assert.equal(chunks[0].coreText.includes("\f"), false);
  assert.match(chunks[0].coreText, /Terceira página/);
});

test("invalid options are rejected", () => {
  assert.throws(() => splitRecursive("text", { chunkSize: 0 }), /chunkSize/);
  assert.throws(() => splitRecursive("text", { chunkSize: 100, chunkOverlap: 100 }), /chunkOverlap/);
});

test("every real article is fully covered without oversized chunks", async () => {
  const directory = new URL("../experiments/data/", import.meta.url);
  const files = (await readdir(directory)).filter(file => file.endsWith(".txt")).sort();
  assert.ok(files.length >= 5, "expected the paper corpus");
  for (const file of files) {
    const source = normalizePaperText(await readFile(new URL(file, directory), "utf8"));
    const chunks = splitRecursive(source);
    assert.ok(chunks.length > 0, `${file} must produce chunks`);
    for (const chunk of chunks) {
      assert.ok(chunk.coreText.length <= DEFAULT_CHUNK_SIZE, `${file}: core chunk too large`);
      assert.ok(chunk.text.length <= DEFAULT_CHUNK_SIZE + DEFAULT_CHUNK_OVERLAP, `${file}: prompt chunk too large`);
      assert.ok(chunk.text.trim().length > 0, `${file}: empty chunk`);
      assert.equal(source.slice(chunk.start, chunk.end), chunk.coreText);
      assert.ok(chunk.start >= 0 && chunk.end <= source.length);
    }
    for (let index = 1; index < chunks.length; index++) {
      assert.ok(chunks[index].start >= chunks[index - 1].end, `${file}: chunks overlap in the source`);
    }
    assert.equal(
      chunks.map(chunk => chunk.coreText).join("").replace(/\s+/g, ""),
      source.replace(/\s+/g, ""),
      `${file}: splitter lost non-whitespace text`,
    );
    assert.ok(chunks.some(chunk => chunk.boundary === "paragraph" || chunk.boundary === "line" || chunk.boundary === "sentence"),
      `${file}: expected natural boundaries`);
  }
});
