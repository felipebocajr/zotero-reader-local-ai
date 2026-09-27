// Check the release XPI and saved Markdown after restarting the isolated profile.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const output = root + "/experiments/results/native-markdown.json";
  const results = JSON.parse(await IOUtils.readUTF8(output));
  const win = Zotero.getMainWindow(), sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const wait = async (predicate, label) => {
    const started = Date.now();
    while (!predicate()) { if (Date.now() - started > 15000) throw new Error("Timeout: " + label); await sleep(100); }
  };
  const check = (name, passed) => { results.checks.push({ name: "restart: " + name, passed: !!passed }); if (!passed) throw new Error(name); };
  try {
    await Zotero.uiReadyPromise;
    if (results.errors.length || results.saved.length !== 1) throw new Error("Complete Markdown test must pass first");
    const record = results.saved[0], attachment = Zotero.Items.get(Zotero.Prefs.get("extensions.reader-local-ai.devAttachmentID", true));
    const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, record.key);
    check("saved comment keeps exact Markdown and LaTeX source", item?.annotationComment === record.comment && !/<h2|<math|<strong/.test(item.annotationComment));
    const reader = await Zotero.Reader.open(attachment.id); await reader._initPromise;
    if (!reader._internalReader._state.sidebarOpen) reader._iframe.contentDocument.querySelector(".sidebar-toggle").click();
    reader._internalReader.setSidebarView("annotations");
    const row = () => reader._iframe.contentDocument.querySelector(`[data-sidebar-annotation-id="${record.key}"]`);
    await wait(() => row()?.querySelector(".reader-local-ai-annotation-math h2"), "Markdown preview after restart");
    check("saved Markdown and MathML render in release XPI", !!row().querySelector(".reader-local-ai-annotation-math strong") && !!row().querySelector(".reader-local-ai-annotation-math math mfrac"));
    check("native editor still contains only source", row().querySelector(".comment .content").innerText === record.comment && !row().querySelector(".comment .content h2, .comment .content math"));
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addon = await AddonManager.getAddonByID("reader-local-ai@local.invalid");
    check("distribution XPI active after restart", addon?.isActive && !!Zotero.ReaderLocalAI);
  } catch (error) { results.errors.push({ message: String(error), stack: error.stack }); }
  await IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
})();
