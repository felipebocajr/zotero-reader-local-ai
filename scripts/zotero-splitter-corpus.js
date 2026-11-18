// Extracts real Zotero PDFWorker text from the isolated library for splitter tests.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const outDir = base + "/.runtime/zotero-splitter-corpus";
  const names = ["attention", "rmsnorm", "rope", "lora", "llada", "fastdllm", "flashattention4"];
  try {
    await Zotero.uiReadyPromise;
    if (dataDir !== base + "/.runtime/zotero-data") throw new Error("Refusing to test outside the isolated library");
    await IOUtils.makeDirectory(outDir, { ignoreExisting: true, createAncestors: true });
    const results = [];
    for (const name of names) {
      const pdf = base + "/experiments/data/" + name + ".pdf";
      if (!(await IOUtils.exists(pdf))) {
        results.push({ name, skipped: "missing pdf" });
        continue;
      }
      const pref = "extensions.reader-local-ai.splitterAttachment." + name;
      let attachment = Zotero.Items.get(Zotero.Prefs.get(pref, true) || 0);
      if (!attachment || typeof attachment.isPDFAttachment !== "function" || !attachment.isPDFAttachment()) {
        attachment = await Zotero.Attachments.importFromFile({ file: pdf });
        Zotero.Prefs.set(pref, attachment.id, true);
      }
      const result = await Zotero.PDFWorker.getFullText(attachment.id, null);
      await IOUtils.writeUTF8(outDir + "/" + name + ".txt", result.text);
      results.push({
        name,
        pages: result.extractedPages,
        totalPages: result.totalPages,
        chars: result.text.length,
        lines: result.text.split(/\r?\n/).length,
        formFeeds: (result.text.match(/\f/g) || []).length,
      });
    }
    await IOUtils.writeUTF8(outDir + "/manifest.json", JSON.stringify({ dataDir, results }, null, 2));
  } catch (error) {
    await IOUtils.writeUTF8(base + "/.runtime/zotero-splitter-error.txt", String(error) + "\n" + (error.stack || ""));
  }
})();
