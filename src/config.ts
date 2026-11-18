import { ReaderError } from "./errors.ts";
import type { Settings } from "./types.ts";

export const MODEL_OPTIONS = [
  { id: "lfm2.5-8b-a1b", label: "LFM2.5-8B-A1B — padrão", maxContextTokens: 128000,
    description: "Modelo com especialistas: 8,3 bilhões de parâmetros totais e 1,5 bilhão ativos por token. Pesos Q4: cerca de 5,16 GB; o consumo total é maior." },
  { id: "lfm3-1.7b", label: "LFM3-1.7B — contexto de 256K", maxContextTokens: 262144,
    description: "Modelo novo da Liquid AI, com 1,73 bilhão de parâmetros e 256 mil tokens de contexto. Pesos Q4: cerca de 1,10 GB." },
] as const;

// Kept only for the delivered 2.6B benchmark; it is not exposed in the plugin UI.
export const LEGACY_MODEL_OPTIONS = [
  { id: "lfm2.5-2.6b", label: "LFM2.5-2.6B — benchmark legado", maxContextTokens: 131072,
    description: "Pesos Q4: cerca de 1,67 GB. Não é oferecido nas preferências do plugin." },
] as const;

export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const GROQ_DEFAULT_MODEL = "openai/gpt-oss-120b";
export const GROQ_MAX_CONTEXT = 131072;

export const EMBEDDING_BASE_URL = "http://127.0.0.1:18081";
export const EMBEDDING_MODEL = "qwen3-embedding-0.6b";
export const EMBEDDING_DIMENSIONS = 1024;
export const RETRIEVAL_INPUT_TOKENS = { local: 16000, groq: 5500 } as const;
export const RETRIEVAL_MIN_CHUNKS = 4;
export const RETRIEVAL_MAX_CHUNKS = 12;
export const RETRIEVAL_RELATIVE_FLOOR = 0.75;

export const DEFAULTS: Settings = {
  provider: "local",
  baseUrl: "http://127.0.0.1:8080", model: "lfm2.5-8b-a1b", apiKey: "",
  retrievalMode: "embeddings",
  contextTokens: 64000, generationTokens: 4096, timeoutMs: 600000,
};
export const PREF_PREFIX = "extensions.reader-local-ai.";

export function validateSettings(input: Settings): Settings {
  const rawProvider = (input as { provider?: unknown }).provider;
  if (rawProvider !== undefined && rawProvider !== "local" && rawProvider !== "groq") {
    throw new ReaderError("config", "Escolha o servidor local ou o Groq como provedor.");
  }
  const provider = rawProvider === "groq" ? "groq" : "local";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey : "";
  if (input.retrievalMode !== "embeddings" && input.retrievalMode !== "full") {
    throw new ReaderError("config", "Escolha trechos relevantes ou o artigo completo como contexto.");
  }
  if (
      !Number.isInteger(input.generationTokens) || input.generationTokens < 256 || input.generationTokens >= input.contextTokens ||
      !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 3600000) {
    throw new ReaderError("config", "Confira modelo, contexto, reserva de geração e tempo limite nas configurações do plugin.");
  }
  if (provider === "groq") {
    const model = input.model.trim();
    if (!model || /[\x00\r\n]/.test(model)) throw new ReaderError("config", "Informe o modelo do Groq nas configurações do plugin.");
    if (/[\x00\r\n]/.test(apiKey)) {
      throw new ReaderError("config", "A chave da API do Groq contém caracteres inválidos.");
    }
    if (!Number.isInteger(input.contextTokens) || input.contextTokens < 8192 || input.contextTokens > GROQ_MAX_CONTEXT) {
      throw new ReaderError("config", `O contexto do Groq deve ficar entre 8.192 e ${GROQ_MAX_CONTEXT.toLocaleString("pt-BR")} tokens.`);
    }
    return { ...input, provider: "groq", baseUrl: GROQ_BASE_URL, model, apiKey: apiKey.trim() };
  }
  let url: URL;
  try { url = new URL(input.baseUrl); } catch { throw new ReaderError("config", "Endereço do servidor inválido."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ReaderError("config", "Use um servidor local em http://127.0.0.1:PORTA, sem caminho adicional.");
  }
  const model = [...MODEL_OPTIONS, ...LEGACY_MODEL_OPTIONS].find(option => option.id === input.model.trim());
  if (!model) throw new ReaderError("config", "Escolha um dos modelos disponíveis nas configurações do plugin.");
  if (!Number.isInteger(input.contextTokens) || input.contextTokens < 8192 || input.contextTokens > model.maxContextTokens) {
    throw new ReaderError("config", `O contexto de ${model.id} deve ficar entre 8.192 e ${model.maxContextTokens.toLocaleString("pt-BR")} tokens.`);
  }
  return { ...input, provider, baseUrl: url.origin, model: model.id, apiKey };
}
