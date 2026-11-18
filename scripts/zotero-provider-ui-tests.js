// Capture the provider selector in the native preferences pane.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  if (dataDir !== base + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow();
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const results = { checks: [], styles: {}, errors: [] };
  const api = Zotero.ReaderLocalAI;
  const originalRequestGroqModels = api.requestGroqModels;
  const originalGetGroqModels = api.getGroqModels;
  let mockModelsRevision = 0;
  const mockModels = [
    { id: "openai/gpt-oss-120b", ownedBy: "OpenAI", contextWindow: 131072, maxCompletionTokens: 65536, reasoning: true },
    { id: "llama-3.3-70b-versatile", ownedBy: "Meta", contextWindow: 131072, maxCompletionTokens: 32768, reasoning: false },
  ];
  api.requestGroqModels = () => { mockModelsRevision = 1; };
  api.getGroqModels = () => ({ phase: "ready", revision: mockModelsRevision, models: mockModelsRevision ? mockModels : [], error: "" });
  let pref;
  const check = (name, passed) => { results.checks.push({ name, passed: !!passed }); if (!passed) throw new Error(name); };
  const style = element => {
    const computed = pref.document.defaultView.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return { display: computed.display, backgroundColor: computed.backgroundColor, borderColor: computed.borderColor,
      appearance: computed.appearance || computed.webkitAppearance, width: Math.round(rect.width), height: Math.round(rect.height),
      checked: element.checked, hidden: element.hidden };
  };
  const display = element => pref.document.defaultView.getComputedStyle(element).display;
  async function snapshot(name) {
    const bitmap = await pref.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = pref.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(base + "/.runtime/" + name + ".png", new Uint8Array(await blob.arrayBuffer()));
  }
  try {
    pref = Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    const started = Date.now();
    while (!pref.document.getElementById("reader-local-ai-provider-groq")) {
      if (Date.now() - started > 15000) throw new Error("Preferences pane did not load");
      await sleep(50);
    }
    const local = pref.document.getElementById("reader-local-ai-provider-local");
    const groq = pref.document.getElementById("reader-local-ai-provider-groq");
    const localLabel = local.closest("label");
    const groqLabel = groq.closest("label");
    const localSettings = pref.document.getElementById("reader-local-ai-local-settings");
    const groqSettings = pref.document.getElementById("reader-local-ai-groq-settings");
    const localModelLabel = pref.document.getElementById("reader-local-ai-model-label");
    check("Groq fields start hidden", display(groqSettings) === "none");
    check("local fields start visible", display(localSettings) !== "none");
    results.styles.localBefore = style(local);
    results.styles.groqBefore = style(groq);
    results.styles.localLabel = style(localLabel);
    results.styles.groqLabel = style(groqLabel);
    check("local starts selected", local.checked && !groq.checked);
    check("local card starts highlighted", localLabel.classList.contains("selected") && style(localLabel).backgroundColor !== "rgba(0, 0, 0, 0)");
    await snapshot("native-provider-ui-local");
    groq.click();
    await sleep(300);
    results.styles.localAfter = style(local);
    results.styles.groqAfter = style(groq);
    results.styles.localLabelAfter = style(localLabel);
    results.styles.groqLabelAfter = style(groqLabel);
    check("Groq click checks Groq", groq.checked && !local.checked);
    check("Groq card is highlighted", groqLabel.classList.contains("selected") && !localLabel.classList.contains("selected"));
    check("Groq card has a selected background", style(groqLabel).backgroundColor !== "rgba(0, 0, 0, 0)");
    check("Groq fields visible after click", display(groqSettings) !== "none");
    check("local fields hidden after click", display(localSettings) === "none");
    check("local model label hidden after click", display(localModelLabel) === "none");
    await snapshot("native-provider-ui-groq");

    pref.document.getElementById("reader-local-ai-apiKey").value = "gsk_test_pane_key";
    pref.document.getElementById("reader-local-ai-groq-refresh").click();
    await sleep(1600);
    const modelSelect = pref.document.getElementById("reader-local-ai-groqModelSelect");
    check("Groq model list is populated", modelSelect.options.length === 3);
    check("Groq model list keeps model ids", [...modelSelect.options].some(option => option.value === "openai/gpt-oss-120b"));
    modelSelect.value = "openai/gpt-oss-120b";
    modelSelect.dispatchEvent(new pref.Event("change", { bubbles: true }));
    await sleep(100);
    check("selecting a Groq model fills the field", pref.document.getElementById("reader-local-ai-groqModel").value === "openai/gpt-oss-120b");
    check("Groq model details show context", pref.document.getElementById("reader-local-ai-groq-model-details").textContent.includes("131.072"));
    check("Groq model context is applied", pref.document.getElementById("reader-local-ai-contextTokens").max === "131072");

    local.click();
    await sleep(300);
    check("local click restores local", local.checked && !groq.checked);
    check("local card is highlighted again", localLabel.classList.contains("selected") && !groqLabel.classList.contains("selected"));
    check("local fields visible after click", display(localSettings) !== "none");
    check("Groq fields hidden after local", display(groqSettings) === "none");
    check("local model label visible after local", display(localModelLabel) !== "none");
    await snapshot("native-provider-ui-local-again");
  } catch (error) {
    results.errors.push({ message: String(error), stack: error.stack });
  } finally {
    api.requestGroqModels = originalRequestGroqModels;
    api.getGroqModels = originalGetGroqModels;
    pref?.close();
    await IOUtils.writeUTF8(base + "/experiments/results/native-provider-ui.json", JSON.stringify(results, null, 2));
  }
})();
