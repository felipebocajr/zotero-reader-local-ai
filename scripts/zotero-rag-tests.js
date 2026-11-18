// Focused native RAG acceptance test, isolated profile only.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const output = base + "/experiments/results/native-rag.json";
  const results = { zoteroVersion: Zotero.version, profile: "isolated", checks: [], errors: [] };
  const check = (name, passed, detail = {}) => {
    results.checks.push({ name, passed: !!passed, ...detail });
    if (!passed) throw new Error(name);
  };
  const win = Zotero.getMainWindow();
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const wait = async (predicate, label, timeout = 30000) => {
    const start = Date.now();
    while (!predicate()) { if (Date.now() - start > timeout) throw new Error("Timeout: " + label); await sleep(100); }
  };
  const initial = Zotero.ReaderLocalAI.getSettings();
  let reader;
  try {
    if (dataDir !== base + "/.runtime/zotero-data") throw new Error("Isolated profile required");
    const attachment = Zotero.Items.get(Zotero.Prefs.get("extensions.reader-local-ai.devAttachmentID", true) || 0);
    if (!attachment?.isPDFAttachment()) throw new Error("Test PDF not found");
    reader = Zotero.Reader._readers.find(item => item.itemID === attachment.id) || await Zotero.Reader.open(attachment.id);
    await reader._initPromise;
    win.Zotero_Tabs.select(reader.tabID);
    const view = reader._internalReader._primaryView;
    await view.initializedPromise;
    await wait(() => view._pdfPages?.[0]?.chars?.length, "PDF pages", 30000);

    Zotero.ReaderLocalAI.saveSettings({ ...initial, baseUrl: "http://127.0.0.1:18080", model: "lfm2.5-8b-a1b",
      retrievalMode: "embeddings", contextTokens: 32768, generationTokens: 4096 });
    Zotero.ReaderLocalAI.runEmbeddingAction("start");
    await wait(() => ["ready", "external"].includes(Zotero.ReaderLocalAI.getEmbeddingState().phase), "embedding server", 120000);
    check("managed embedding server ready", Zotero.ReaderLocalAI.getEmbeddingState().model === "qwen3-embedding-0.6b",
      Zotero.ReaderLocalAI.getEmbeddingState());

    const chars = view._pdfPages[0].chars.slice(0, 26);
    view._setSelectionRanges(Components.utils.cloneInto([{ collapsed: false, text: chars.map(c => c.u).join(""), sortIndex: "00000|000000|00000",
      position: { pageIndex: 0, rects: [[chars[0].rect[0], chars[0].rect[1], chars.at(-1).rect[2], chars[0].rect[3]]] } }], reader._iframe.contentWindow));
    await sleep(200);
    const doc = reader._iframe.contentDocument;
    await wait(() => doc.querySelector(".reader-local-ai-actions"), "selection actions");
    const actions = doc.querySelector(".reader-local-ai-actions");
    [...actions.querySelectorAll("button")].find(button => button.textContent === "Fazer pergunta").click();
    await wait(() => doc.querySelector(".reader-local-ai-popup"), "AI popup");
    const popup = doc.querySelector(".reader-local-ai-popup");
    const field = popup.querySelector("textarea");
    field.value = "Como o cache KV funciona na decodificação em blocos?";
    popup.querySelector("form").requestSubmit();
    await wait(() => {
      const more = [...popup.querySelectorAll("button")].find(button => button.textContent === "Continuar perguntando");
      return more && !more.hidden;
    }, "RAG response", 120000);

    const request = await Zotero.HTTP.request("GET", "http://127.0.0.1:18080/requests", { responseType: "json", timeout: 10000 });
    const last = request.response.at(-1);
    const prompt = last.messages[1].content;
    check("prompt declares retrieved excerpts", prompt.includes("TRECHOS RECUPERADOS DO ARTIGO"));
    check("prompt omits the full article", !prompt.includes((await Zotero.PDFWorker.getFullText(attachment.id, null)).text));
    check("prompt uses excerpt-specific rules", last.messages[0].content.includes("retrieved excerpts"));
    check("prompt follows the Portuguese question", last.messages.at(-1).content.includes("Answer in Brazilian Portuguese (pt-BR)"));
    check("popup shows the retrieval note", popup.querySelector(".reader-local-ai-status").textContent.includes("Trechos relevantes"));
    check("RAG answer is rendered", !!popup.querySelector(".reader-local-ai-answer"));
    check("popup separates question and answer like a conversation",
      popup.querySelector(".reader-local-ai-question-message .reader-local-ai-author").textContent === "Você" &&
      popup.querySelector(".reader-local-ai-answer-message .reader-local-ai-author").textContent === "Assistente" &&
      !!popup.querySelector(".reader-local-ai-selection .reader-local-ai-author"));
    results.promptChars = prompt.length;
    results.retrievalNote = popup.querySelector(".reader-local-ai-status").textContent;
  } catch (error) {
    results.errors.push({ message: String(error), stack: error.stack });
  } finally {
    try { Zotero.ReaderLocalAI?.runEmbeddingAction("stop"); } catch { /* Best effort. */ }
    try { Zotero.ReaderLocalAI?.saveSettings(initial); } catch { /* Best effort. */ }
    await IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
  }
  Zotero.debug("READER_LOCAL_AI_RAG: " + JSON.stringify(results));
})();
