export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface Turn { question: string; answer: string }
export interface AnswerSaveState { phase: "idle" | "saving" | "saved" | "error"; error?: string; annotationId?: number }
export type SaveAnswer = (turn: Turn) => Promise<number>;
export interface Paper { text: string; extractedPages: number; totalPages: number; title: string }
export type ResponseLanguage = "pt-BR" | "en";
export interface Settings {
  baseUrl: string;
  model: string;
  responseLanguage: ResponseLanguage;
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
