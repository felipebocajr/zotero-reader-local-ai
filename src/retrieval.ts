import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE, splitRecursive } from "./chunking.ts";
import type { TextChunk } from "./chunking.ts";
import { EMBEDDING_DIMENSIONS, RETRIEVAL_INPUT_TOKENS, RETRIEVAL_MAX_CHUNKS, RETRIEVAL_MIN_CHUNKS, RETRIEVAL_RELATIVE_FLOOR } from "./config.ts";
import { EmbeddingClient, cosineSimilarity } from "./embeddings.ts";
import { ReaderError } from "./errors.ts";
import { buildMessages } from "./prompt.ts";
import type { PromptMode, RetrievalContext } from "./prompt.ts";
import { estimatePromptTokens } from "./tokens.ts";
import type { Paper, Settings, Turn } from "./types.ts";

export const RETRIEVAL_QUERY_INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query";

export interface RetrievalServiceOptions {
  client: EmbeddingClient;
  ensureReady(signal?: AbortSignal): Promise<void>;
  model: string;
  dimensions?: number;
  instruction?: string;
  maxCacheEntries?: number;
}

export interface RetrievedContext extends RetrievalContext {
  estimatedPromptTokens: number;
}

interface RetrievalIndex {
  key: string;
  chunks: TextChunk[];
  vectors: Float32Array[];
}

function normalizeForSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export class RetrievalService {
  private client: EmbeddingClient;
  private ensureReady: (signal?: AbortSignal) => Promise<void>;
  private model: string;
  private dimensions: number;
  private instruction: string;
  private maxCacheEntries: number;
  private cache = new Map<string, RetrievalIndex>();

  constructor(options: RetrievalServiceOptions) {
    this.client = options.client;
    this.ensureReady = options.ensureReady;
    this.model = options.model;
    this.dimensions = options.dimensions ?? EMBEDDING_DIMENSIONS;
    this.instruction = options.instruction ?? RETRIEVAL_QUERY_INSTRUCTION;
    this.maxCacheEntries = options.maxCacheEntries ?? 3;
  }

  private indexKey(paper: Paper): string {
    const signature = paper.signature ?? JSON.stringify([paper.title, paper.text.length, paper.text.slice(0, 64), paper.text.slice(-64)]);
    return JSON.stringify([signature, this.model, this.dimensions, DEFAULT_CHUNK_SIZE, DEFAULT_CHUNK_OVERLAP]);
  }

  private async getIndex(paper: Paper, signal: AbortSignal): Promise<RetrievalIndex> {
    const key = this.indexKey(paper);
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const chunks = splitRecursive(paper.text);
    if (!chunks.length) throw new ReaderError("no-text", "Este PDF não contém texto extraível.");
    const documents = chunks.map(chunk => chunk.heading ? `${chunk.heading}\n${chunk.coreText}` : chunk.coreText);
    const vectors = await this.client.embed(documents, signal);
    if (vectors.length !== chunks.length) throw new ReaderError("embedding", "O índice de embeddings ficou incompleto.");
    for (const vector of vectors) {
      if (vector.length !== this.dimensions) {
        throw new ReaderError("embedding", `O modelo de embeddings retornou ${vector.length} dimensões; esperado ${this.dimensions}.`);
      }
    }
    const index: RetrievalIndex = { key, chunks, vectors };
    this.cache.set(key, index);
    while (this.cache.size > this.maxCacheEntries) this.cache.delete(this.cache.keys().next().value!);
    return index;
  }

  async getContext(paper: Paper, selection: string, question: string, history: readonly Turn[],
    settings: Settings, mode: PromptMode, signal: AbortSignal): Promise<RetrievedContext> {
    await this.ensureReady(signal);
    const index = await this.getIndex(paper, signal);
    const query = this.instruction ? `Instruct: ${this.instruction}\nQuery: ${question.trim()}` : question.trim();
    const queryVector = (await this.client.embed([query], signal))[0];
    const scores = index.vectors.map(vector => cosineSimilarity(queryVector, vector));
    const allRanked = index.chunks.map((_, i) => i).sort((left, right) => scores[right] - scores[left]);

    const wanted = normalizeForSearch(selection);
    const matching = index.chunks.filter(chunk => normalizeForSearch(chunk.coreText).includes(wanted));
    const anchor = matching.length
      ? matching.reduce((best, chunk) => scores[chunk.index] > scores[best.index] ? chunk : best).index
      : allRanked[0];
    const anchorHeading = index.chunks[anchor].heading;
    // Reference lists are not evidence for content questions. Keep the anchor
    // if the user explicitly selected a reference entry.
    const ranked = allRanked.filter(chunkIndex => chunkIndex === anchor ||
      !/^(references?|bibliography)$/i.test(index.chunks[chunkIndex].heading ?? ""));

    const maxTokens = RETRIEVAL_INPUT_TOKENS[settings.provider];
    const selected = new Set<number>();
    const render = (indices: readonly number[]): RetrievalContext => ({
      chunks: indices.map(i => index.chunks[i]).sort((left, right) => left.start - right.start),
      totalChunks: index.chunks.length,
    });
    const estimated = (indices: readonly number[]): number =>
      estimatePromptTokens(buildMessages(paper, selection, question, history, mode, render(indices)));
    const base = estimated([]);
    if (base > maxTokens) {
      throw new ReaderError("context", `A pergunta, o trecho e a conversa usam cerca de ${base.toLocaleString("pt-BR")} tokens, acima do orçamento de ${maxTokens.toLocaleString("pt-BR")}. Inicie uma nova pergunta ou aumente o limite.`);
    }

    const add = (chunkIndex: number, required = false): boolean => {
      if (selected.has(chunkIndex)) return true;
      const candidate = [...selected, chunkIndex];
      if (estimated(candidate) > maxTokens) {
        if (required) {
          throw new ReaderError("context", `O trecho selecionado não cabe no orçamento de ${maxTokens.toLocaleString("pt-BR")} tokens. Inicie uma nova pergunta ou aumente o limite.`);
        }
        return false;
      }
      selected.add(chunkIndex);
      return true;
    };

    add(anchor, true);
    for (const offset of [-1, 1]) {
      const neighbor = anchor + offset;
      if (neighbor >= 0 && neighbor < index.chunks.length && index.chunks[neighbor].heading === anchorHeading) add(neighbor);
    }
    // Keep chunks close to the best match instead of blindly filling to 12.
    // The relative floor is safer than an absolute cosine threshold because
    // scores are not calibrated probabilities and vary by query and language.
    const topScore = scores[ranked[0]];
    const closeEnough = ranked.filter(chunkIndex => scores[chunkIndex] >= topScore * RETRIEVAL_RELATIVE_FLOOR).length;
    const target = Math.min(RETRIEVAL_MAX_CHUNKS, Math.max(RETRIEVAL_MIN_CHUNKS, closeEnough));
    for (const chunkIndex of ranked) {
      if (selected.size >= target) break;
      add(chunkIndex);
    }

    const indices = [...selected];
    const chunks = render(indices).chunks;
    return { chunks, totalChunks: index.chunks.length, estimatedPromptTokens: estimated(indices) };
  }
}
