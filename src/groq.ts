import type { ChatClient } from "./client.ts";
import { validateSettings } from "./config.ts";
import { ReaderError, abortIfNeeded } from "./errors.ts";
import { FinalTextFilter, readSSE } from "./sse.ts";
import type { FetchLike, Generation, Message, Settings } from "./types.ts";

/** The Groq API is OpenAI-compatible but does not expose llama.cpp's template tokenizer. */
export function estimateGroqPromptTokens(messages: readonly Message[]): number {
  let characters = 0;
  for (const message of messages) characters += message.role.length + message.content.length + 8;
  // 3.5 characters per token is conservative for English and Portuguese papers.
  return Math.ceil(characters / 3.5) + 64;
}

export interface GroqModel {
  id: string;
  ownedBy?: string;
  contextWindow?: number;
  maxCompletionTokens?: number;
  reasoning: boolean;
}

const KNOWN_GROQ_MODELS: Record<string, Omit<GroqModel, "id">> = {
  "openai/gpt-oss-120b": { ownedBy: "OpenAI", contextWindow: 131072, maxCompletionTokens: 65536, reasoning: true },
  "openai/gpt-oss-20b": { ownedBy: "OpenAI", contextWindow: 131072, maxCompletionTokens: 65536, reasoning: true },
  "qwen/qwen3.8-27b": { ownedBy: "Alibaba Cloud", contextWindow: 131072, maxCompletionTokens: 16384, reasoning: true },
  "qwen/qwen3.6-27b": { ownedBy: "Alibaba Cloud", contextWindow: 131072, maxCompletionTokens: 16384, reasoning: true },
  "moonshotai/kimi-k2-instruct-0905": { ownedBy: "Moonshot AI", contextWindow: 262144, reasoning: false },
  "llama-3.3-70b-versatile": { ownedBy: "Meta", contextWindow: 131072, maxCompletionTokens: 32768, reasoning: false },
  "llama-3.1-8b-instant": { ownedBy: "Meta", contextWindow: 131072, maxCompletionTokens: 131072, reasoning: false },
};
const GROQ_MODEL_ORDER = Object.keys(KNOWN_GROQ_MODELS);

function positiveNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

/** Keep chat-capable language models and drop audio, embedding and safety classifiers. */
function isGroqChatModel(id: string): boolean {
  return !/(?:whisper|prompt[-_]?guard|safeguard|(?:^|[\/_-])tts(?:$|[\/_-])|embed|compound)/i.test(id);
}

export function parseGroqModels(payload: unknown): GroqModel[] {
  const data = (payload as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  const models = new Map<string, GroqModel>();
  for (const item of data) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || !record.id.trim() || record.active === false) continue;
    const id = record.id.trim();
    if (!isGroqChatModel(id)) continue;
    const known = KNOWN_GROQ_MODELS[id];
    models.set(id, {
      id,
      ownedBy: typeof record.owned_by === "string" ? record.owned_by : known?.ownedBy,
      contextWindow: positiveNumber(record.context_window) ?? known?.contextWindow,
      maxCompletionTokens: positiveNumber(record.max_completion_tokens) ?? known?.maxCompletionTokens,
      reasoning: known?.reasoning ?? /gpt-oss|qwen3|reason/i.test(id),
    });
  }
  const rank = new Map(GROQ_MODEL_ORDER.map((id, index) => [id, index]));
  return [...models.values()].sort((a, b) =>
    (rank.get(a.id) ?? 100) - (rank.get(b.id) ?? 100) ||
    (b.contextWindow ?? 0) - (a.contextWindow ?? 0) ||
    a.id.localeCompare(b.id));
}

function providerError(status: number, body: string): ReaderError {
  const detail = body.replace(/\s+/g, " ").trim().slice(0, 300);
  if (status === 401 || status === 403) {
    return new ReaderError("auth", "A chave da API do Groq foi recusada. Confira a chave nas configurações do plugin.");
  }
  if (status === 429) {
    return new ReaderError("rate-limit", "O Groq limitou os pedidos. Aguarde um pouco e tente novamente.");
  }
  if (status === 404) {
    return new ReaderError("model", `O modelo não foi encontrado no Groq. Confira o nome nas configurações.${detail ? ` ${detail}` : ""}`);
  }
  if (status >= 500) {
    return new ReaderError("server", "O serviço do Groq está indisponível no momento. Tente novamente.");
  }
  return new ReaderError("server", `O Groq recusou o pedido (HTTP ${status}).${detail ? ` ${detail}` : ""}`);
}

