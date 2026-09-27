import { DEFAULTS, validateSettings } from "./config.ts";
import { ReaderError, abortIfNeeded } from "./errors.ts";
import { FinalTextFilter, readSSE } from "./sse.ts";
import type { FetchLike, Generation, Message, Settings } from "./types.ts";

export class LlamaClient {
  readonly settings: Settings;
  private fetcher: FetchLike;
  constructor(fetcher: FetchLike, settings: Settings = DEFAULTS) { this.fetcher = fetcher; this.settings = validateSettings(settings); }

  private async request(path: string, signal: AbortSignal, data?: unknown): Promise<Response> {
    abortIfNeeded(signal);
    try {
      const response = await this.fetcher(this.settings.baseUrl + path, {
        method: data === undefined ? "GET" : "POST", signal, redirect: "error",
        headers: { "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      if (!response.ok) {
        if (response.status === 503) throw new ReaderError("not-ready", "O modelo está carregando ou o servidor está ocupado. Aguarde e tente novamente.");
        throw new ReaderError("server", `O servidor local recusou o pedido (HTTP ${response.status}). Confira o runtime e suas configurações.`);
      }
      return response;
    } catch (error) {
      abortIfNeeded(signal);
      if (error instanceof ReaderError) throw error;
      throw new ReaderError("connection", "Não foi possível conectar ao modelo local. Inicie o llama-server e confira o endereço nas configurações.");
    }
  }

  async prepare(messages: Message[], signal: AbortSignal): Promise<number> {
    await this.request("/health", signal);
    const props = await (await this.request("/props", signal)).json();
    const runtimeContext = props.default_generation_settings?.n_ctx;
    if (!Number.isInteger(runtimeContext) || runtimeContext < 1 || props.total_slots !== 1) {
      throw new ReaderError("runtime", "Use o runtime documentado com um único slot (--parallel 1) e contexto explícito.");
    }
    const models = await (await this.request("/v1/models", signal)).json();
    if (!models.data?.some((model: { id?: string }) => model.id === this.settings.model)) {
      throw new ReaderError("model", `O modelo ${this.settings.model} não está carregado no servidor local. Reinicie-o com --model ${this.settings.model} ou escolha o modelo em uso nas configurações do plugin.`);
    }
    const template = await (await this.request("/apply-template", signal, { messages, add_generation_prompt: true })).json();
    if (typeof template.prompt !== "string") throw new ReaderError("runtime", "O servidor não retornou o template de conversa esperado.");
    // LFM's chat endpoint prepends BOS even when the rendered template has none.
    const tokenized = await (await this.request("/tokenize", signal, { content: template.prompt, add_special: true, parse_special: true })).json();
    if (!Array.isArray(tokenized.tokens)) throw new ReaderError("runtime", "Não foi possível contar os tokens do contexto completo.");
    const used = tokenized.tokens.length;
    const available = Math.min(runtimeContext, this.settings.contextTokens);
    if (used + this.settings.generationTokens > available) throw new ReaderError("context", `Artigo, pergunta e conversa usam ${used.toLocaleString("pt-BR")} tokens. Com a reserva de geração, excedem o contexto de ${available.toLocaleString("pt-BR")}. Aumente o contexto do servidor/configuração ou inicie uma nova pergunta; o artigo não será cortado.`);
    return used;
  }

  async generate(messages: Message[], signal: AbortSignal, onText: (text: string) => void, cachePrompt = true,
    onPrepared?: () => void): Promise<Generation> {
    const promptTokens = await this.prepare(messages, signal);
    onPrepared?.();
    const response = await this.request("/v1/chat/completions", signal, {
      model: this.settings.model, messages, max_tokens: this.settings.generationTokens,
      temperature: 0.1, top_k: 50, repeat_penalty: 1.1, seed: 42,
      stream: true, stream_options: { include_usage: true }, reasoning_format: "deepseek",
      cache_prompt: cachePrompt, timings_per_token: true,
    });
    if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) throw new ReaderError("stream", "O servidor não iniciou o streaming esperado.");
    const filter = new FinalTextFilter();
    let answer = "", finishReason: string | null = null, done = false;
    let completionTokens: number | undefined;
    let timings: Record<string, number> | undefined;
    try {
      for await (const data of readSSE(response.body, signal)) {
        abortIfNeeded(signal);
        if (data === "[DONE]") { done = true; break; }
        let event;
        try { event = JSON.parse(data); } catch { throw new ReaderError("stream", "O streaming contém um evento inválido. Tente novamente."); }
        if (event.error) throw new ReaderError("server", "O servidor encontrou um erro durante a geração. Tente novamente.");
        if (event.usage?.completion_tokens !== undefined) completionTokens = event.usage.completion_tokens;
        if (event.timings) timings = event.timings;
        for (const choice of event.choices ?? []) {
          if (choice.finish_reason) finishReason = choice.finish_reason;
          // reasoning_content is intentionally never stored, forwarded, or displayed.
          if (typeof choice.delta?.content === "string") {
            const text = filter.push(choice.delta.content);
            answer += text;
            if (text) onText(text);
          }
        }
      }
    } catch (error) {
      abortIfNeeded(signal);
      if (error instanceof ReaderError) throw error;
      throw new ReaderError("interrupted", "A conexão foi interrompida antes de completar a resposta. Tente novamente.");
    }
    const tail = filter.finish(); answer += tail; if (tail) onText(tail);
    if (!done || !finishReason) throw new ReaderError("interrupted", "A conexão terminou antes de confirmar a resposta completa. Tente novamente.");
    if (finishReason !== "stop") throw new ReaderError("incomplete", "A geração atingiu o limite antes de concluir a resposta final. Aumente a reserva de geração e tente novamente.");
    if (!answer.trim()) throw new ReaderError("empty-answer", "O modelo terminou sem uma resposta final. Tente novamente ou aumente a reserva de geração.");
    return { answer: answer.trim(), promptTokens, completionTokens, timings };
  }
}
