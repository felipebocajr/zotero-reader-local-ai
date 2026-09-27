import { LlamaClient } from "./client.ts";
import { DEFAULTS, MODEL_OPTIONS, RESPONSE_LANGUAGE_OPTIONS, PREF_PREFIX, validateSettings } from "./config.ts";
import { PaperCache } from "./paper.ts";
import { EXPLAIN_QUESTION } from "./prompt.ts";
import { ReadingSession, RequestGate } from "./session.ts";
import { createPopup } from "./view.ts";
import type { PopupView } from "./view.ts";
import type { FetchLike, ResponseLanguage, Settings } from "./types.ts";
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
    return validateSettings({ baseUrl: String(value("baseUrl")), model: String(value("model")), responseLanguage: String(value("responseLanguage")) as ResponseLanguage, contextTokens: Number(value("contextTokens")), generationTokens: Number(value("generationTokens")), timeoutMs: Number(value("timeoutMs")) });
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
        const session = new ReadingSession(reader.itemID, selection!, papers, gate, () => new LlamaClient(host.fetch, settings()), settings,
          state => view.render(state), createAnswerAnnotationWriter(zotero, reader.itemID, params.annotation!));
        view = createPopup(doc, anchor, selection!, {
          ask: (question, followup) => { void session.ask(question, followup); },
          cancel: () => session.cancel(), reset: () => session.reset(),
          saveAnswer: index => { void session.saveAnswer(index); },
          closed: () => { session.dispose(); if (popups.get(reader)?.session === session) popups.delete(reader); },
        });
        popups.set(reader, { signature, view, session }); view.render(session.state);
        if (explain) void session.ask(EXPLAIN_QUESTION); else view.question(false);
      });
      return button;
    }
    strip.append(action("Explicar trecho", true), action("Fazer pergunta", false));
    append(strip);
  }
  zotero.ReaderLocalAI = {
    getSettings: settings,
    getModels: () => MODEL_OPTIONS.map(model => ({ ...model })),
    getResponseLanguages: () => RESPONSE_LANGUAGE_OPTIONS.map(language => ({ ...language })),
    saveSettings(input: Settings) {
      const validated = validateSettings(input);
      for (const [key, value] of Object.entries(validated)) zotero.Prefs.set(PREF_PREFIX + key, value, true);
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
      for (const [key, value] of Object.entries({ ...validated, ...runtimeSettings })) zotero.Prefs.set(PREF_PREFIX + key, value, true);
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
    return runtime.dispose();
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
  if (!stopped && runtimePreferences().autoStart) void runtime.start();
}

export async function stop(): Promise<void> { const clean = stopCurrent; stopCurrent = undefined; await clean?.(); }
