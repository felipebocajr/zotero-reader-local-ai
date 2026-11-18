// Verify the Groq provider pane without contacting the network.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  if (dataDir !== base + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const api = Zotero.ReaderLocalAI, win = Zotero.getMainWindow();
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const results = { profile: "isolated", checks: [], errors: [] };
  let pref;
  const check = (name, passed) => { results.checks.push({ name, passed: !!passed }); if (!passed) throw new Error(name); };
  const original = api.getSettings();
  const originalRuntime = api.getRuntimePreferences();
  try {
    pref = Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    const started = Date.now();
    while (!pref.document.getElementById("reader-local-ai-provider-groq")) {
      if (Date.now() - started > 15000) throw new Error("Preferences pane did not load");
      await sleep(50);
    }
    const localRadio = pref.document.getElementById("reader-local-ai-provider-local");
    const groqRadio = pref.document.getElementById("reader-local-ai-provider-groq");
    check("provider selector defaults to local", localRadio.checked && !groqRadio.checked);
    check("Groq fields start hidden", pref.document.getElementById("reader-local-ai-groq-settings").hidden);

    groqRadio.checked = true;
    groqRadio.dispatchEvent(new pref.Event("change", { bubbles: true }));
    await sleep(100);
    check("Groq fields become visible", !pref.document.getElementById("reader-local-ai-groq-settings").hidden);
    check("local fields hide for Groq", pref.document.getElementById("reader-local-ai-local-settings").hidden);
    check("local base URL hides for Groq", pref.document.getElementById("reader-local-ai-baseUrl-label").hidden);

    pref.document.getElementById("reader-local-ai-apiKey").value = "gsk_test_pane_key";
    pref.document.getElementById("reader-local-ai-groqModel").value = "openai/gpt-oss-120b";
    pref.document.getElementById("reader-local-ai-contextTokens").value = "64000";
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    await sleep(100);
    const saved = api.getSettings();
    check("Groq settings save the provider", saved.provider === "groq");
    check("Groq settings save the model", saved.model === "openai/gpt-oss-120b");
    check("Groq settings save the key", saved.apiKey === "gsk_test_pane_key");
    check("Groq settings use the fixed HTTPS endpoint", saved.baseUrl === "https://api.groq.com/openai/v1");
    await api.refreshRuntime();
    check("Groq is reported as an external provider", api.getRuntimeState().phase === "external");
    check("Groq settings preserve the local model", api.getLocalModel() === original.model);

    localRadio.checked = true;
    localRadio.dispatchEvent(new pref.Event("change", { bubbles: true }));
    await sleep(100);
    check("local fields return", !pref.document.getElementById("reader-local-ai-local-settings").hidden);
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    await sleep(100);
    check("switching back restores the local provider", api.getSettings().provider === "local");
    check("switching back restores the local model", api.getSettings().model === original.model);
  } catch (error) {
    results.errors.push({ message: String(error), stack: error.stack });
  } finally {
    try { api.saveSettings(original); } catch { /* Best effort restore. */ }
    try { api.saveRuntimePreferences(originalRuntime); } catch { /* Best effort restore. */ }
    pref?.close();
    await IOUtils.writeUTF8(base + "/experiments/results/native-groq-pane.json", JSON.stringify(results, null, 2));
  }
})();
