import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  detectLanguage,
  evaluateAnswer,
  formatIssues,
  normalizeAnswer,
  wordCount,
  type AccuracyCheck,
} from "../scripts/accuracy_eval.ts";

test("normalizes typographic quotes and whitespace", () => {
  assert.equal(normalizeAnswer("  O modelo ‘atende’\n bem  "), "o modelo 'atende' bem");
  assert.equal(wordCount("uma  resposta\ncom três palavras"), 5);
});

test("detects English and Brazilian Portuguese from prose", () => {
  assert.equal(detectLanguage("The attention output is a weighted sum of the values."), "en");
  assert.equal(detectLanguage("A saída da atenção é uma soma ponderada dos valores, que são combinados."), "pt-BR");
  assert.equal(detectLanguage("softmax"), "unknown");
});

test("detects the structural formats the answer policy forbids", () => {
  assert.deepEqual(formatIssues("A direct answer with a formula: \\(x^2\\)."), []);
  assert.deepEqual(formatIssues("## Heading\n- item"), ["heading", "list"]);
  assert.deepEqual(formatIssues("| a | b |\n|---|---|"), ["table"]);
  assert.deepEqual(formatIssues("```js\nconst x = 1;\n```"), ["code"]);
});

test("required checks accept any configured pattern", () => {
  const checks: AccuracyCheck[] = [{
    id: "score", category: "content", kind: "required",
    patterns: ["nao existe", "weighted.{0,40}values"], description: "pesos",
  }];
  const evaluation = evaluateAnswer("The result is a weighted sum of values.", checks);
  assert.equal(evaluation.contentPassed, 1);
  assert.equal(evaluation.contentAligned, true);
  assert.equal(evaluation.accuracyPercent, 100);
});

test("forbidden checks catch an invented score", () => {
  const checks: AccuracyCheck[] = [{
    id: "no-invention", category: "content", kind: "forbidden",
    patterns: ["mmlu.{0,30}score.{0,10}\\d"], description: "sem invenção",
  }];
  const evaluation = evaluateAnswer("The MMLU score is 70.0 in this paper.", checks);
  assert.equal(evaluation.contentPassed, 0);
  assert.deepEqual(evaluation.failedChecks, ["no-invention"]);
});

test("instruction, language and content are counted separately", () => {
  const checks: AccuracyCheck[] = [
    { id: "fact", category: "content", kind: "required", patterns: ["adam"], description: "otimizador" },
    { id: "short", category: "instruction", kind: "max_words", max: 2, description: "curta" },
    { id: "english", category: "language", kind: "language", expected: "en", description: "inglês" },
  ];
  const evaluation = evaluateAnswer("Adam is the optimizer.", checks);
  assert.equal(evaluation.contentPassed, 1);
  assert.equal(evaluation.instructionPassed, 0);
  assert.equal(evaluation.languagePassed, true);
  assert.equal(evaluation.contentAligned, true);
  assert.equal(evaluation.allChecksPassed, false);
  assert.ok(Math.abs(evaluation.accuracyPercent - 66.66666666666666) < 0.0001);
});

test("an absent-fact refusal passes only when it refuses and does not invent", () => {
  const checks: AccuracyCheck[] = [
    {
      id: "refusal", category: "content", kind: "required",
      patterns: ["not (?:reported|included)|does not report|no information"],
      description: "recusa",
    },
    {
      id: "no-score", category: "content", kind: "forbidden",
      patterns: ["mmlu.{0,30}score.{0,10}\\d"],
      description: "sem nota inventada",
    },
    { id: "english", category: "language", kind: "language", expected: "en", description: "inglês" },
  ];
  const refusal = evaluateAnswer("The article does not report an MMLU score.", checks);
  assert.equal(refusal.allChecksPassed, true);
  const invented = evaluateAnswer("The article does not report it, but the MMLU score is 70.", checks);
  assert.equal(invented.allChecksPassed, false);
  assert.deepEqual(invented.failedChecks, ["no-score"]);
});

test("the real-paper dataset has one valid case per planned question", async () => {
  const raw = await readFile(new URL("../experiments/accuracy-attention.json", import.meta.url), "utf8");
  const dataset = JSON.parse(raw);
  assert.equal(dataset.paper, "attention");
  assert.equal(dataset.source, "arXiv:1706.03762v1");
  assert.equal(dataset.cases.length, 11);
  const ids = new Set<string>();
  for (const item of dataset.cases) {
    assert.ok(!ids.has(item.id), `caso duplicado: ${item.id}`);
    ids.add(item.id);
    assert.ok(item.selectionPhrase && item.question && item.expected);
    assert.ok(item.checks.some((check: AccuracyCheck) => check.category === "content"));
    for (const check of item.checks as AccuracyCheck[]) {
      if (check.kind === "required" || check.kind === "forbidden") {
        for (const pattern of check.patterns) assert.doesNotThrow(() => new RegExp(pattern, "iu"));
      }
    }
  }
  assert.deepEqual([...ids], [
    "attention-definition", "attention-scaling", "attention-multihead", "attention-architecture",
    "attention-masking", "attention-positional", "attention-training", "attention-results",
    "attention-absent", "attention-formula", "attention-definition-pt",
  ]);
});
