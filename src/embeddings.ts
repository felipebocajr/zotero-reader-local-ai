import { ReaderError } from "./errors.ts";
import type { FetchLike } from "./types.ts";

export const EMBEDDING_DEFAULT_MODEL = "qwen3-embedding-0.6b";
export const EMBEDDING_DEFAULT_BATCH_SIZE = 16;
export const EMBEDDING_DEFAULT_TIMEOUT_MS = 120000;

export interface EmbeddingClientOptions {
  baseUrl: string;
  model?: string;
  batchSize?: number;
  timeoutMs?: number;
}

export interface EmbeddingUsage {
  promptTokens?: number;
  totalTokens?: number;
}

interface EmbeddingPayloadItem { index?: number; embedding?: unknown }

/** Keep the embedding server on loopback, like the local chat server. */
export function validateEmbeddingBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ReaderError("embedding", "Endereço do servidor de embeddings inválido."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ReaderError("embedding", "Use o servidor de embeddings em http://127.0.0.1:PORTA, sem caminho adicional.");
  }
  return url.origin;
}

export function normalizeVector(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  if (!sum) return vector;
  const scale = 1 / Math.sqrt(sum);
  const normalized = new Float32Array(vector.length);
  for (let index = 0; index < vector.length; index++) normalized[index] = vector[index] * scale;
  return normalized;
}

export function cosineSimilarity(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new ReaderError("embedding", "Os vetores têm dimensões diferentes.");
  let dot = 0, leftNorm = 0, rightNorm = 0;
  for (let index = 0; index < left.length; index++) {
    dot += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  const denominator = Math.sqrt(leftNorm * rightNorm);
  return denominator ? dot / denominator : 0;
}

export class EmbeddingClient {
  readonly baseUrl: string;
  readonly model: string;
  private fetcher: FetchLike;
  private batchSize: number;
  private timeoutMs: number;

  constructor(fetcher: FetchLike, options: EmbeddingClientOptions) {
    this.fetcher = fetcher;
    this.baseUrl = validateEmbeddingBaseUrl(options.baseUrl);
    this.model = options.model?.trim() || EMBEDDING_DEFAULT_MODEL;
    this.batchSize = options.batchSize ?? EMBEDDING_DEFAULT_BATCH_SIZE;
    this.timeoutMs = options.timeoutMs ?? EMBEDDING_DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 128) {
      throw new ReaderError("embedding", "O lote de embeddings deve ficar entre 1 e 128 textos.");
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000) {
      throw new ReaderError("embedding", "O tempo limite dos embeddings é inválido.");
    }
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (!texts.length) return [];
    const vectors: Float32Array[] = [];
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      vectors.push(...await this.embedBatch(batch, signal));
    }
    return vectors;
  }

  private async embedBatch(batch: readonly string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const forwardAbort = () => controller.abort();
    signal?.addEventListener("abort", forwardAbort, { once: true });
    try {
      const response = await this.fetcher(this.baseUrl + "/v1/embeddings", {
        method: "POST",
        signal: controller.signal,
        redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
      if (!response.ok) {
        throw new ReaderError("embedding", `O servidor de embeddings recusou o pedido (HTTP ${response.status}).`);
      }
      const payload = await response.json() as { data?: unknown; usage?: { prompt_tokens?: number; total_tokens?: number } };
      if (!Array.isArray(payload.data) || payload.data.length !== batch.length) {
        throw new ReaderError("embedding", "O servidor de embeddings retornou uma quantidade inesperada de vetores.");
      }
      const items = (payload.data as EmbeddingPayloadItem[]).slice().sort((left, right) =>
        (left.index ?? 0) - (right.index ?? 0));
      return items.map((item, position) => {
        if (!Array.isArray(item.embedding) || !item.embedding.length) {
          throw new ReaderError("embedding", `O servidor de embeddings não retornou o vetor ${position + 1}.`);
        }
        return normalizeVector(Float32Array.from(item.embedding as number[]));
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (controller.signal.aborted) throw new ReaderError("embedding", "O servidor de embeddings excedeu o tempo limite.");
      if (error instanceof ReaderError) throw error;
      throw new ReaderError("embedding", "Não foi possível conectar ao servidor de embeddings. Confira se ele está em execução.");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }
}
