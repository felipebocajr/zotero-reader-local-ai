var ReaderLocalAIPreferences = {
  init() {
    this.lifetime = Zotero.ReaderLocalAI.watchPreferencesWindow(document.defaultView);
    if (this.timer) document.defaultView.clearTimeout(this.timer);
    this.groqModels = [];
    this.modelsRevision = 0;
    this.groqModel = Zotero.ReaderLocalAI.getGroqModel();
    const settings = Zotero.ReaderLocalAI.getSettings();
    const select = document.getElementById("reader-local-ai-model");
    select.replaceChildren();
    for (const model of Zotero.ReaderLocalAI.getModels()) {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = model.id; option.textContent = model.label; select.append(option);
    }
    select.value = Zotero.ReaderLocalAI.getLocalModel();
    for (const key of ["contextTokens", "generationTokens"]) {
      document.getElementById("reader-local-ai-" + key).value = settings[key];
    }
    document.getElementById("reader-local-ai-retrievalMode").value = settings.retrievalMode === "full" ? "full" : "embeddings";
    document.getElementById("reader-local-ai-baseUrl").value = Zotero.ReaderLocalAI.getLocalBaseUrl();
    document.getElementById("reader-local-ai-timeoutSeconds").value = settings.timeoutMs / 1000;
    document.getElementById("reader-local-ai-apiKey").value = String(settings.apiKey ?? "");
    document.getElementById("reader-local-ai-apiKey").onkeydown = event => {
      if (event.key === "Enter" && !event.isComposing) {
        event.preventDefault();
        this.loadGroqModels();
      }
    };
    const provider = settings.provider === "groq" ? "groq" : "local";
    document.getElementById("reader-local-ai-provider-" + provider).checked = true;
    const runtime = Zotero.ReaderLocalAI.getRuntimePreferences();
    document.getElementById("reader-local-ai-projectRoot").value = runtime.projectRoot;
    document.getElementById("reader-local-ai-autoStart").checked = runtime.autoStart;
    this.updateProvider();
    this.renderRuntime();
    this.renderEmbedding();
    this.poll();
  },
  provider() {
    return document.getElementById("reader-local-ai-provider-groq").checked ? "groq" : "local";
  },
  updateProvider() {
    const provider = this.provider();
    const groq = provider === "groq";
    document.getElementById("reader-local-ai-provider-local-label").classList.toggle("selected", !groq);
    document.getElementById("reader-local-ai-provider-groq-label").classList.toggle("selected", groq);
    document.getElementById("reader-local-ai-groq-settings").hidden = !groq;
    document.getElementById("reader-local-ai-local-settings").hidden = groq;
    document.getElementById("reader-local-ai-model-label").hidden = groq;
    document.getElementById("reader-local-ai-model-description").hidden = groq;
    document.getElementById("reader-local-ai-baseUrl-label").hidden = groq;
    this.updateRetrieval();
    if (groq) {
      const context = document.getElementById("reader-local-ai-contextTokens");
      context.max = 131072;
      if (Number(context.value) > 131072) context.value = 131072;
    } else this.updateModel();
    this.renderGroqModels();
    this.renderRuntime();
    this.renderEmbedding();
  },
  updateRetrieval() {
    const embeddings = document.getElementById("reader-local-ai-retrievalMode").value !== "full";
    const groq = this.provider() === "groq";
    document.getElementById("reader-local-ai-embedding-settings").hidden = !embeddings;
    document.getElementById("reader-local-ai-retrieval-description").textContent = embeddings
      ? "Somente os trechos recuperados do artigo são enviados ao provedor. Os embeddings são gerados localmente; no Groq, apenas esses trechos vão pela internet."
      : "O artigo completo é enviado ao provedor. No Groq, isso exige um limite de tokens maior que o plano free.";
    document.getElementById("reader-local-ai-provider-description").textContent = groq
      ? (embeddings ? "Trechos recuperados serão enviados ao Groq pela internet. A chave fica salva nas preferências do Zotero."
        : "O artigo completo será enviado ao Groq pela internet. A chave fica salva nas preferências do Zotero.")
      : (embeddings ? "Trechos recuperados serão enviados somente ao servidor local."
        : "O artigo completo é enviado somente ao servidor local.");
  },
  updateModel() {
    const id = document.getElementById("reader-local-ai-model").value;
    const model = Zotero.ReaderLocalAI.getModels().find(model => model.id === id);
    if (!model || this.provider() !== "local") return;
    const context = document.getElementById("reader-local-ai-contextTokens");
    context.max = model.maxContextTokens;
    if (Number(context.value) > model.maxContextTokens) context.value = model.maxContextTokens;
    document.getElementById("reader-local-ai-model-description").textContent = model.description;
  },
  formatTokens(value) {
    return typeof value === "number" && value > 0 ? value.toLocaleString("pt-BR") : "";
  },
  modelLabel(model) {
    const parts = [model.id];
    if (model.contextWindow) parts.push(this.formatTokens(model.contextWindow) + " contexto");
    if (model.maxCompletionTokens) parts.push(this.formatTokens(model.maxCompletionTokens) + " saída");
    return parts.join(" · ");
  },
  loadGroqModels() {
    const details = document.getElementById("reader-local-ai-groq-model-details");
    const key = document.getElementById("reader-local-ai-apiKey").value;
    if (!key.trim()) { details.textContent = "Informe a chave da API do Groq para buscar os modelos."; return; }
    details.textContent = "Buscando modelos na API do Groq…";
    const select = document.getElementById("reader-local-ai-groqModelSelect");
    if (select) select.disabled = true;
    this.modelsRevision = -1;
    Zotero.ReaderLocalAI.requestGroqModels(key);
  },
  renderGroqModels() {
    if (this.lifetime.closed) return;
    const state = Zotero.ReaderLocalAI.getGroqModels();
    if (!state || state.revision === this.modelsRevision) return;
    this.modelsRevision = state.revision;
    const select = document.getElementById("reader-local-ai-groqModelSelect");
    const details = document.getElementById("reader-local-ai-groq-model-details");
    if (!select || !details) return;
    if (state.phase === "loading") {
      select.disabled = true;
      select.replaceChildren();
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = ""; option.textContent = "Buscando modelos…";
      select.append(option);
      details.textContent = "Buscando modelos na API do Groq…";
      return;
    }
    select.disabled = false;
    if (state.phase === "error") {
      this.groqModels = [];
      select.replaceChildren();
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = ""; option.textContent = "Não foi possível carregar os modelos";
      select.append(option);
      details.textContent = state.error || "Não foi possível carregar os modelos.";
      return;
    }
    if (state.phase !== "ready") return;
    this.groqModels = state.models || [];
    select.replaceChildren();
    const placeholder = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
    placeholder.value = ""; placeholder.textContent = "Selecione um modelo…";
    select.append(placeholder);
    for (const model of this.groqModels) {
      const option = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      option.value = model.id; option.textContent = this.modelLabel(model); select.append(option);
    }
    const current = this.groqModel;
    if (current && !this.groqModels.some(model => model.id === current)) {
      const saved = document.createElementNS("http://www.w3.org/1999/xhtml", "option");
      saved.value = current; saved.textContent = current + " (salvo)"; select.append(saved);
    }
    if (current) select.value = current;
    if (current && this.groqModels.some(model => model.id === current)) this.showGroqModelDetails(current);
    else details.textContent = this.groqModels.length === 1
      ? "1 modelo de texto disponível. Selecione um para usar."
      : this.groqModels.length + " modelos de texto disponíveis. Selecione um para usar.";
  },
  selectGroqModel() {
    const id = document.getElementById("reader-local-ai-groqModelSelect").value;
    if (!id) return;
    this.groqModel = id;
    this.showGroqModelDetails(id);
  },
  showGroqModelDetails(id) {
    const model = this.groqModels.find(model => model.id === id);
    if (!model) return;
    const details = [];
    if (model.ownedBy) details.push(model.ownedBy);
    if (model.contextWindow) details.push(this.formatTokens(model.contextWindow) + " tokens de contexto");
    if (model.maxCompletionTokens) details.push(this.formatTokens(model.maxCompletionTokens) + " tokens de saída");
    details.push(model.reasoning ? "modelo de raciocínio" : "modelo de resposta direta");
    document.getElementById("reader-local-ai-groq-model-details").textContent = details.join(" · ");
    if (model.contextWindow) {
      const context = document.getElementById("reader-local-ai-contextTokens");
      context.max = Math.min(model.contextWindow, 131072);
      if (Number(context.value) > context.max) context.value = context.max;
    }
    if (model.maxCompletionTokens) {
      const generation = document.getElementById("reader-local-ai-generationTokens");
      generation.max = model.maxCompletionTokens;
      if (Number(generation.value) > model.maxCompletionTokens) generation.value = model.maxCompletionTokens;
    }
  },
  save() {
    const provider = this.provider();
    const read = key => document.getElementById("reader-local-ai-" + key).value;
    const status = document.getElementById("reader-local-ai-settings-status");
    try {
      Zotero.ReaderLocalAI.saveConfiguration({
        provider,
        baseUrl: provider === "groq" ? Zotero.ReaderLocalAI.getGroqDefaults().baseUrl : read("baseUrl"),
        model: provider === "groq" ? (this.groqModel || Zotero.ReaderLocalAI.getGroqModel()) : read("model"),
        apiKey: read("apiKey"),
        retrievalMode: read("retrievalMode"),
        contextTokens: Number(read("contextTokens")),
        generationTokens: Number(read("generationTokens")),
        timeoutMs: Number(read("timeoutSeconds")) * 1000,
      }, { projectRoot: read("projectRoot"), autoStart: document.getElementById("reader-local-ai-autoStart").checked });
      status.textContent = provider === "groq"
        ? "Configurações salvas. Informe a chave do Groq para usar."
        : "Configurações salvas.";
      this.renderRuntime();
      return true;
    } catch (error) { status.textContent = error.message; return false; }
  },
  chooseFolder() {
    Zotero.ReaderLocalAI.browseRuntimeFolder(document.defaultView);
  },
  run(action) {
    if (this.provider() !== "local") return;
    if (action !== "stopRuntime" && !this.save()) return;
    try {
      Zotero.ReaderLocalAI.runRuntimeAction(action);
      this.renderRuntime();
    } catch (error) { if (!this.lifetime.closed) document.getElementById("reader-local-ai-settings-status").textContent = error.message; }
  },
  runEmbedding(action) {
    if (action !== "stop" && !this.save()) return;
    try {
      Zotero.ReaderLocalAI.runEmbeddingAction(action);
      this.renderEmbedding();
    } catch (error) { if (!this.lifetime.closed) document.getElementById("reader-local-ai-settings-status").textContent = error.message; }
  },
  renderRuntime() {
    if (this.lifetime.closed || this.provider() !== "local") return;
    const state = Zotero.ReaderLocalAI.getRuntimeState();
    const busy = state.phase === "starting" || state.phase === "stopping";
    document.getElementById("reader-local-ai-start-server").disabled = busy || state.owned || state.phase === "external";
    document.getElementById("reader-local-ai-stop-server").disabled = state.phase === "stopping" || (!state.owned && state.phase !== "starting");
    document.getElementById("reader-local-ai-restart-server").disabled = busy || !state.owned;
    document.getElementById("reader-local-ai-runtime-status").textContent = state.message + (state.restartRequired ? " Reinicie para aplicar o novo modelo, contexto, endereço ou pasta." : "");
    document.getElementById("reader-local-ai-runtime-details").hidden = !state.details;
    document.getElementById("reader-local-ai-runtime-log").textContent = state.details || "";
  },
  renderEmbedding() {
    if (this.lifetime.closed) return;
    const state = Zotero.ReaderLocalAI.getEmbeddingState();
    const start = document.getElementById("reader-local-ai-start-embeddings");
    const stop = document.getElementById("reader-local-ai-stop-embeddings");
    const status = document.getElementById("reader-local-ai-embedding-status");
    if (!start || !stop || !status) return;
    const busy = state.phase === "starting";
    start.disabled = busy || state.owned || state.phase === "external";
    stop.disabled = !state.owned && state.phase !== "starting";
    status.textContent = state.message + (state.details ? "\n" + state.details : "");
  },
  poll() {
    this.lifetime.timer = this.timer = document.defaultView.setTimeout(() => {
      if (this.lifetime.closed || !document.getElementById("reader-local-ai-runtime-status")?.isConnected || !Zotero.ReaderLocalAI) return;
      try {
        if (this.provider() === "local") Zotero.ReaderLocalAI.requestRuntimeRefresh();
        Zotero.ReaderLocalAI.requestEmbeddingRefresh();
        this.renderRuntime();
        this.renderEmbedding();
        this.renderGroqModels();
      } catch { /* The pane or plugin may have closed while a status request was pending. */ }
      finally { if (!this.lifetime.closed && Zotero.ReaderLocalAI) this.poll(); }
    }, 1000);
  },
};
