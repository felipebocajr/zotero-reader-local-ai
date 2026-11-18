import { LlamaClient } from "./client.ts";
import type { ChatClient } from "./client.ts";
import { DEFAULTS, EMBEDDING_BASE_URL, EMBEDDING_DIMENSIONS, EMBEDDING_MODEL, GROQ_BASE_URL, GROQ_DEFAULT_MODEL, GROQ_MAX_CONTEXT, MODEL_OPTIONS, PREF_PREFIX, validateSettings } from "./config.ts";
import { EmbeddingClient } from "./embeddings.ts";
import { EmbeddingController } from "./embedding-runtime.ts";
import { GroqClient, parseGroqModels } from "./groq.ts";
import type { GroqModel } from "./groq.ts";
import { RetrievalService } from "./retrieval.ts";
import { PaperCache } from "./paper.ts";
import { EXPLAIN_BRIEF_QUESTION, EXPLAIN_QUESTION } from "./prompt.ts";
import { ReadingSession, RequestGate } from "./session.ts";
import { createPopup } from "./view.ts";
import type { PopupView } from "./view.ts";
import type { FetchLike, Settings } from "./types.ts";
import { zoteroPaperSource } from "./zotero-paper.ts";
import { createAnswerAnnotationWriter } from "./zotero-annotations.ts";
import type { SelectionAnnotation } from "./zotero-annotations.ts";
import { installAnnotationMath } from "./zotero-math.ts";
import { RuntimeController, RUNTIME_DEFAULTS, validateRuntimePreferences } from "./runtime.ts";
import type { RuntimePlatform, RuntimePreferences } from "./runtime.ts";
export { createRuntimePlatform } from "./zotero-runtime.ts";
import stylesheet from "./styles.css";

interface SelectionEvent { reader: { itemID: number }; doc: Document; params: { annotation?: SelectionAnnotation }; append(node: Node): void }
interface Host { zotero: any; io: any; fetch: FetchLike; runtime: RuntimePlatform }
let stopCurrent: (() => Promise<void>) | undefined;

