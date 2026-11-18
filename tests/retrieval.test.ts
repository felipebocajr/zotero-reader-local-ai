import test from "node:test";
import assert from "node:assert/strict";
import { buildMessages } from "../src/prompt.ts";
import { RetrievalService } from "../src/retrieval.ts";
import { EmbeddingClient } from "../src/embeddings.ts";
import { DEFAULTS, RETRIEVAL_INPUT_TOKENS } from "../src/config.ts";
import { splitRecursive } from "../src/chunking.ts";
import type { FetchLike, Paper } from "../src/types.ts";

const text = [
  "1 Introduction\n\n",
  "This paper studies retrieval. ".repeat(80),
  "\n\n2 Cache\n\n",
  "The KV cache stores keys and values. ".repeat(400),
  "\n\n3 Results\n\n",
  "Results show a speedup. ".repeat(400),
  "\n\n4 References\n\n",
  "[1] Cache paper reference. ".repeat(200),
].join("");
const paper: Paper = { text, title: "Cache Paper", extractedPages: 1, totalPages: 1, signature: "cache-paper-v1" };

function vectorFor(value: string): number[] {
  const vector = [0.05, 0.05, 0.05, 0.05];
  if (/cache/i.test(value)) vector[0] = 2;
  if (/results?/i.test(value)) vector[1] = 2;
  if (/introduction|retrieval/i.test(value)) vector[2] = 2;
  return vector;
}

function fixture() {
  const requests: any[] = [];
  const fetcher: FetchLike = async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push(body);
    return new Response(JSON.stringify({
      data: body.input.map((value: string, index: number) => ({ index, embedding: vectorFor(value) })),
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { requests, client: new EmbeddingClient(fetcher, { baseUrl: "http://127.0.0.1:18081", batchSize: 64 }) };
}

test("retrieval keeps the selected passage chunk and fits the provider budget", async () => {
  const { client } = fixture();
  let ready = 0;
  const service = new RetrievalService({ client, ensureReady: async () => { ready++; }, model: "qwen3-embedding-0.6b", dimensions: 4 });
  const settings = { ...DEFAULTS, provider: "groq" as const };
  const context = await service.getContext(paper, "Results show a speedup.", "How does the KV cache work?",
    [], settings, "default", new AbortController().signal);
  assert.equal(ready, 1);
  assert.ok(context.chunks.length > 1);
  assert.ok(context.estimatedPromptTokens <= RETRIEVAL_INPUT_TOKENS.groq);
  assert.ok(context.chunks.some(chunk => chunk.heading === "2 Cache"));
  assert.ok(context.chunks.some(chunk => chunk.heading === "3 Results"));
  assert.ok(context.chunks.some(chunk => chunk.coreText.includes("Results show a speedup.")));
  assert.equal(context.chunks.some(chunk => chunk.heading === "4 References"), false);
  assert.equal(context.chunks.length, context.chunks.slice().sort((left, right) => left.start - right.start).length);
});

test("retrieval caches document embeddings and only embeds the query again", async () => {
  const { client, requests } = fixture();
  const service = new RetrievalService({ client, ensureReady: async () => {}, model: "qwen3-embedding-0.6b", dimensions: 4 });
  const settings = { ...DEFAULTS, provider: "groq" as const };
  const signal = new AbortController().signal;
  await service.getContext(paper, "Results show a speedup.", "How does the KV cache work?", [], settings, "default", signal);
  const afterFirst = requests.length;
  await service.getContext(paper, "Results show a speedup.", "How does the KV cache work?", [], settings, "default", signal);
  assert.equal(requests.length, afterFirst + 1);
  assert.match(requests.at(-1).input[0], /^Instruct:/);
});

test("retrieval prompt uses excerpts and the excerpt-specific insufficiency rule", () => {
  const chunks = splitRecursive(paper.text).slice(0, 2);
  const messages = buildMessages(paper, "Results show a speedup.", "How does the cache work?", [], "en", "default",
    { chunks, totalChunks: 20 });
  const system = messages[0].content;
  const user = messages[1].content;
  assert.match(system, /retrieved excerpts/i);
  assert.doesNotMatch(system, /its full text was provided/i);
  assert.match(user, /TRECHOS RECUPERADOS DO ARTIGO — 2 de 20/);
  assert.match(user, /TRECHO 1/);
  assert.equal(user.includes("ARTIGO COMPLETO"), false);
  assert.ok(user.length < text.length);
  const full = buildMessages(paper, "Results show a speedup.", "How does the cache work?");
  assert.match(full[1].content, /ARTIGO COMPLETO/);
  assert.match(full[0].content, /full article/i);
});
