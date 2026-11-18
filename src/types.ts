export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface Turn { question: string; answer: string }
export interface AnswerSaveState { phase: "idle" | "saving" | "saved" | "error"; error?: string; annotationId?: number }
export type SaveConversation = (turns: readonly Turn[]) => Promise<number>;
export interface Paper { text: string; extractedPages: number; totalPages: number; title: string; signature?: string }
export type Provider = "local" | "groq";
export type RetrievalMode = "embeddings" | "full";
export interface Settings {
  provider: Provider;
  baseUrl: string;
  model: string;
  apiKey: string;
  retrievalMode: RetrievalMode;
  contextTokens: number;
  generationTokens: number;
  timeoutMs: number;
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface Generation {
  answer: string;
  promptTokens: number;
  completionTokens?: number;
  timings?: Record<string, number>;
}
