// Real multilingual inference through the native reader, isolated profile only.
// The response must follow the language of each question; there is no stored
// language preference anymore.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  if (dataDir !== base + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow(), api = Zotero.ReaderLocalAI;
  const original = api.getSettings(), originalRuntime = api.getRuntimePreferences();
  const output = base + "/experiments/results/native-languages-auto.json";
  const results = { zoteroVersion: Zotero.version, profile: "isolated", status: "running", checks: [], answers: [], runtimes: [], errors: [] };
  const save = () => IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const check = (name, passed, detail) => {
    results.checks.push({ name, passed: !!passed, ...(detail ? { detail } : {}) });
    if (!passed) throw new Error(name);
  };
  const wait = async (predicate, label, timeout = 180000) => {
    const started = Date.now();
    while (!predicate()) { if (Date.now() - started > timeout) throw new Error("Timeout: " + label); await sleep(100); }
  };
  let pref, reader;
  const doc = () => reader._iframe.contentDocument;
  const popup = () => doc().querySelector(".reader-local-ai-popup");
  const button = label => [...popup().querySelectorAll("button")].find(button => button.textContent === label);
  function detectedLanguage(text) {
    const portuguese = (text.match(/[ãõçáéíóúâêôà]/gi) || []).length +
      (text.match(/\b(não|uma|para|como|porque|porquê|é|são|está|estão|artigo|resposta|atenção|modelo|trecho|selecionado|funciona)\b/gi) || []).length;
    const english = (text.match(/\b(the|is|are|this|that|these|with|for|and|answer|article|paper|model|uses|used|attention|works|because)\b/gi) || []).length;
    return portuguese > english ? "pt-BR" : english > portuguese ? "en" : "unknown";
  }
  async function preferences() {
    pref = Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    await wait(() => pref.document.getElementById("reader-local-ai-retrievalMode"), "preferences", 15000);
  }
  async function snapshot(target, name) {
    const bitmap = await target.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = target.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(base + "/.runtime/" + name + ".png", new Uint8Array(await blob.arrayBuffer()));
  }
  async function answer(model, expected, question, followup = false) {
    const started = Date.now();
    if (followup) {
      button("Continuar perguntando").click();
      popup().querySelector("textarea").value = question;
      popup().querySelector("form").requestSubmit();
    }
    await wait(() => !button("Continuar perguntando").hidden || popup().querySelector(".reader-local-ai-error").textContent, "multilingual answer");
    const error = popup().querySelector(".reader-local-ai-error").textContent;
    if (error) throw new Error(error);
    const answers = popup().querySelectorAll(".reader-local-ai-answer");
    const text = answers[answers.length - 1].textContent;
    const detected = detectedLanguage(text);
    results.answers.push({ model, expected, detected, question, answer: text, totalMs: Date.now() - started });
    check(model + ": answer follows " + expected, text.trim().length > 0 && !text.includes("<think>") && detected === expected,
      { detected, preview: text.slice(0, 240) });
    await save();
  }
  try {
    if (api.getRuntimeState().owned) throw new Error("Stop the existing isolated runtime before this test");
    await preferences();
    check("language preference was removed", !pref.document.getElementById("reader-local-ai-responseLanguage"));
    await snapshot(pref, "native-language-preferences-auto"); pref.close(); pref = null;
    reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) || Zotero.Reader._readers.at(-1);
    const attachment = Zotero.Items.get(reader.itemID), before = attachment.getAnnotations().length;
    const paper = await Zotero.PDFWorker.getFullText(reader.itemID, null);
    results.paper = { title: attachment.getField("title"), pages: paper.extractedPages, totalPages: paper.totalPages, chars: paper.text.length };
    check("full English PDF is available", paper.extractedPages === paper.totalPages && paper.text.includes("Attention Is All You Need"));
    for (const model of ["lfm2.5-8b-a1b", "lfm3-1.7b"]) {
      // Optional existing 8B runtime: do not duplicate its weights or take ownership.
      let external = false;
      if (model === "lfm2.5-8b-a1b") {
        try {
          const models = await (await win.fetch("http://127.0.0.1:8080/v1/models")).json();
          const props = await (await win.fetch("http://127.0.0.1:8080/props")).json();
          external = models.data.some(item => item.id === model) && props.total_slots === 1 && props.default_generation_settings?.n_ctx === 32768;
        } catch { /* Use a new isolated runtime if no matching external server exists. */ }
      }
      api.saveConfiguration({ ...original, baseUrl: "http://127.0.0.1:" + (external ? 8080 : 18095), model,
        retrievalMode: "full", contextTokens: 32768 }, { projectRoot: root, autoStart: false });
      await api.startRuntime();
      await wait(() => ["ready", "error", "external"].includes(api.getRuntimeState().phase), "managed runtime");
      const state = api.getRuntimeState();
      check(model + ": real selected runtime is available with expected ownership",
        state.phase === (external ? "external" : "ready") && state.owned === !external && state.model === model);
      results.runtimes.push(state);
      popup()?.querySelector(".reader-local-ai-close").click();
      const view = reader._internalReader._primaryView;
      await view.initializedPromise;
      const chars = view._pdfPages[0].chars.slice(0, 26);
      view._setSelectionRanges(Components.utils.cloneInto([{ collapsed: false, text: chars.map(char => char.u).join(""), sortIndex: "00000|000000|00000",
        position: { pageIndex: 0, rects: [[chars[0].rect[0], chars[0].rect[1], chars.at(-1).rect[2], chars[0].rect[3]]] } }], reader._iframe.contentWindow));
      await wait(() => doc().querySelector(".reader-local-ai-actions"), "selection actions", 15000);
      [...doc().querySelector(".reader-local-ai-actions").querySelectorAll("button")].find(button => button.textContent === "Explicar trecho").click();
      await wait(popup, "explanation popup", 15000);
      await answer(model, "en", "Explain this passage.");
      await answer(model, "pt-BR", "Explique por que este artigo usa atenção em vez de recorrência, em até 100 palavras.", true);
      await answer(model, "en", "Explain how this architecture processes a sequence, in at most 100 words.", true);
      check(model + ": changing language preserves three completed turns", popup().querySelectorAll(".reader-local-ai-turn").length === 3);
      check(model + ": popup labels each side of the conversation",
        popup().querySelector(".reader-local-ai-question-message .reader-local-ai-author").textContent === "Você" &&
        popup().querySelectorAll(".reader-local-ai-answer-message .reader-local-ai-author")[0].textContent === "Assistente");
      await snapshot(win, "native-language-" + model);
      popup().querySelector(".reader-local-ai-close").click();
      await api.stopRuntime();
    }
    check("language tests never create annotations", attachment.getAnnotations().length === before);
    results.status = "ok";
  } catch (error) { results.status = "error"; results.errors.push({ message: String(error), stack: error.stack }); }
  finally {
    pref?.close(); if (reader) popup()?.querySelector(".reader-local-ai-close").click();
    await api.stopRuntime(); api.saveSettings(original); api.saveRuntimePreferences(originalRuntime);
    await save();
  }
})();