export class GroqClient implements ChatClient {
  readonly settings: Settings;
  private fetcher: FetchLike;
  constructor(fetcher: FetchLike, settings: Settings) {
    this.fetcher = fetcher;
    this.settings = validateSettings({ ...settings, provider: "groq" });
  }

  async generate(messages: Message[], signal: AbortSignal, onText: (text: string) => void, _cachePrompt = false,
    onPrepared?: () => void): Promise<Generation> {
    if (!this.settings.apiKey) {
      throw new ReaderError("auth", "Informe a chave da API do Groq nas configurações do plugin.");
    }
    const promptTokens = estimateGroqPromptTokens(messages);
    if (promptTokens + this.settings.generationTokens > this.settings.contextTokens) {
      throw new ReaderError("context", `O artigo e a conversa usam cerca de ${promptTokens.toLocaleString("pt-BR")} tokens. Com a reserva de geração, excedem o contexto de ${this.settings.contextTokens.toLocaleString("pt-BR")}. Aumente o contexto ou inicie uma nova pergunta; o artigo não será cortado.`);
    }
    onPrepared?.();
    let response: Response;
    try {
      response = await this.fetcher(this.settings.baseUrl + "/chat/completions", {
        method: "POST", signal, redirect: "error",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.settings.apiKey}` },
        body: JSON.stringify({
          model: this.settings.model,
          messages,
          max_completion_tokens: this.settings.generationTokens,
          temperature: 0.2,
          top_p: 0.95,
          stream: true,
          stream_options: { include_usage: true },
          // GPT-OSS and Qwen reasoning models otherwise spend most of the answer budget thinking.
          ...(/^(?:openai\/gpt-oss-|qwen\/qwen3)/.test(this.settings.model) ? { reasoning_effort: "low" } : {}),
        }),
      });
    } catch (error) {
      abortIfNeeded(signal);
      if (error instanceof ReaderError) throw error;
      throw new ReaderError("connection", "Não foi possível conectar ao Groq. Confira a internet e tente novamente.");
    }
    if (!response.ok) throw providerError(response.status, await response.text().catch(() => ""));
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new ReaderError("stream", "O Groq não iniciou o streaming esperado. Tente novamente.");
    }
    const filter = new FinalTextFilter();
    let answer = "", finishReason: string | null = null, done = false;
    let completionTokens: number | undefined;
    try {
      for await (const data of readSSE(response.body, signal)) {
        abortIfNeeded(signal);
        if (data === "[DONE]") { done = true; break; }
        let event: any;
        try { event = JSON.parse(data); } catch { throw new ReaderError("stream", "O stream do Groq contém um evento inválido. Tente novamente."); }
        if (event.error) throw new ReaderError("server", "O Groq encontrou um erro durante a geração. Tente novamente.");
        if (event.usage?.completion_tokens !== undefined) completionTokens = event.usage.completion_tokens;
        for (const choice of event.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          // Reasoning fields and tags are never stored, forwarded or displayed.
          if (typeof choice.delta?.content === "string") {
            const text = filter.push(choice.delta.content);
            answer += text;
            if (text) onText(text);
          }
        }
      }
    } catch (error) {
      abortIfNeeded(signal);
      if (error instanceof ReaderError) {
        if (error.code === "reasoning") throw new ReaderError("reasoning", "O Groq misturou raciocínio e resposta. Tente novamente.");
        throw error;
      }
      throw new ReaderError("interrupted", "A conexão com o Groq foi interrompida antes de completar a resposta. Tente novamente.");
    }
    const tail = filter.finish(); answer += tail; if (tail) onText(tail);
    if (!done || !finishReason) throw new ReaderError("interrupted", "O Groq encerrou a conexão antes de confirmar a resposta completa. Tente novamente.");
    if (finishReason === "length") throw new ReaderError("incomplete", "A resposta atingiu o limite de tokens do Groq. Aumente a reserva de geração e tente novamente.");
    if (finishReason === "content_filter") throw new ReaderError("filtered", "O Groq bloqueou a resposta por política de conteúdo.");
    if (finishReason !== "stop") throw new ReaderError("incomplete", `O Groq encerrou a resposta com o motivo "${finishReason}". Tente novamente.`);
    if (!answer.trim()) throw new ReaderError("empty-answer", "O Groq terminou sem uma resposta final. Tente novamente.");
    return { answer: answer.trim(), promptTokens, completionTokens };
  }
}