export async function start(data: { id: string; rootURI: string }, host: Host): Promise<void> {
  await stop();
  const zotero = host.zotero;
  const papers = new PaperCache(zoteroPaperSource(zotero, host.io));
  const gate = new RequestGate();
  const popups = new Map<object, { signature: string; view: PopupView; session: ReadingSession }>();
  const documents = new Map<Document, () => void>();
  const preferenceWindows = new Map<object, { lifetime: { closed: boolean; timer?: number }; clean: () => void }>();

  function settings(): Settings {
    const value = (key: keyof Settings) => zotero.Prefs.get(PREF_PREFIX + key, true) ?? DEFAULTS[key];
    const provider = String(value("provider")) === "groq" ? "groq" : "local";
    const savedModel = String(value("model"));
    const localModel = MODEL_OPTIONS.some(option => option.id === savedModel) ? savedModel : DEFAULTS.model;
    if (savedModel !== localModel) zotero.Prefs.set(PREF_PREFIX + "model", localModel, true);
    const savedGroqModel = String(zotero.Prefs.get(PREF_PREFIX + "groqModel", true) ?? "");
    const groqModel = savedGroqModel.trim() || GROQ_DEFAULT_MODEL;
    const localOption = MODEL_OPTIONS.find(option => option.id === localModel)!;
    const requestedContext = Number(value("contextTokens"));
    const contextTokens = provider === "groq"
      ? Math.min(requestedContext, GROQ_MAX_CONTEXT)
      : Math.min(requestedContext, localOption.maxContextTokens);
    return validateSettings({
      provider,
      baseUrl: provider === "groq" ? GROQ_BASE_URL : String(value("baseUrl")),
      model: provider === "groq" ? groqModel : localModel,
      apiKey: String(zotero.Prefs.get(PREF_PREFIX + "apiKey", true) ?? ""),
      retrievalMode: String(value("retrievalMode")) === "full" ? "full" : "embeddings",
      contextTokens,
      generationTokens: Number(value("generationTokens")),
      timeoutMs: Number(value("timeoutMs")),
    });
  }
  function chatClient(): ChatClient {
    const current = settings();
    return current.provider === "groq" ? new GroqClient(host.fetch, current) : new LlamaClient(host.fetch, current);
  }
  function runtimePreferences(): RuntimePreferences {
    return validateRuntimePreferences({
      projectRoot: String(zotero.Prefs.get(PREF_PREFIX + "projectRoot", true) ?? RUNTIME_DEFAULTS.projectRoot),
      autoStart: zotero.Prefs.get(PREF_PREFIX + "autoStart", true) ?? RUNTIME_DEFAULTS.autoStart,
    });
  }
  const runtime = new RuntimeController(host.runtime, settings, runtimePreferences, () => {
    for (const entry of popups.values()) entry.session.cancel();
  });
  const embeddingRuntime = new EmbeddingController(host.runtime, runtimePreferences, EMBEDDING_BASE_URL, EMBEDDING_MODEL, () => {
    for (const entry of popups.values()) entry.session.cancel();
  });
  const retrieval = new RetrievalService({
    client: new EmbeddingClient(host.fetch, { baseUrl: EMBEDDING_BASE_URL, model: EMBEDDING_MODEL, batchSize: 16 }),
    ensureReady: signal => embeddingRuntime.ensureReady(signal),
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  function prepareDocument(doc: Document): void {
    // Reader events and existing-reader lookup can expose different Gecko wrappers.
    if (documents.has(doc) || doc.getElementById("reader-local-ai-style")) return;
    const stopMath = installAnnotationMath(doc);
    const style = doc.createElement("style"); style.id = "reader-local-ai-style"; style.textContent = stylesheet;
    doc.head.append(style);
    const unloaded = () => {
      for (const [reader, entry] of popups) if (entry.view.element.ownerDocument === doc) { entry.view.close(); popups.delete(reader); }
      for (const actions of doc.querySelectorAll('[data-reader-local-ai="actions"]')) actions.remove();
      stopMath(); style.remove(); documents.delete(doc); doc.defaultView?.removeEventListener("unload", unloaded);
    };
    doc.defaultView?.addEventListener("unload", unloaded, { once: true });
    documents.set(doc, unloaded);
  }
  function handleSelection(event: SelectionEvent): void {
    const { reader, doc, params, append } = event;
    const selection = params.annotation?.text;
    if (!selection?.trim() || !Number.isInteger(reader.itemID) || !zotero.Items.get(reader.itemID)?.isPDFAttachment()) return;
    prepareDocument(doc);
    const signature = JSON.stringify([reader.itemID, selection, params.annotation?.position]);
    const old = popups.get(reader);
    if (old && old.signature !== signature) old.view.close();
    const strip = doc.createElement("div"); strip.className = "reader-local-ai-actions";
    strip.setAttribute("data-reader-local-ai", "actions");
    function action(label: string, explain: boolean): HTMLButtonElement {
      const button = doc.createElement("button"); button.type = "button"; button.textContent = label;
      button.setAttribute("data-tabstop", "1");
      button.addEventListener("click", click => {
        click.stopPropagation();
        const anchor = button.getBoundingClientRect();
        popups.get(reader)?.view.close();
        let view: PopupView;
        const session = new ReadingSession(reader.itemID, selection!, papers, gate, chatClient, settings,
          state => view.render(state), createAnswerAnnotationWriter(zotero, reader.itemID, params.annotation!), retrieval);
        view = createPopup(doc, anchor, selection!, {
          ask: (question, followup) => { void session.ask(question, followup); },
          explainDetail: () => { void session.ask(EXPLAIN_QUESTION, true, "detail"); },
          cancel: () => session.cancel(), reset: () => session.reset(),
          saveAnswer: index => { void session.saveAnswer(index); },
          closed: () => { session.dispose(); if (popups.get(reader)?.session === session) popups.delete(reader); },
        });
        popups.set(reader, { signature, view, session }); view.render(session.state);
        if (explain) void session.ask(EXPLAIN_BRIEF_QUESTION, false, "explain"); else view.question(false);
      });
      return button;
    }
    strip.append(action("Explicar trecho", true), action("Fazer pergunta", false));
    append(strip);
  }
  function persistSettings(validated: Settings): void {
    const { provider, baseUrl, model, ...rest } = validated;
    for (const [key, value] of Object.entries(rest)) zotero.Prefs.set(PREF_PREFIX + key, value, true);
    zotero.Prefs.set(PREF_PREFIX + "provider", provider, true);
    if (provider === "groq") zotero.Prefs.set(PREF_PREFIX + "groqModel", model, true);
    else {
      zotero.Prefs.set(PREF_PREFIX + "model", model, true);
      zotero.Prefs.set(PREF_PREFIX + "baseUrl", baseUrl, true);
    }
  }
  let groqModelsState: { phase: "idle" | "loading" | "ready" | "error"; models: GroqModel[]; error: string; revision: number } =
    { phase: "idle", models: [], error: "", revision: 0 };
  let groqModelsRevision = 0;
  function requestGroqModels(apiKey: string): void {
    const key = typeof apiKey === "string" ? apiKey.trim() : "";
    const revision = ++groqModelsRevision;
    if (!key) {
      groqModelsState = { phase: "error", models: [], error: "Informe a chave da API do Groq antes de buscar os modelos.", revision };
      return;
    }
    groqModelsState = { phase: "loading", models: [], error: "", revision };
    void (async () => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), 15000);
      try {
        const response = await host.fetch(GROQ_BASE_URL + "/models", {
          signal: abort.signal, redirect: "error",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) throw new Error("A chave da API do Groq foi recusada.");
          if (response.status === 429) throw new Error("O Groq limitou os pedidos. Aguarde um pouco e tente novamente.");
          throw new Error(`O Groq recusou a lista de modelos (HTTP ${response.status}).`);
        }
        const models = parseGroqModels(await response.json());
        if (revision !== groqModelsRevision) return;
        if (!models.length) throw new Error("Nenhum modelo de texto foi retornado pelo Groq.");
        groqModelsState = { phase: "ready", models, error: "", revision };
      } catch (error) {
        if (revision !== groqModelsRevision) return;
        groqModelsState = { phase: "error", models: [], error: abort.signal.aborted
          ? "O pedido à API do Groq excedeu o tempo limite."
          : String((error as Error)?.message ?? error), revision };
      } finally {
        clearTimeout(timer);
      }
    })();
  }
  zotero.ReaderLocalAI = {
    getSettings: settings,
    getLocalModel: () => {
      const saved = String(zotero.Prefs.get(PREF_PREFIX + "model", true) ?? DEFAULTS.model);
      return MODEL_OPTIONS.some(option => option.id === saved) ? saved : DEFAULTS.model;
    },
    getLocalBaseUrl: () => String(zotero.Prefs.get(PREF_PREFIX + "baseUrl", true) ?? DEFAULTS.baseUrl),
    getGroqDefaults: () => ({ baseUrl: GROQ_BASE_URL, model: GROQ_DEFAULT_MODEL }),
    getGroqModel: () => {
      const saved = String(zotero.Prefs.get(PREF_PREFIX + "groqModel", true) ?? "");
      return saved.trim() || GROQ_DEFAULT_MODEL;
    },
    requestGroqModels,
    getGroqModels: () => ({ ...groqModelsState, models: groqModelsState.models.map(model => ({ ...model })) }),
    getModels: () => MODEL_OPTIONS.map(model => ({ ...model })),
    saveSettings(input: Settings) {
      persistSettings(validateSettings(input));
    },
    getRuntimePreferences: runtimePreferences,
    watchPreferencesWindow(window: any) {
      const existing = preferenceWindows.get(window);
      if (existing) return existing.lifetime;
      const lifetime = { closed: false, timer: undefined as number | undefined };
      const clean = () => {
        lifetime.closed = true;
        try { window.clearTimeout(lifetime.timer); window.removeEventListener("unload", clean); } catch { /* Window destroyed. */ }
        preferenceWindows.delete(window);
      };
      // This callback survives Zotero nuking the pane sandbox before dispatching unload.
      window.addEventListener("unload", clean, { once: true });
      preferenceWindows.set(window, { lifetime, clean });
      return lifetime;
    },
    saveRuntimePreferences(input: RuntimePreferences) {
      const validated = validateRuntimePreferences(input);
      for (const [key, value] of Object.entries(validated)) zotero.Prefs.set(PREF_PREFIX + key, value, true);
    },
    saveConfiguration(input: Settings, preferences: RuntimePreferences) {
      const validated = validateSettings(input), runtimeSettings = validateRuntimePreferences(preferences);
      persistSettings(validated);
      for (const [key, value] of Object.entries(runtimeSettings)) zotero.Prefs.set(PREF_PREFIX + key, value, true);
    },
    chooseRuntimeFolder: (window: unknown) => runtime.pickFolder(window),
    browseRuntimeFolder(window: any): void {
      // Preferences sandboxes are nuked on close. Await only in the plugin realm.
      void (async () => {
        try {
          const folder = await runtime.pickFolder(window);
          if (folder && !window.closed) window.document.getElementById("reader-local-ai-projectRoot").value = folder;
        } catch (error: any) {
          try { if (!window.closed) window.document.getElementById("reader-local-ai-settings-status").textContent = String(error.message ?? error); }
          catch { /* The native window was destroyed while the picker was open. */ }
        }
      })();
    },
    getRuntimeState: () => runtime.getState(),
    refreshRuntime: () => runtime.refresh(),
    requestRuntimeRefresh: () => { void runtime.refresh(); },
    getEmbeddingState: () => embeddingRuntime.getState(),
    startEmbeddings: () => embeddingRuntime.start(),
    stopEmbeddings: () => embeddingRuntime.stop(),
    requestEmbeddingRefresh: () => { void embeddingRuntime.refresh(); },
    runEmbeddingAction(action: string): void {
      if (action === "start") void embeddingRuntime.start().catch(() => {});
      else if (action === "stop") void embeddingRuntime.stop();
      else if (action === "refresh") void embeddingRuntime.refresh();
      else throw new Error("Ação de embeddings inválida.");
    },
    runRuntimeAction(action: string): void {
      const actions = { startRuntime: "start", stopRuntime: "stop", restartRuntime: "restart" } as const;
      if (!(action in actions)) throw new Error("Ação de servidor inválida.");
      runtime.run(actions[action as keyof typeof actions]);
    },
    startRuntime: () => runtime.start(),
    stopRuntime: () => runtime.stop(),
    restartRuntime: () => runtime.restart(),
  };
  const handleAnnotationHeader = (event: { doc: Document }) => prepareDocument(event.doc);
  let paneId: string | undefined;
  let stopped = false;
  stopCurrent = () => {
    stopped = true;
    zotero.Reader.unregisterEventListener("renderTextSelectionPopup", handleSelection);
    zotero.Reader.unregisterEventListener("renderSidebarAnnotationHeader", handleAnnotationHeader);
    for (const entry of [...popups.values()]) entry.view.close(); popups.clear();
    for (const clean of [...documents.values()]) clean(); documents.clear(); papers.clear();
    for (const entry of [...preferenceWindows.values()]) entry.clean();
    delete zotero.ReaderLocalAI;
    if (paneId) zotero.PreferencePanes.unregister(paneId);
    const stoppingRuntime = runtime.dispose();
    const stoppingEmbeddings = embeddingRuntime.dispose();
    return Promise.all([stoppingRuntime, stoppingEmbeddings]).then(() => undefined);
  };
  zotero.Reader.registerEventListener("renderTextSelectionPopup", handleSelection, data.id);
  zotero.Reader.registerEventListener("renderSidebarAnnotationHeader", handleAnnotationHeader, data.id);
  for (const reader of zotero.Reader._readers ?? []) {
    const doc = reader._iframe?.contentDocument;
    if (doc?.body) prepareDocument(doc);
  }
  try {
    paneId = await zotero.PreferencePanes.register({ id: data.id + "-preferences", pluginID: data.id, label: "Assistente local", src: data.rootURI + "preferences.xhtml", scripts: [data.rootURI + "preferences-ui.js"] });
    if (stopped) zotero.PreferencePanes.unregister(paneId);
  } catch (error) { stop(); throw error; }
  zotero.debug("Reader Local AI: plugin iniciado");
  if (!stopped && settings().provider === "local" && runtimePreferences().autoStart) void runtime.start();
}

export async function stop(): Promise<void> { const clean = stopCurrent; stopCurrent = undefined; await clean?.(); }
