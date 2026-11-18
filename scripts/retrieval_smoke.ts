import { readFile } from "node:fs/promises";
import { EmbeddingClient } from "../src/embeddings.ts";
import { RetrievalService } from "../src/retrieval.ts";
import { buildMessages } from "../src/prompt.ts";
import { DEFAULTS } from "../src/config.ts";

const baseUrl = process.argv[2] ?? "http://127.0.0.1:18081";
const text = await readFile(".runtime/zotero-splitter-corpus/attention.txt", "utf8");
const paper = { text, title: "Attention Is All You Need", extractedPages: 15, totalPages: 15, signature: "attention-zotero-v1" };
const client = new EmbeddingClient((url, init) => fetch(url, init), { baseUrl, model: "qwen3-embedding-0.6b", batchSize: 16 });
const service = new RetrievalService({
  client,
  ensureReady: async () => {},
  model: "qwen3-embedding-0.6b",
  dimensions: 1024,
});
const settings = { ...DEFAULTS, provider: "groq" as const, retrievalMode: "embeddings" as const };
const question = "Como o artigo usa atenção para impedir que o decoder consulte tokens futuros?";
const context = await service.getContext(paper, "Scaled Dot-Product Attention", question, [], settings, "default", new AbortController().signal);
const messages = buildMessages(paper, "Scaled Dot-Product Attention", question, [], "default", context);
const result = {
  chunks: context.chunks.length,
  totalChunks: context.totalChunks,
  estimatedPromptTokens: context.estimatedPromptTokens,
  headings: context.chunks.map(chunk => chunk.heading),
  promptChars: messages.reduce((sum, message) => sum + message.content.length, 0),
  fullArticleIncluded: messages[1].content.includes(text),
  excerptHeader: messages[1].content.split("\n")[0],
};
console.log(JSON.stringify(result, null, 2));
