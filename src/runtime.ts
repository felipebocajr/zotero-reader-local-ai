import { validateSettings } from "./config.ts";
import type { Settings } from "./types.ts";

export interface RuntimePreferences { projectRoot: string; autoStart: boolean }
export const RUNTIME_DEFAULTS: RuntimePreferences = { projectRoot: "", autoStart: false };
export interface LaunchConfig { projectRoot: string; baseUrl: string; model: string; contextTokens: number; port: number }
export interface OwnedProcess { pid: number; exited: Promise<number>; stop(): Promise<void>; tail(): string }
export interface ServerProbe { ready: boolean; model?: string; contextTokens?: number; slots?: number }
export interface SupervisorStatus { supervisorPid: number; phase: string; backend?: string; gpuLayers?: number | string; childPid?: number }
export interface RuntimePlatform {
  pickFolder(window: unknown, initial: string): Promise<string | undefined>;
  validateRoot(root: string): Promise<string>;
  spawn(config: LaunchConfig): Promise<OwnedProcess>;
  probe(baseUrl: string): Promise<ServerProbe | undefined>;
  readStatus(config: LaunchConfig): Promise<SupervisorStatus | undefined>;
  later(callback: () => void, ms: number): () => void;
}
export interface RuntimeState {
  phase: "stopped" | "starting" | "ready" | "external" | "stopping" | "error";
  message: string; owned: boolean; pid?: number; model?: string; contextTokens?: number;
  backend?: string; gpuLayers?: number | string; restartRequired?: boolean; details?: string;
}

export function validateRuntimePreferences(input: RuntimePreferences): RuntimePreferences {
  if (typeof input.projectRoot !== "string" || /[\x00\r\n]/.test(input.projectRoot) || typeof input.autoStart !== "boolean") {
    throw new Error("Confira a pasta do projeto e a opção de início automático.");
  }
  const projectRoot = input.projectRoot.trim();
  if (input.autoStart && !projectRoot) throw new Error("Escolha a pasta do projeto antes de habilitar o início automático.");
  return { projectRoot, autoStart: input.autoStart };
}

function configFor(settings: Settings, preferences: RuntimePreferences): LaunchConfig {
  const validated = validateSettings(settings);
  return { projectRoot: preferences.projectRoot, baseUrl: validated.baseUrl, model: validated.model,
    contextTokens: validated.contextTokens, port: Number(new URL(validated.baseUrl).port || 80) };
}
function sameConfig(a: LaunchConfig, b: LaunchConfig): boolean {
  return a.projectRoot === b.projectRoot && a.baseUrl === b.baseUrl && a.model === b.model && a.contextTokens === b.contextTokens;
}

/** Process handles, never status-file PIDs, establish ownership. */
export class RuntimeController {
  private state: RuntimeState = { phase: "stopped", owned: false, message: "Servidor parado. Clique em Iniciar servidor." };
  private owned?: { process: OwnedProcess; config: LaunchConfig };
  private operation?: Promise<void>;
  private cancelTick?: () => void;
  private disposed = false;
  private stopping = false;
  private revision = 0;
  private platform: RuntimePlatform;
  private settings: () => Settings;
  private preferences: () => RuntimePreferences;
  private cancelRequests: () => void;
  constructor(platform: RuntimePlatform, settings: () => Settings, preferences: () => RuntimePreferences, cancelRequests: () => void) {
    this.platform = platform; this.settings = settings; this.preferences = preferences; this.cancelRequests = cancelRequests;
  }

