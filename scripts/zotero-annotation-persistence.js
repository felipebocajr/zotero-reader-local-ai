// Run after closing/restarting the isolated Zotero and installing the release XPI.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const output = root + "/experiments/results/native-annotations.json";
  const results = JSON.parse(await IOUtils.readUTF8(output));
  const win = Zotero.getMainWindow();
  const wait = async (predicate, label) => {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > 15000) throw new Error("Timeout: " + label);
      await new Promise(resolve => win.setTimeout(resolve, 100));
    }
  };
  const check = (name, passed) => {
    results.checks.push({ name: "restart: " + name, passed: !!passed });
    if (!passed) throw new Error(name);
  };
  try {
    await Zotero.uiReadyPromise;
    if (results.errors.length || results.saved.length !== 3) throw new Error("Complete annotation tests must pass first");
    const attachment = await Zotero.Items.getAsync(results.saved[0].parentID);
    check("saved annotations retain exact selected content", results.saved.every(record => {
      const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, record.key);
      return item?.parentID === attachment.id && item.annotationText === record.text && item.annotationComment === record.comment;
    }));
    const reader = await Zotero.Reader.open(attachment.id); await reader._initPromise;
    const internal = reader._internalReader;
    await wait(() => results.saved.every(record => internal._state.annotations.some(annotation => annotation.id === record.key)), "reader annotations after restart");
    if (!internal._state.sidebarOpen) reader._iframe.contentDocument.querySelector(".sidebar-toggle").click();
    internal.setSidebarView("annotations");
    await wait(() => results.saved.every(record => reader._iframe.contentDocument.querySelector(`[data-sidebar-annotation-id="${record.key}"]`)), "native annotation tab after restart");
    check("native annotations tab displays responses after restart", results.saved.every(record => reader._iframe.contentDocument.querySelector(`[data-sidebar-annotation-id="${record.key}"]`).textContent.includes("Resposta da IA")));
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID("reader-local-ai@local.invalid");
    check("distribution XPI active after restart", addon?.isActive && !!Zotero.ReaderLocalAI);
  } catch (error) {
    results.errors.push({ message: String(error), stack: error.stack }); Zotero.logError(error);
  }
  await IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
})();
