// Verifies the managed Qwen3 embedding server from the isolated Zotero profile.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const output = base + "/experiments/results/native-embedding.json";
  const checks = [], errors = [];
  let initial;
  const check = (name, passed, details) => checks.push({ name, passed: !!passed, details });
  try {
    await Zotero.uiReadyPromise;
    if (dataDir !== base + "/.runtime/zotero-data") throw new Error("Refusing to test outside the isolated library");
    const api = Zotero.ReaderLocalAI;
    if (!api) throw new Error("Reader Local AI não está ativo");
    initial = api.getSettings();
    api.saveSettings({ ...initial, retrievalMode: "embeddings" });
    check("retrieval mode saved", api.getSettings().retrievalMode === "embeddings");

    api.runEmbeddingAction("start");
    const deadline = Date.now() + 120000;
    let state;
    while (Date.now() < deadline) {
      state = api.getEmbeddingState();
      if (["ready", "external", "error"].includes(state.phase)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    check("embedding server ready", ["ready", "external"].includes(state?.phase), state);
    check("embedding model matches", state?.model === "qwen3-embedding-0.6b", state);
    check("managed process is owned", state?.phase !== "ready" || state?.owned === true, state);

    const response = await Zotero.HTTP.request("POST", "http://127.0.0.1:18081/v1/embeddings", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input: [
        "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: Como o cache KV funciona na decodificação em blocos?",
        "Key-Value Cache for Block-Wise Decoding\nWe adopt a block-wise decoding strategy to support the use of a Key-Value (KV) Cache.",
      ] }),
      responseType: "json",
      timeout: 120000,
    });
    const payload = response.response;
    const vectors = payload?.data?.map(item => item.embedding) ?? [];
    check("embedding request returned two 1024-dimensional vectors", vectors.length === 2 && vectors.every(vector => vector.length === 1024), { length: vectors.length, dims: vectors[0]?.length });
    if (vectors.length === 2) {
      const dot = vectors[0].reduce((sum, value, index) => sum + value * vectors[1][index], 0);
      check("Portuguese query matches the English passage", dot > 0.5, { cosine: dot });
    }

    api.runEmbeddingAction("stop");
    const stopDeadline = Date.now() + 20000;
    while (Date.now() < stopDeadline) {
      state = api.getEmbeddingState();
      if (state.phase === "stopped") break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    check("embedding server stopped", state?.phase === "stopped", state);
    api.saveSettings(initial);
  } catch (error) {
    errors.push(String(error) + "\n" + (error.stack || ""));
    try { Zotero.ReaderLocalAI?.runEmbeddingAction("stop"); } catch { /* Best effort. */ }
    try { if (initial) Zotero.ReaderLocalAI?.saveSettings(initial); } catch { /* Best effort. */ }
  }
  const passed = checks.every(item => item.passed) && !errors.length;
  await IOUtils.writeUTF8(output, JSON.stringify({ passed, checks, errors }, null, 2));
  Zotero.debug("READER_LOCAL_AI_EMBEDDING: " + JSON.stringify({ passed, checks, errors }));
})();
