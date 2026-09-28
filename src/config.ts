import { ReaderError } from "./errors.ts";
import type { Settings } from "./types.ts";

export const MODEL_OPTIONS = [
  { id: "lfm2.5-2.6b", label: "LFM2.5-2.6B — mais leve", maxContextTokens: 131072,
    description: "Pesos Q4: cerca de 1,67 GB. Opção inicial para menor consumo de memória." },
  { id: "lfm2.5-8b-a1b", label: "LFM2.5-8B-A1B — maior capacidade", maxContextTokens: 128000,
    description: "Modelo com especialistas: 8,3 bilhões de parâmetros totais e 1,5 bilhão ativos por token. Pesos Q4: cerca de 5,16 GB; o consumo total é maior." },
] as const;

export const RESPONSE_LANGUAGE_OPTIONS = [
  { id: "pt-BR", label: "Português (Brasil)" },
  { id: "en", label: "Inglês" },
] as const;

export const DEFAULTS: Settings = {
  baseUrl: "http://127.0.0.1:8080", model: "lfm2.5-2.6b",
  responseLanguage: "pt-BR",
  contextTokens: 64000, generationTokens: 4096, timeoutMs: 600000,
};
export const PREF_PREFIX = "extensions.reader-local-ai.";

export function validateSettings(input: Settings): Settings {
  let url: URL;
  try { url = new URL(input.baseUrl); } catch { throw new ReaderError("config", "Endereço do servidor inválido."); }
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new ReaderError("config", "Use um servidor local em http://127.0.0.1:PORTA, sem caminho adicional.");
  }
  const model = MODEL_OPTIONS.find(option => option.id === input.model.trim());
  if (!model) throw new ReaderError("config", "Escolha um dos modelos disponíveis nas configurações do plugin.");
  if (!RESPONSE_LANGUAGE_OPTIONS.some(option => option.id === input.responseLanguage)) {
    throw new ReaderError("config", "Escolha Português (Brasil) ou Inglês para o idioma das respostas.");
  }
  if (!Number.isInteger(input.contextTokens) || input.contextTokens < 8192 || input.contextTokens > model.maxContextTokens) {
    throw new ReaderError("config", `O contexto de ${model.id} deve ficar entre 8.192 e ${model.maxContextTokens.toLocaleString("pt-BR")} tokens.`);
  }
  if (
      !Number.isInteger(input.generationTokens) || input.generationTokens < 256 || input.generationTokens >= input.contextTokens ||
      !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 3600000) {
    throw new ReaderError("config", "Confira modelo, contexto, reserva de geração e tempo limite nas configurações do plugin.");
  }
  return { ...input, baseUrl: url.origin, model: model.id };
}
