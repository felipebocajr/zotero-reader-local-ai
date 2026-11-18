import { ReaderError } from "./errors.ts";
import { validateEmbeddingBaseUrl } from "./embeddings.ts";
import type { EmbeddingProbe, OwnedProcess, RuntimePlatform, RuntimePreferences } from "./runtime.ts";

export interface EmbeddingState {
  phase: "stopped" | "starting" | "ready" | "external" | "error";
  message: string;
  owned: boolean;
  model?: string;
  pid?: number;
  details?: string;
}

export class EmbeddingController {
  private state: EmbeddingState = { phase: "stopped", owned: false, message: "Modelo de embeddings parado." };
  private owned?: { process: OwnedProcess };
  private operation?: Promise<void>;
  private disposed = false;
  private stopping = false;
  private revision = 0;
  private platform: RuntimePlatform;
  private preferences: () => RuntimePreferences;
  private baseUrl: string;
  private port: number;
  private model: string;
  private cancelRequests: () => void;

  constructor(platform: RuntimePlatform, preferences: () => RuntimePreferences, baseUrl: string, model: string, cancelRequests: () => void) {
    this.platform = platform;
    this.preferences = preferences;
    this.baseUrl = validateEmbeddingBaseUrl(baseUrl);
    this.port = Number(new URL(this.baseUrl).port || 80);
    this.model = model;
    this.cancelRequests = cancelRequests;
  }

  getState(): EmbeddingState {
    return { ...this.state };
  }

  private async probe(): Promise<EmbeddingProbe | undefined> {
    return this.platform.probeEmbedding ? this.platform.probeEmbedding(this.baseUrl) : undefined;
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.disposed) throw new ReaderError("embedding", "O plugin foi desativado.");
    const existing = await this.probe();
    if (existing?.ready) {
      if (existing.model !== this.model) {
        throw new ReaderError("embedding", `Há um servidor de embeddings com o modelo ${existing.model ?? "desconhecido"}; esperado ${this.model}.`);
      }
      this.state = { phase: this.owned ? "ready" : "external", owned: !!this.owned, model: this.model,
        pid: this.owned?.process.pid, message: `Embeddings prontos: ${this.model}.` };
      return;
    }
    if (this.operation) return this.operation;
    const task = this.launch(signal);
    this.operation = task;
    try {
      await task;
    } catch (error) {
      if (!(error instanceof ReaderError && error.code === "cancelled")) {
        const owner = this.owned;
        if (owner) await owner.process.stop();
        if (this.owned === owner) this.owned = undefined;
        if (!this.disposed) this.state = { phase: "error", owned: false, model: this.model,
          message: error instanceof Error ? error.message : String(error) };
      }
      throw error;
    } finally {
      if (this.operation === task) this.operation = undefined;
    }
  }

  private async launch(signal?: AbortSignal): Promise<void> {
    if (!this.platform.spawnEmbedding || !this.platform.probeEmbedding) {
      throw new ReaderError("embedding", "Este runtime não suporta o servidor de embeddings.");
    }
    const preferences = this.preferences();
    if (!preferences.projectRoot) {
      throw new ReaderError("embedding", "Escolha a pasta do projeto nas configurações para iniciar o modelo de embeddings.");
    }
    const existing = await this.probe();
    if (existing?.ready && existing.model === this.model) {
      this.state = { phase: "external", owned: false, model: this.model, message: `Embeddings prontos: ${this.model}.` };
      return;
    }
    if (existing) {
      throw new ReaderError("embedding", existing.ready
        ? `Há um servidor de embeddings com outro modelo em ${this.baseUrl}; encerre-o ou ajuste a porta.`
        : `Já há um servidor carregando em ${this.baseUrl}; aguarde ou encerre-o.`);
    }
    const revision = ++this.revision;
    this.stopping = false;
    this.state = { phase: "starting", owned: false, model: this.model, message: "Iniciando o modelo de embeddings…" };
    const process = await this.platform.spawnEmbedding({
      projectRoot: await this.platform.validateRoot(preferences.projectRoot),
      baseUrl: this.baseUrl,
      model: this.model,
      port: this.port,
    });
    if (this.disposed || revision !== this.revision) { await process.stop(); return; }
    const owner = this.owned = { process };
    this.state = { phase: "starting", owned: true, model: this.model, pid: process.pid, message: "Carregando o modelo de embeddings…" };
    let exited: number | undefined;
    void process.exited.then(code => {
      exited = code;
      if (this.owned !== owner) return;
      this.owned = undefined;
      if (!this.disposed && !this.stopping) {
        this.state = { phase: "error", owned: false, model: this.model,
          message: `O servidor de embeddings encerrou com código ${code}.`, details: process.tail() };
      }
    });
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      if (this.disposed || revision !== this.revision) { await process.stop(); return; }
      if (signal?.aborted) throw new ReaderError("cancelled", "Pedido cancelado.");
      if (exited !== undefined) {
        throw new ReaderError("embedding", `O servidor de embeddings encerrou com código ${exited}. ${process.tail()}`.trim());
      }
      const probe = await this.probe();
      if (probe?.ready) {
        if (probe.model !== this.model) {
          await process.stop();
          throw new ReaderError("embedding", `O servidor de embeddings respondeu com ${probe.model ?? "modelo desconhecido"}; esperado ${this.model}.`);
        }
        this.state = { phase: "ready", owned: true, model: this.model, pid: process.pid, message: `Embeddings prontos: ${this.model}.` };
        return;
      }
      await this.wait(500);
    }
    await process.stop();
    throw new ReaderError("embedding", "O servidor de embeddings não iniciou em 120 segundos. Confira a pasta do projeto e o modelo.");
  }

  private wait(ms: number): Promise<void> {
    return new Promise(resolve => { this.platform.later(resolve, ms); });
  }

  async start(): Promise<void> {
    try { await this.ensureReady(); }
    catch (error) {
      if (!this.disposed) this.state = { ...this.state, phase: "error", message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }

  async refresh(): Promise<EmbeddingState> {
    if (this.disposed) return this.getState();
    try {
      const probe = await this.probe();
      if (probe?.ready && probe.model === this.model) {
        this.state = { phase: this.owned ? "ready" : "external", owned: !!this.owned, model: this.model,
          pid: this.owned?.process.pid, message: `Embeddings prontos: ${this.model}.` };
      } else if (!probe && !this.owned && this.state.phase === "external") {
        this.state = { phase: "stopped", owned: false, message: "Modelo de embeddings parado." };
      }
    } catch { /* A transient probe failure does not discard a ready process. */ }
    return this.getState();
  }

  async stop(): Promise<void> {
    ++this.revision;
    this.stopping = true;
    this.cancelRequests();
    const owner = this.owned;
    if (owner) await owner.process.stop();
    if (this.owned === owner) this.owned = undefined;
    this.state = { phase: "stopped", owned: false, message: "Modelo de embeddings parado." };
    this.stopping = false;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }
}