  getState(): RuntimeState {
    const restartRequired = !!this.owned && !sameConfig(this.owned.config, configFor(this.settings(), this.preferences()));
    return { ...this.state, restartRequired };
  }
  async pickFolder(window: unknown): Promise<string | undefined> {
    return this.platform.pickFolder(window, this.preferences().projectRoot);
  }
  run(action: "start" | "stop" | "restart"): void {
    void this[action]().catch(error => {
      if (!this.disposed) this.state = { ...this.state, phase: "error", message: String(error.message ?? error) };
    });
  }
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("O plugin foi desativado."));
    if (this.operation) return this.operation;
    if (this.owned) return Promise.resolve();
    this.stopping = false;
    const revision = ++this.revision;
    this.state = { phase: "starting", owned: false, message: "Verificando o servidor local…" };
    const task = this.launch(revision).catch(error => {
      if (revision === this.revision && !this.disposed) this.state = { phase: "error", owned: false, message: String(error.message ?? error) };
    });
    this.operation = task;
    void task.finally(() => { if (this.operation === task) this.operation = undefined; });
    return task;
  }
  private async launch(revision: number): Promise<void> {
    const config = configFor(this.settings(), this.preferences());
    const existing = await this.platform.probe(config.baseUrl);
    if (revision !== this.revision || this.disposed) return;
    if (existing) { this.external(existing, config); return; }
    if (!config.projectRoot) throw new Error("Escolha a pasta deste projeto, que contém scripts/serve.py e .runtime, nas configurações.");
    config.projectRoot = await this.platform.validateRoot(config.projectRoot);
    if (revision !== this.revision || this.disposed) return;
    this.state = { phase: "starting", owned: false, message: "Iniciando o modelo: GPU inteira → GPU/CPU → CPU…", model: config.model, contextTokens: config.contextTokens };
    const process = await this.platform.spawn(config);
    if (revision !== this.revision || this.disposed) { await process.stop(); return; }
    const owner = this.owned = { process, config };
    this.state = { ...this.state, owned: true, pid: process.pid };
    void process.exited.then(code => {
      if (this.owned !== owner) return;
      this.owned = undefined; this.cancelTick?.(); this.cancelTick = undefined;
      if (this.stopping || this.disposed) this.state = { phase: "stopped", owned: false, message: "Servidor parado." };
      else this.state = { phase: "error", owned: false, message: code ? "O servidor não conseguiu iniciar ou encerrou com erro. Confira os detalhes abaixo." : "O servidor encerrou. Clique em Iniciar servidor para tentar novamente.", details: process.tail() };
    });
    this.tick();
  }
  private tick(): void {
    this.cancelTick?.();
    if (this.disposed || this.stopping || !this.owned) return;
    this.cancelTick = this.platform.later(() => {
      this.cancelTick = undefined;
      void this.refresh().finally(() => this.tick());
    }, 1000);
  }
  private external(probe: ServerProbe, config: LaunchConfig): void {
    const matches = probe.model === config.model && probe.contextTokens === config.contextTokens && probe.slots === 1;
    this.state = { phase: "external", owned: false, model: probe.model, contextTokens: probe.contextTokens,
      message: !probe.ready ? "Já há um servidor neste endereço, carregando ou incompatível. Ele foi iniciado fora do Zotero." : matches
        ? "Servidor conectado, iniciado fora do Zotero. Encerre-o no aplicativo que o iniciou."
        : "Há um servidor iniciado fora do Zotero com modelo/contexto diferentes. Ajuste as configurações ou encerre-o no aplicativo que o iniciou." };
  }
  async refresh(): Promise<RuntimeState> {
    if (this.disposed || this.stopping || this.operation) return this.getState();
    const owner = this.owned;
    try {
      if (owner) {
        const status = await this.platform.readStatus(owner.config);
        if (this.owned !== owner || this.stopping || !status || status.supervisorPid !== owner.process.pid) return this.getState();
        const placement = status.backend === "cpu" ? "CPU" : status.gpuLayers === "all" ? "GPU inteira" : "GPU/CPU";
        const fields = { owned: true, pid: owner.process.pid, model: owner.config.model, contextTokens: owner.config.contextTokens,
          backend: status.backend, gpuLayers: status.gpuLayers };
        if (status.phase === "ready") {
          const probe = await this.platform.probe(owner.config.baseUrl);
          if (this.owned !== owner || this.stopping) return this.getState();
          if (probe?.ready && probe.model === owner.config.model && probe.contextTokens === owner.config.contextTokens && probe.slots === 1) {
            this.state = { ...fields, phase: "ready", message: `Pronto: ${owner.config.model} · ${placement} · contexto ${owner.config.contextTokens.toLocaleString("pt-BR")} tokens.` };
          } else this.state = { ...fields, phase: "starting", message: "Aguardando o modelo local ficar disponível…" };
        } else if (status.phase === "loading") this.state = { ...fields, phase: "starting", message: `Carregando ${owner.config.model} em ${placement}…` };
      } else if (this.state.phase !== "error") {
        const config = configFor(this.settings(), this.preferences());
        const revision = this.revision;
        const probe = await this.platform.probe(config.baseUrl);
        if (this.disposed || this.owned || this.operation || revision !== this.revision) return this.getState();
        if (probe) this.external(probe, config);
        else this.state = { phase: "stopped", owned: false, message: "Servidor parado. Clique em Iniciar servidor." };
      }
    } catch { /* A status file can be replaced or a server briefly unavailable during fallback. */ }
    return this.getState();
  }
  async stop(): Promise<void> {
    ++this.revision; this.stopping = true;
    this.cancelTick?.(); this.cancelTick = undefined;
    this.cancelRequests();
    if (this.operation || this.owned) this.state = { ...this.state, phase: "stopping", message: "Encerrando o servidor e liberando a memória…" };
    await this.operation;
    const owner = this.owned;
    if (owner) await owner.process.stop();
    if (this.owned === owner) this.owned = undefined;
    if (owner || this.state.phase === "stopping") this.state = { phase: "stopped", owned: false, message: "Servidor parado." };
    this.stopping = false;
  }
  async restart(): Promise<void> {
    if (!this.owned && this.state.phase === "external") throw new Error("Este servidor foi iniciado fora do Zotero. Encerre-o no aplicativo que o iniciou.");
    await this.stop(); await this.start();
  }
  dispose(): Promise<void> { this.disposed = true; return this.stop(); }
}
