// Start/stop/restart from the native preferences pane, using actual Q4 inference.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow(), sleep = ms => new Promise(r => win.setTimeout(r, ms));
  const results = { zoteroVersion: Zotero.version, profile: "isolated", checks: [], runs: [], errors: [] };
  const original = Zotero.ReaderLocalAI.getSettings(), originalRuntime = Zotero.ReaderLocalAI.getRuntimePreferences();
  let pref, reader;
  const check = (name, passed) => { results.checks.push({ name, passed: !!passed }); if (!passed) throw new Error(name + ": " + JSON.stringify(Zotero.ReaderLocalAI?.getRuntimeState())); };
  const wait = async (predicate, label, timeout = 150000) => {
    const started = Date.now();
    while (!await predicate()) { if (Date.now() - started > timeout) throw new Error("Timeout: " + label + " " + JSON.stringify(Zotero.ReaderLocalAI?.getRuntimeState())); await sleep(200); }
  };
  const state = () => Zotero.ReaderLocalAI.getRuntimeState();
  const field = id => pref.document.getElementById("reader-local-ai-" + id);
  const click = id => field(id).click();
  const save = () => pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
  const stopped = async pid => !pid || !await IOUtils.exists("/proc/" + pid);
  async function openPreferences() {
    pref = Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    await wait(() => field("model")?.options.length === 2, "preferences", 15000);
  }
  async function ready(model) {
    await wait(() => {
      if (state().phase === "error") throw new Error(state().message + "\n" + state().details);
      return state().phase === "ready" && state().model === model;
    }, "actual runtime ready");
    const status = await IOUtils.readJSON(root + "/.runtime/server-18094.json");
    check("ready process belongs to the current controller: " + model, state().owned && state().pid === status.supervisorPid);
    check("requested context and unquantized cache preserved: " + model, status.contextTokens === 32768 && status.cacheTypes === "f16/f16");
    return status;
  }
  async function answer(model, status) {
    reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) || Zotero.Reader._readers.at(-1);
    const doc = reader._iframe.contentDocument;
    doc.querySelector(".reader-local-ai-close")?.click();
    const view = reader._internalReader._primaryView; await view.initializedPromise;
    const chars = view._pdfPages[0].chars.slice(0, 26);
    view._setSelectionRanges(Components.utils.cloneInto([{collapsed:false,text:chars.map(c=>c.u).join(""),sortIndex:"00000|000000|00000",
      position:{pageIndex:0,rects:[[chars[0].rect[0],chars[0].rect[1],chars.at(-1).rect[2],chars[0].rect[3]]]}}],reader._iframe.contentWindow));
    await wait(() => doc.querySelector(".reader-local-ai-actions"), "selection", 15000);
    [...doc.querySelector(".reader-local-ai-actions").querySelectorAll("button")].find(b=>b.textContent === "Fazer pergunta").click();
    const popup = doc.querySelector(".reader-local-ai-popup");
    popup.querySelector("textarea").value = "Explique por que a atenção por produto escalar é dividida pela raiz quadrada da dimensão das chaves, usando o artigo completo.";
    const started = Date.now(); popup.querySelector("form").requestSubmit();
    await wait(() => popup.querySelector(".reader-local-ai-error").textContent || [...popup.querySelectorAll("button")].some(b=>b.textContent === "Continuar perguntando" && !b.hidden), "real answer", 240000);
    const error = popup.querySelector(".reader-local-ai-error").textContent;
    if (error) throw new Error(error);
    const text = popup.querySelector(".reader-local-ai-answer").dataset.readerLocalAiSource;
    check("actual full-paper answer after native launch: " + model, text?.length > 50 && !text.includes("<think>"));
    results.runs.push({ model, status, totalMs: Date.now()-started, answer: text });
    popup.querySelector(".reader-local-ai-close").click();
  }
  async function snapshot() {
    const bitmap = await pref.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = pref.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height; canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise(r=>canvas.toBlob(r,"image/png"));
    await IOUtils.write(root+"/.runtime/native-runtime-preferences.png", new Uint8Array(await blob.arrayBuffer()));
  }
  try {
    await openPreferences();
    field("baseUrl").value = "http://127.0.0.1:18094"; field("model").value = "lfm2.5-2.6b";
    field("model").dispatchEvent(new pref.Event("change", {bubbles:true}));
    field("contextTokens").value = "32768"; field("generationTokens").value = "4096";
    field("autoStart").checked = false; field("projectRoot").value = root+"/missing-folder";
    click("start-server"); await wait(() => state().phase === "error", "invalid folder", 10000);
    check("invalid project folder gives a readable error", state().message.includes("pasta") && !state().owned);
    await wait(() => !field("start-server").disabled, "native status refresh after failed start", 5000);
    field("projectRoot").value = root; click("start-server"); click("start-server");
    check("manual launch shows progress immediately", state().phase === "starting");
    let status = await ready("lfm2.5-2.6b");
    check("manual start button is disabled while owned", field("start-server").disabled);
    await snapshot(); pref.close(); pref = null;
    await answer("lfm2.5-2.6b", status);
    await openPreferences(); field("model").value = "lfm2.5-8b-a1b";
    field("model").dispatchEvent(new pref.Event("change", {bubbles:true})); save();
    check("changing model asks for explicit restart", state().restartRequired && field("runtime-status").textContent.includes("Reinicie"));
    const old = status; click("restart-server"); status = await ready("lfm2.5-8b-a1b");
    check("restart reaps both old processes", await stopped(old.supervisorPid) && await stopped(old.attempts.at(-1).pid));
    pref.close(); pref = null; await answer("lfm2.5-8b-a1b", status);
    await openPreferences(); click("stop-server"); await wait(() => state().phase === "stopped", "manual stop", 45000);
    check("manual stop releases supervisor and llama child", await stopped(status.supervisorPid) && await stopped(status.attempts.at(-1).pid));
    field("baseUrl").value = "http://127.0.0.1:18080"; field("model").value = "lfm2.5-2.6b"; save();
    await wait(() => state().phase === "external", "external server detected", 10000);
    check("external server cannot be stopped or restarted from UI", !state().owned && field("stop-server").disabled && field("restart-server").disabled);
    await Zotero.ReaderLocalAI.stopRuntime();
    check("stop leaves the external server available", (await win.fetch("http://127.0.0.1:18080/health")).ok);
    field("baseUrl").value = "http://127.0.0.1:18094"; field("projectRoot").value = root; field("autoStart").checked = true; save();
    check("native auto-start preference persists", Zotero.ReaderLocalAI.getRuntimePreferences().autoStart === true);
    pref.close(); pref = null;
    const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID("reader-local-ai@local.invalid");
    await addon.disable(); await addon.enable();
    await wait(() => !!Zotero.ReaderLocalAI, "plugin re-enabled", 15000); status = await ready("lfm2.5-2.6b");
    check("auto-start on plugin startup owns a fresh process", status.supervisorPid > 0);
    Zotero.ReaderLocalAI.saveRuntimePreferences({ projectRoot: root, autoStart: false });
    await addon.disable();
    await wait(() => stopped(status.supervisorPid), "disable reaps supervisor", 45000);
    check("plugin disable reaps the llama child", await stopped(status.attempts.at(-1).pid));
    await addon.enable(); await wait(() => !!Zotero.ReaderLocalAI, "plugin enabled without auto-start", 15000);
    check("auto-start disabled leaves the server stopped", !state().owned && state().phase === "stopped");
  } catch (error) { results.errors.push({ message:String(error), stack:error.stack }); }
  finally {
    pref?.close(); reader?._iframe.contentDocument.querySelector(".reader-local-ai-close")?.click();
    if (Zotero.ReaderLocalAI) {
      await Zotero.ReaderLocalAI.stopRuntime(); Zotero.ReaderLocalAI.saveSettings(original);
      Zotero.ReaderLocalAI.saveRuntimePreferences(originalRuntime);
    }
    await IOUtils.writeUTF8(root+"/experiments/results/native-runtime.json", JSON.stringify(results,null,2));
  }
})();
