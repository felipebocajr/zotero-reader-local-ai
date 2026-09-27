import { ReaderError, abortIfNeeded, userMessage } from "./errors.ts";
import { buildMessages } from "./prompt.ts";
import type { Turn, Settings, AnswerSaveState, SaveAnswer } from "./types.ts";
import type { LlamaClient } from "./client.ts";
import type { PaperCache } from "./paper.ts";

export type Phase = "idle" | "extracting" | "preparing" | "generating" | "complete" | "error";
export interface SessionState { phase: Phase; history: readonly Turn[]; question: string; draft: string; error: string; answerSaves: readonly AnswerSaveState[] }
export class RequestGate {
  private owner: symbol | null = null;
  acquire(): () => void {
    if (this.owner) throw new ReaderError("busy", "Já existe um pedido em andamento. Cancele-o ou aguarde a resposta antes de enviar outro.");
    const token = Symbol(); this.owner = token;
    return () => { if (this.owner === token) this.owner = null; };
  }
}

export class ReadingSession {
  state: SessionState = { phase: "idle", history: [], question: "", draft: "", error: "", answerSaves: [] };
  private savedAnswers = new WeakMap<Turn, AnswerSaveState>();
  private saveTurn?: SaveAnswer;
  private active: AbortController | null = null;
  private disposed = false;
  readonly attachmentId: number;
  readonly selection: string;
  private papers: PaperCache;
  private gate: RequestGate;
  private makeClient: () => LlamaClient;
  private settings: () => Settings;
  private changed: (state: SessionState) => void;
  constructor(attachmentId: number, selection: string, papers: PaperCache,
    gate: RequestGate, makeClient: () => LlamaClient, settings: () => Settings,
    changed: (state: SessionState) => void, saveTurn?: SaveAnswer) {
    this.attachmentId = attachmentId; this.selection = selection; this.papers = papers;
    this.gate = gate; this.makeClient = makeClient; this.settings = settings; this.changed = changed;
    this.saveTurn = saveTurn;
  }
  private publish(patch: Partial<SessionState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    this.state.answerSaves = this.state.history.map(turn => this.savedAnswers.get(turn) ?? { phase: "idle" });
    this.changed(this.state);
  }
  cancel(): void { this.active?.abort(); }
  reset(): void { if (!this.active) this.publish({ phase: "idle", history: [], question: "", draft: "", error: "" }); }
  dispose(): void { this.disposed = true; this.cancel(); this.state = { phase: "idle", history: [], question: "", draft: "", error: "", answerSaves: [] }; }
  async saveAnswer(index: number): Promise<void> {
    if (this.disposed || !Number.isInteger(index)) return;
    const turn = this.state.history[index];
    if (!turn || !this.saveTurn || ["saving", "saved"].includes(this.savedAnswers.get(turn)?.phase ?? "")) return;
    this.savedAnswers.set(turn, { phase: "saving" }); this.publish({});
    try {
      const annotationId = await this.saveTurn(turn);
      this.savedAnswers.set(turn, { phase: "saved", annotationId });
    } catch (error) {
      this.savedAnswers.set(turn, { phase: "error", error: error instanceof ReaderError ? error.message
        : "Não foi possível salvar a resposta nas anotações. Tente novamente; consulte o log do Zotero se o problema persistir." });
    }
    // A reset/new question must not associate a late save with another answer.
    if (this.state.history.includes(turn)) this.publish({});
  }
  async ask(question: string, followup = false): Promise<void> {
    if (this.disposed || this.active) return;
    let release: (() => void) | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    let timedOut = false;
    try {
      if (!question.trim()) throw new ReaderError("question", "Escreva uma pergunta antes de enviar.");
      release = this.gate.acquire(); this.active = abort;
      const settings = this.settings();
      timeout = setTimeout(() => { timedOut = true; abort.abort(); }, settings.timeoutMs);
      this.publish({ phase: "extracting", history: followup ? this.state.history : [], question: question.trim(), draft: "", error: "" });
      const paper = await this.papers.get(this.attachmentId, abort.signal);
      abortIfNeeded(abort.signal);
      this.publish({ phase: "preparing" });
      const messages = buildMessages(paper, this.selection, question, this.state.history, settings.responseLanguage);
      const result = await this.makeClient().generate(messages, abort.signal,
        text => this.publish({ draft: this.state.draft + text }), true, () => this.publish({ phase: "generating" }));
      abortIfNeeded(abort.signal);
      this.publish({ phase: "complete", history: [...this.state.history, { question: question.trim(), answer: result.answer }], draft: "", error: "" });
    } catch (error) {
      this.publish({ phase: "error", draft: "", error: timedOut ? "O pedido excedeu o tempo limite. Tente novamente ou aumente o limite nas configurações." : userMessage(error) });
    } finally {
      if (timeout) clearTimeout(timeout);
      this.active = null; release?.();
    }
  }
}
