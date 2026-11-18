import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingClient, cosineSimilarity, normalizeVector, validateEmbeddingBaseUrl } from "../src/embeddings.ts";
import type { FetchLike } from "../src/types.ts";

function vectorFor(text: string): number[] {
  const vector = [0.1, 0.1, 0.1, 0.1];
  if (/cache/i.test(text)) vector[0] = 2;
  if (/attention/i.test(text)) vector[1] = 2;
  if (/result/i.test(text)) vector[2] = 2;
  return vector;
}

function fixture() {
  const requests: { url: string; body: any }[] = [];
  const fetcher: FetchLike = async (url, init) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url, body });
    return new Response(JSON.stringify({
      data: body.input.map((text: string, index: number) => ({ index, embedding: vectorFor(text) })),
      usage: { prompt_tokens: body.input.length * 3, total_tokens: body.input.length * 3 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { client: new EmbeddingClient(fetcher, { baseUrl: "http://127.0.0.1:18081", batchSize: 2 }), requests };
}

test("embedding client sends batched OpenAI-compatible requests and normalizes vectors", async () => {
  const { client, requests } = fixture();
  const vectors = await client.embed(["cache", "attention", "result", "plain", "cache again"]);
  assert.equal(vectors.length, 5);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].url, "http://127.0.0.1:18081/v1/embeddings");
  assert.equal(requests[0].body.model, "qwen3-embedding-0.6b");
  assert.deepEqual(requests[0].body.input, ["cache", "attention"]);
  assert.ok(Math.abs(cosineSimilarity(vectors[0], vectors[4]) - 1) < 1e-6);
  for (const vector of vectors) {
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert.ok(Math.abs(norm - 1) < 1e-6);
  }
});

test("cosine similarity handles normalized and non-normalized vectors", () => {
  assert.ok(Math.abs(cosineSimilarity(normalizeVector(new Float32Array([3, 4])), new Float32Array([0.6, 0.8])) - 1) < 1e-6);
  assert.equal(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1])), 0);
  assert.throws(() => cosineSimilarity(new Float32Array([1]), new Float32Array([1, 0])), /dimensões/);
});

test("embedding client rejects non-loopback endpoints and reports HTTP errors", async () => {
  assert.throws(() => validateEmbeddingBaseUrl("https://example.com"), /127\.0\.0\.1/);
  assert.throws(() => validateEmbeddingBaseUrl("http://127.0.0.1:18081/path"), /sem caminho/);
  const client = new EmbeddingClient(async () => new Response("erro", { status: 500 }),
    { baseUrl: "http://127.0.0.1:18081" });
  await assert.rejects(client.embed(["texto"]), /HTTP 500/);
});
