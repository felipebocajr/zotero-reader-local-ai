// Real multilingual inference through the native settings and reader, isolated profile only.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow(), api = Zotero.ReaderLocalAI;
  const original = api.getSettings(), originalRuntime = api.getRuntimePreferences();
  const languagePref = "extensions.reader-local-ai.responseLanguage";
  const hadLanguagePref = Services.prefs.prefHasUserValue(languagePref);
  const output = root + "/experiments/results/native-languages.json";
  const results = { zoteroVersion: Zotero.version, profile: "isolated", status: "running", checks: [], answers: [], runtimes: [], errors: [] };
  const save = () => IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const check = (name, passed) => { results.checks.push({ name, passed: !!passed }); if (!passed) throw new Error(name); };
  const wait = async (predicate, label, timeout = 180000) => {
    const started = Date.now();
    while (!predicate()) { if (Date.now() - started > timeout) throw new Error("Timeout: " + label); await sleep(100); }
  };
  let pref, reader;
  const doc = () => reader._iframe.contentDocument;
  const popup = () => doc().querySelector(".reader-local-ai-popup");
  const button = label => [...popup().querySelectorAll("button")].find(button => button.textContent === label);
  async function preferences() {
    pref = Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    await wait(() => pref.document.getElementById("reader-local-ai-responseLanguage")?.options.length === 2, "language settings", 15000);
  }
  async function language(id, model) {
    await preferences();
    pref.document.getElementById("reader-local-ai-responseLanguage").value = id;
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    check(model + ": native preferences save " + id, api.getSettings().responseLanguage === id);
    pref.close(); pref = null;
    await preferences();
    check(model + ": language survives closing/reopening " + id, pref.document.getElementById("reader-local-ai-responseLanguage").value === id);
    pref.close(); pref = null;
  }
  async function snapshot(target, name) {
    const bitmap = await target.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = target.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(root + "/.runtime/" + name + ".png", new Uint8Array(await blob.arrayBuffer()));
  }
  async function answer(model, language, question, followup = false) {
    const started = Date.now();
    if (followup) {
      button("Continuar perguntando").click();
      popup().querySelector("textarea").value = question;
      popup().querySelector("form").requestSubmit();
    }
    await wait(() => !button("Continuar perguntando").hidden || popup().querySelector(".reader-local-ai-error").textContent, "real multilingual answer");
    const error = popup().querySelector(".reader-local-ai-error").textContent;
    if (error) throw new Error(error);
    const answers = popup().querySelectorAll(".reader-local-ai-answer");
    const text = answers[answers.length - 1].textContent;
    results.answers.push({ model, responseLanguage: language, question, answer: text, totalMs: Date.now() - started });
    check(model + ": final answer completes in " + language, text.trim().length > 0 && !text.includes("<think>"));
    await save();
  }
  try {
    if (api.getRuntimeState().owned) throw new Error("Stop the existing isolated runtime before this test");
    // A profile upgrading from the previous XPI has no user preference yet.
    Services.prefs.clearUserPref(languagePref);
    check("existing profile without language preference defaults to pt-BR", api.getSettings().responseLanguage === "pt-BR");
    await preferences();
    check("native language labels are readable", [...pref.document.getElementById("reader-local-ai-responseLanguage").options].map(option => option.textContent).join(",") === "Português (Brasil),Inglês");
    await snapshot(pref, "native-language-preferences"); pref.close(); pref = null;
    reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) || Zotero.Reader._readers.at(-1);
    const attachment = Zotero.Items.get(reader.itemID), before = attachment.getAnnotations().length;
    const paper = await Zotero.PDFWorker.getFullText(reader.itemID, null);
    results.paper = { title: attachment.getField("title"), pages: paper.extractedPages, totalPages: paper.totalPages, chars: paper.text.length };
    check("full English PDF is available", paper.extractedPages === paper.totalPages && paper.text.includes("Attention Is All You Need"));
    for (const model of ["lfm2.5-2.6b", "lfm2.5-8b-a1b"]) {
      // Optional existing 8B runtime: do not duplicate its weights or take ownership.
      let external = false;
      if (model === "lfm2.5-8b-a1b") {
        try {
          const models = await (await win.fetch("http://127.0.0.1:8080/v1/models")).json();
          const props = await (await win.fetch("http://127.0.0.1:8080/props")).json();
          external = models.data.some(item => item.id === model) && props.total_slots === 1 && props.default_generation_settings?.n_ctx === 32768;
        } catch { /* Use a new isolated runtime if no matching external server exists. */ }
      }
      api.saveConfiguration({ ...original, baseUrl: "http://127.0.0.1:" + (external ? 8080 : 18095), model, responseLanguage: "pt-BR", contextTokens: 32768 }, { projectRoot: root, autoStart: false });
      await api.startRuntime();
      await wait(() => ["ready", "error", "external"].includes(api.getRuntimeState().phase), "managed runtime");
      const state = api.getRuntimeState();
      check(model + ": real selected runtime is available with expected ownership",
        state.phase === (external ? "external" : "ready") && state.owned === !external && state.model === model);
      const pid = state.pid; results.runtimes.push(state);
      await language("pt-BR", model);
      popup()?.querySelector(".reader-local-ai-close").click();
      const view = reader._internalReader._primaryView;
      await view.initializedPromise;
      const chars = view._pdfPages[0].chars.slice(0, 26);
      view._setSelectionRanges(Components.utils.cloneInto([{ collapsed: false, text: chars.map(char => char.u).join(""), sortIndex: "00000|000000|00000",
        position: { pageIndex: 0, rects: [[chars[0].rect[0], chars[0].rect[1], chars.at(-1).rect[2], chars[0].rect[3]]] } }], reader._iframe.contentWindow));
      await wait(() => doc().querySelector(".reader-local-ai-actions"), "selection actions", 15000);
      [...doc().querySelector(".reader-local-ai-actions").querySelectorAll("button")].find(button => button.textContent === "Explicar trecho").click();
      await wait(popup, "explanation popup", 15000);
      await answer(model, "pt-BR", "Explicar trecho");
      await language("en", model);
      check(model + ": language change needs no server restart", api.getRuntimeState().pid === pid && !api.getRuntimeState().restartRequired);
      await answer(model, "en", "Explique por que este artigo usa atenção em vez de recorrência, em até 100 palavras.", true);
      await language("pt-BR", model);
      await answer(model, "pt-BR", "Explain how this architecture processes a sequence, in at most 100 words.", true);
      check(model + ": changing language preserves three completed turns", popup().querySelectorAll(".reader-local-ai-turn").length === 3);
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
    if (!hadLanguagePref) Services.prefs.clearUserPref(languagePref);
    await save();
  }
})();
