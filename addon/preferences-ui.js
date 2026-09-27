var ReaderLocalAIPreferences = {
  init() {
    this.lifetime = Zotero.ReaderLocalAI.watchPreferencesWindow(document.defaultView);
    if (this.timer) document.defaultView.clearTimeout(this.timer);
    const settings = Zotero.ReaderLocalAI.getSettings();
    const select = document.getElementById("reader-local-ai-model");
    select.replaceChildren();
    for (const model of Zotero.ReaderLocalAI.getModels()) {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = model.id; option.textContent = model.label; select.append(option);
    }
    const languages = document.getElementById("reader-local-ai-responseLanguage");
    languages.replaceChildren();
    for (const language of Zotero.ReaderLocalAI.getResponseLanguages()) {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = language.id; option.textContent = language.label; languages.append(option);
    }
    for (const key of ["baseUrl", "model", "responseLanguage", "contextTokens", "generationTokens"]) {
      document.getElementById("reader-local-ai-" + key).value = settings[key];
    }
    document.getElementById("reader-local-ai-timeoutSeconds").value = settings.timeoutMs / 1000;
    const runtime = Zotero.ReaderLocalAI.getRuntimePreferences();
    document.getElementById("reader-local-ai-projectRoot").value = runtime.projectRoot;
    document.getElementById("reader-local-ai-autoStart").checked = runtime.autoStart;
    this.updateModel();
    this.renderRuntime();
    this.poll();
  },
  updateModel() {
    const id = document.getElementById("reader-local-ai-model").value;
    const model = Zotero.ReaderLocalAI.getModels().find(model => model.id === id);
    if (!model) return;
    document.getElementById("reader-local-ai-contextTokens").max = model.maxContextTokens;
    document.getElementById("reader-local-ai-model-description").textContent = model.description;
  },
  save() {
    const read = key => document.getElementById("reader-local-ai-" + key).value;
    const status = document.getElementById("reader-local-ai-settings-status");
    try {
      Zotero.ReaderLocalAI.saveConfiguration({
        baseUrl: read("baseUrl"), model: read("model"), responseLanguage: read("responseLanguage"), contextTokens: Number(read("contextTokens")),
        generationTokens: Number(read("generationTokens")), timeoutMs: Number(read("timeoutSeconds")) * 1000,
      }, { projectRoot: read("projectRoot"), autoStart: document.getElementById("reader-local-ai-autoStart").checked });
      status.textContent = "Configurações salvas.";
      this.renderRuntime();
      return true;
    } catch (error) { status.textContent = error.message; return false; }
  },
  chooseFolder() {
    Zotero.ReaderLocalAI.browseRuntimeFolder(document.defaultView);
  },
  run(action) {
    if (action !== "stopRuntime" && !this.save()) return;
    try {
      Zotero.ReaderLocalAI.runRuntimeAction(action);
      this.renderRuntime();
    } catch (error) { if (!this.lifetime.closed) document.getElementById("reader-local-ai-settings-status").textContent = error.message; }
  },
  renderRuntime() {
    if (this.lifetime.closed) return;
    const state = Zotero.ReaderLocalAI.getRuntimeState();
    const busy = state.phase === "starting" || state.phase === "stopping";
    document.getElementById("reader-local-ai-start-server").disabled = busy || state.owned || state.phase === "external";
    document.getElementById("reader-local-ai-stop-server").disabled = state.phase === "stopping" || (!state.owned && state.phase !== "starting");
    document.getElementById("reader-local-ai-restart-server").disabled = busy || !state.owned;
    document.getElementById("reader-local-ai-runtime-status").textContent = state.message + (state.restartRequired ? " Reinicie para aplicar o novo modelo, contexto, endereço ou pasta." : "");
    document.getElementById("reader-local-ai-runtime-details").hidden = !state.details;
    document.getElementById("reader-local-ai-runtime-log").textContent = state.details || "";
  },
  poll() {
    this.lifetime.timer = this.timer = document.defaultView.setTimeout(() => {
      if (this.lifetime.closed || !document.getElementById("reader-local-ai-runtime-status")?.isConnected || !Zotero.ReaderLocalAI) return;
      try { Zotero.ReaderLocalAI.requestRuntimeRefresh(); this.renderRuntime(); }
      catch { /* The pane or plugin may have closed while a status request was pending. */ }
      finally { if (!this.lifetime.closed && Zotero.ReaderLocalAI) this.poll(); }
    }, 1000);
  },
};
