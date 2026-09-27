// Native end-to-end validation against the real 8B-A1B runtime on port 18091.
// Run only after the mock UI suite finishes, with scripts/rdp.py --file.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow();
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const output = root + "/experiments/results/native-lfm8b.json";
  const results = { zoteroVersion: Zotero.version, profile: "isolated", model: "lfm2.5-8b-a1b", checks: [], answers: [], errors: [] };
  const original = Zotero.ReaderLocalAI.getSettings();
  let pref, reader;
  const check = (name, passed) => { results.checks.push({name, passed:!!passed}); if (!passed) throw new Error(name); };
  const wait = async (predicate, label, timeout = 120000) => {
    const started = Date.now();
    while (!predicate()) { if (Date.now() - started > timeout) throw new Error("Timeout: " + label); await sleep(100); }
  };
  const doc = () => reader._iframe.contentDocument;
  const popup = () => doc().querySelector(".reader-local-ai-popup");
  const button = label => [...popup().querySelectorAll("button")].find(button => button.textContent === label);
  async function snapshot(target, name) {
    const bitmap = await target.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = target.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(root + "/.runtime/" + name + ".png", new Uint8Array(await blob.arrayBuffer()));
  }
  async function ask(question, followup = false) {
    if (followup) button("Continuar perguntando").click();
    popup().querySelector("textarea").value = question;
    const started = Date.now();
    popup().querySelector("form").requestSubmit();
    await wait(() => !button("Continuar perguntando").hidden || popup().querySelector(".reader-local-ai-error").textContent, "real model response");
    const error = popup().querySelector(".reader-local-ai-error").textContent;
    if (error) throw new Error(error);
    const answer = popup().querySelectorAll(".reader-local-ai-answer")[followup ? 1 : 0].textContent;
    results.answers.push({question, answer, totalMs: Date.now() - started});
    check(followup ? "real larger-model continuation completes" : "real larger-model answer completes", answer.trim().length > 0 && !answer.includes("<think>"));
  }
  try {
    const models = await (await win.fetch("http://127.0.0.1:18091/v1/models")).json();
    check("real runtime exposes the selected alias", models.data.some(model => model.id === results.model));
    pref = Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    await wait(() => pref.document.getElementById("reader-local-ai-model")?.options.length === 2, "model preferences loaded", 15000);
    pref.document.getElementById("reader-local-ai-baseUrl").value = "http://127.0.0.1:18091";
    const select = pref.document.getElementById("reader-local-ai-model");
    select.value = results.model; select.dispatchEvent(new pref.Event("change", {bubbles:true}));
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    check("native preferences activate the larger model", Zotero.ReaderLocalAI.getSettings().model === results.model);
    await snapshot(pref, "native-model-preferences"); pref.close(); pref = null;
    pref = Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    await wait(() => pref.document.getElementById("reader-local-ai-model")?.options.length === 2, "preferences reopened", 15000);
    check("model choice survives reopening preferences", pref.document.getElementById("reader-local-ai-model").value === results.model);
    pref.close(); pref = null;
    reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) || Zotero.Reader._readers.at(-1);
    const attachment = Zotero.Items.get(reader.itemID), annotationCount = attachment.getAnnotations().length;
    popup()?.querySelector(".reader-local-ai-close").click();
    const view = reader._internalReader._primaryView;
    await view.initializedPromise;
    const chars = view._pdfPages[0].chars.slice(0, 26);
    view._setSelectionRanges(Components.utils.cloneInto([{collapsed:false, text:chars.map(char=>char.u).join(""), sortIndex:"00000|000000|00000",
      position:{pageIndex:0,rects:[[chars[0].rect[0],chars[0].rect[1],chars.at(-1).rect[2],chars[0].rect[3]]]}}], reader._iframe.contentWindow));
    await wait(() => doc().querySelector(".reader-local-ai-actions"), "selection actions", 15000);
    [...doc().querySelector(".reader-local-ai-actions").querySelectorAll("button")].find(button=>button.textContent === "Fazer pergunta").click();
    await wait(popup, "question popup", 15000);
    await ask("Explique a atenção por produto escalar escalonado descrita neste artigo.");
    await ask("Por que dividir os produtos escalares pela raiz quadrada da dimensão das chaves?", true);
    check("larger-model popup preserves its two completed turns", popup().querySelectorAll(".reader-local-ai-turn").length === 2);
    check("each larger-model answer offers optional annotation saving", popup().querySelectorAll(".reader-local-ai-save-answer").length === 2);
    check("larger-model answers create no annotations automatically", attachment.getAnnotations().length === annotationCount);
    await snapshot(win, "native-lfm8b-popup");
  } catch (error) {
    results.errors.push({message:String(error), stack:error.stack});
  } finally {
    pref?.close(); if (reader) popup()?.querySelector(".reader-local-ai-close").click();
    Zotero.ReaderLocalAI.saveSettings(original);
    await IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
  }
})();
