import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JudgeClient, parseJsonObject } from "../scripts/accuracy_judge.ts";

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

test("judge JSON parser accepts plain objects and fenced JSON", () => {
  assert.deepEqual(parseJsonObject('{"ok":true}'), { ok: true });
  assert.deepEqual(parseJsonObject('```json\n{"ok":true}\n```'), { ok: true });
  assert.throws(() => parseJsonObject("not json"), /objeto JSON/);
});

test("judge decomposes, verifies and scores an answer against the article", async () => {
  const replies = [
    { claims: [{ id: "c1", text: "The method uses a block-wise cache." }] },
    { verdicts: [{ id: "c1", label: "supported", evidence: "block-wise cache", reason: "explicit" }] },
    { coverage: [{ keyfact: "k1", covered: true, evidence: "block-wise cache" }] },
    { answers_question: true, no_unrequested_content: true, didactic: true, reason: "direct" },
  ];
  let calls = 0;
  const fetcher = (async () => jsonResponse(replies[calls++])) as typeof fetch;
  const client = new JudgeClient({ apiKey: "test", model: "judge-test", baseUrl: "https://judge.test" }, fetcher);
  const result = await client.evaluate("What does it use?", "It uses a block-wise cache.", "The article uses a block-wise cache.", ["uses a block-wise cache"]);
  assert.equal(calls, 4);
  assert.equal(result.claims.length, 1);
  assert.equal(result.supported, 1);
  assert.equal(result.contradicted, 0);
  assert.equal(result.notInSource, 0);
  assert.equal(result.precision, 1);
  assert.equal(result.coverageRate, 1);
  assert.equal(result.directnessPassed, true);
  assert.equal(result.judgeModel, "judge-test");
});

test("a missing or unknown verdict becomes not_in_source instead of supported", async () => {
  const replies = [
    { claims: [{ id: "c1", text: "A claim." }, { id: "c2", text: "Another claim." }] },
    { verdicts: [{ id: "c1", label: "maybe", evidence: "", reason: "unclear" }] },
    { coverage: [] },
    { answers_question: true, no_unrequested_content: false, didactic: true, reason: "extra section" },
  ];
  let calls = 0;
  const fetcher = (async () => jsonResponse(replies[calls++])) as typeof fetch;
  const client = new JudgeClient({ apiKey: "test", model: "judge-test", baseUrl: "https://judge.test" }, fetcher);
  const result = await client.evaluate("q", "a", "article");
  assert.equal(result.supported, 0);
  assert.equal(result.notInSource, 2);
  assert.equal(result.precision, 0);
  assert.equal(result.coverageRate, null);
  assert.equal(result.directnessPassed, false);
});

test("the multi-paper benchmark has valid cases, evidence and selection phrases", async () => {
  const dataset = JSON.parse(await readFile(new URL("../experiments/accuracy-papers.json", import.meta.url), "utf8"));
  const papers = JSON.parse(await readFile(new URL("../experiments/data/papers.json", import.meta.url), "utf8"));
  assert.deepEqual(dataset.papers, ["flashattention4", "fastdllm"]);
  assert.equal(dataset.cases.length, 20);
  assert.equal(dataset.maxWords, 250);
  const counts = new Map<string, number>();
  const ids = new Set<string>();
  for (const item of dataset.cases) {
    assert.ok(!ids.has(item.id), `caso duplicado: ${item.id}`);
    ids.add(item.id);
    counts.set(item.paper, (counts.get(item.paper) ?? 0) + 1);
    assert.ok(item.question && item.expected && item.evidence && item.selectionPhrase);
    assert.ok(item.keyfacts.length >= 2, `keyfacts insuficientes: ${item.id}`);
    assert.ok(["en", "pt-BR"].includes(item.responseLanguage));
    const paper = papers.find((entry: { id: string }) => entry.id === item.paper);
    assert.ok(paper, `paper desconhecido: ${item.paper}`);
    const text = await readFile(new URL(`../experiments/data/${item.paper}.txt`, import.meta.url), "utf8");
    assert.ok(text.includes(item.selectionPhrase), `trecho não encontrado em ${item.paper}: ${item.selectionPhrase}`);
  }
  assert.equal(counts.get("flashattention4"), 10);
  assert.equal(counts.get("fastdllm"), 10);
  assert.equal(dataset.cases.filter((item: { absent: boolean }) => item.absent).length, 2);
});
