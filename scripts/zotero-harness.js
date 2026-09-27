// Only inserted into the development XPI by setup_dev.py; never shipped in dist.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const log = message => Zotero.debug("READER_LOCAL_AI_HARNESS: " + message);
  try {
    await Zotero.uiReadyPromise;
    if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Refusing to test outside the isolated library");
    log("isolated profile verified; plugin loaded");
    let attachment = Zotero.Items.get(Zotero.Prefs.get("extensions.reader-local-ai.devAttachmentID", true) || 0);
    if (!attachment) {
      attachment = await Zotero.Attachments.importFromFile({ file: root + "/experiments/data/attention.pdf" });
      Zotero.Prefs.set("extensions.reader-local-ai.devAttachmentID", attachment.id, true);
    }
    log("imported test PDF " + attachment.id);
    const reader = await Zotero.Reader.open(attachment.id);
    await reader._initPromise;
    log("reader opened; internal keys " + Object.keys(reader._internalReader).join(","));
    const result = await Zotero.PDFWorker.getFullText(attachment.id, null);
    log("PDF extraction " + JSON.stringify({ pages: result.extractedPages, total: result.totalPages, chars: result.text.length }));
    const win = Zotero.getMainWindow();
    win.document.title = "Zotero — Reader Local AI Development";
    await IOUtils.writeUTF8(root + "/.runtime/zotero-harness-initial.json", JSON.stringify({ attachmentId: attachment.id, pages: result.extractedPages, total: result.totalPages, chars: result.text.length }, null, 2));
  } catch (error) { log("ERROR " + error + "\n" + error.stack); }
})();
