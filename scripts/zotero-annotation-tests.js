// Native persistence tests, with the loopback fixture and isolated development profile.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  if (dataDir !== base + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow();
  const initialSettings = Zotero.ReaderLocalAI.getSettings();
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const results = { zoteroVersion: Zotero.version, profile: "isolated", checks: [], errors: [], saved: [] };
  const output = base + "/experiments/results/native-annotations.json";
  const write = () => IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
  const check = (name, passed, detail = {}) => {
    results.checks.push({ name, passed: !!passed, ...detail });
    if (!passed) throw new Error(name);
  };
  const wait = async (predicate, label, timeout = 15000) => {
    const start = Date.now();
    while (!predicate()) { if (Date.now() - start > timeout) throw new Error("Timeout: " + label); await sleep(50); }
  };
  const documentOf = reader => reader._iframe.contentDocument;
  const popup = reader => documentOf(reader)?.querySelector(".reader-local-ai-popup");
  const button = (reader, label) => [...popup(reader).querySelectorAll("button")].find(node => node.textContent === label);
  const saveButton = (reader, index) => popup(reader).querySelectorAll(".reader-local-ai-turn")[index]?.querySelector(".reader-local-ai-save-answer");
  async function open(reader) {
    popup(reader)?.querySelector(".reader-local-ai-close").click();
    const view = reader._internalReader._primaryView;
    await view.initializedPromise;
    const chars = view._pdfPages[0].chars.slice(0, 26);
    view._setSelectionRanges(Components.utils.cloneInto([{ collapsed: false, text: chars.map(c => c.u).join(""), sortIndex: "00000|000000|00000",
      position: { pageIndex: 0, rects: [[chars[0].rect[0], chars[0].rect[1], chars.at(-1).rect[2], chars[0].rect[3]]] } }], reader._iframe.contentWindow));
    await wait(() => documentOf(reader).querySelector(".reader-local-ai-actions"), "selection actions");
    const actions = documentOf(reader).querySelector(".reader-local-ai-actions");
    [...actions.querySelectorAll("button")].find(node => node.textContent === "Fazer pergunta").click();
    await wait(() => popup(reader), "AI popup");
  }
  function submit(reader, question) {
    popup(reader).querySelector("textarea").value = question;
    popup(reader).querySelector("form").requestSubmit();
  }
  const complete = reader => wait(() => button(reader, "Continuar perguntando") && !button(reader, "Continuar perguntando").hidden, "complete answer");
  async function saved(reader, index) {
    await wait(() => saveButton(reader, index)?.textContent === "Salvo nas anotações", "annotation saved");
  }
  async function screenshot(reader) {
    const snapshot = await win.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = snapshot.width; canvas.height = snapshot.height;
    canvas.getContext("2d").drawImage(snapshot, 0, 0); snapshot.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(base + "/.runtime/native-annotations-popup.png", new Uint8Array(await blob.arrayBuffer()));
  }
  let restoreEditable, restoreSave;
  try {
    // The fixture serves 2.6B only; another native test may have left 8B selected.
    Zotero.ReaderLocalAI.saveSettings({ ...initialSettings, baseUrl: "http://127.0.0.1:18080", model: "lfm2.5-8b-a1b", retrievalMode: "full", contextTokens: 32768, generationTokens: 4096 });
    await win.fetch("http://127.0.0.1:18080/control", { method: "POST", body: JSON.stringify({ tokens: 10000, math: false }) });
    const attachmentId = Zotero.Prefs.get("extensions.reader-local-ai.devAttachmentID", true);
    let reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID);
    if (!reader || reader.itemID !== attachmentId) reader = await Zotero.Reader.open(attachmentId);
    await reader._initPromise;
    await wait(() => reader._internalReader._primaryView._pdfPages[0], "PDF page loaded");
    const attachment = Zotero.Items.get(attachmentId);
    const before = attachment.getAnnotations();
    const beforeValues = new Map(before.map(item => [item.id, item.annotationComment]));
    const beforeIDs = new Set(before.map(item => item.id));
    const added = () => attachment.getAnnotations().filter(item => !beforeIDs.has(item.id));
    await open(reader);
    submit(reader, "UI_SLOW: Primeira pergunta para salvar.");
    await wait(() => popup(reader).querySelector(".reader-local-ai-answer"), "streaming draft");
    check("streaming draft has no save action", !saveButton(reader, 0));
    await complete(reader);
    check("no annotation saved automatically", added().length === 0);
    const first = { question: popup(reader).querySelector(".reader-local-ai-question").textContent,
      answer: popup(reader).querySelector(".reader-local-ai-answer").dataset.readerLocalAiSource,
      selection: popup(reader).querySelector("blockquote").textContent };
    button(reader, "Continuar perguntando").click(); submit(reader, "Segunda pergunta da conversa."); await complete(reader);
    const second = { question: popup(reader).querySelectorAll(".reader-local-ai-question")[1].textContent,
      answer: popup(reader).querySelectorAll(".reader-local-ai-answer")[1].dataset.readerLocalAiSource };
    check("each completed answer has its own save action", popup(reader).querySelectorAll(".reader-local-ai-save-answer").length === 2);
    const click = saveButton(reader, 0); click.click(); click.click(); await saved(reader, 0); await sleep(200);
    check("duplicate click saves exactly one conversation annotation", added().length === 1 &&
      saveButton(reader, 0).disabled && saveButton(reader, 1).disabled);
    const firstItem = added()[0];
    const expectedComment = `Conversa da IA\n\n### Você\n${first.question}\n\n### Assistente\n${first.answer}\n\n### Você\n${second.question}\n\n### Assistente\n${second.answer}`;
    check("the whole conversation is saved in order", firstItem.annotationComment === expectedComment);
    check("annotation belongs to selected PDF and preserves quote", firstItem.parentID === reader.itemID && firstItem.annotationType === "highlight" && firstItem.annotationText === first.selection);
    check("annotation contains no hidden reasoning", !firstItem.annotationComment.includes("SECRET_REASONING"));
    const native = reader._internalReader;
    await wait(() => native._state.annotations.some(annotation => annotation.id === firstItem.key), "native reader notification");
    const position = JSON.parse(firstItem.annotationPosition);
    check("native PDF coordinates preserved", position.pageIndex === 0 && position.rects.length > 0);
    restoreEditable = attachment.isEditable;
    attachment.isEditable = () => false;
    button(reader, "Nova pergunta").click(); submit(reader, "Terceira pergunta em uma conversa nova."); await complete(reader);
    saveButton(reader, 0).click();
    await wait(() => popup(reader).querySelector(".reader-local-ai-save-error"), "readonly save error");
    check("readonly error is legible and does not create annotation", popup(reader).querySelector(".reader-local-ai-save-error").textContent.includes("sem permissão") && added().length === 1);
    attachment.isEditable = restoreEditable; restoreEditable = null;
    saveButton(reader, 0).focus();
    const keyboardWindow = reader._iframeWindow;
    const keyboard = Components.classes["@mozilla.org/text-input-processor;1"].createInstance(Components.interfaces.nsITextInputProcessor);
    if (!keyboard.beginInputTransactionForTests(keyboardWindow)) throw new Error("Keyboard transaction unavailable");
    keyboard.keydown(new keyboardWindow.KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13 }));
    keyboard.keyup(new keyboardWindow.KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13 }));
    await saved(reader, 0);
    check("save action works with trusted keyboard Enter", saveButton(reader, 0).disabled);
    check("second conversation saves its own snapshot", added().length === 2 &&
      added().some(item => item.annotationComment.includes("Terceira pergunta") && !item.annotationComment.includes("Primeira pergunta")));
    button(reader, "Nova pergunta").click(); submit(reader, "Quarta pergunta após reiniciar a conversa."); await complete(reader);
    check("new question has independent unsaved answer", popup(reader).querySelectorAll(".reader-local-ai-turn").length === 1 && saveButton(reader, 0).textContent === "Salvar nas anotações");
    restoreSave = Zotero.Annotations.saveFromJSON;
    Zotero.Annotations.saveFromJSON = async () => { throw new Error("Controlled annotation write failure"); };
    saveButton(reader, 0).click(); await wait(() => popup(reader).querySelector(".reader-local-ai-save-error"), "save failure");
    check("write failure keeps answer and allows retry", added().length === 2 && !saveButton(reader, 0).disabled && !!popup(reader).querySelector(".reader-local-ai-answer").textContent);
    Zotero.Annotations.saveFromJSON = restoreSave; restoreSave = null;
    saveButton(reader, 0).click(); await saved(reader, 0);
    check("write retry saves only once", added().length === 3 && !popup(reader).querySelector(".reader-local-ai-save-error"));
    for (const item of added()) results.saved.push({ key: item.key, id: item.id, parentID: item.parentID, text: item.annotationText, comment: item.annotationComment });
    popup(reader).querySelector(".reader-local-ai-close").click();
    if (!native._state.sidebarOpen) documentOf(reader).querySelector(".sidebar-toggle").click();
    native.setSidebarView("annotations");
    await wait(() => documentOf(reader).querySelector(`[data-sidebar-annotation-id="${firstItem.key}"]`), "annotation tab displays saved conversation");
    const sidebarItem = documentOf(reader).querySelector(`[data-sidebar-annotation-id="${firstItem.key}"]`);
    check("saved conversation appears in native annotations tab", sidebarItem.textContent.includes(first.answer) &&
      sidebarItem.textContent.includes(second.answer) && sidebarItem.textContent.includes("Você") &&
      sidebarItem.textContent.includes("Assistente") && !sidebarItem.textContent.includes("Continuar perguntando"));
    await open(reader); submit(reader, "Pergunta ainda não salva."); await complete(reader);
    check("new popup does not inherit saved conversation", saveButton(reader, 0).textContent === "Salvar nas anotações" && popup(reader).querySelectorAll(".reader-local-ai-turn").length === 1);
    await screenshot(reader);
    popup(reader).querySelector(".reader-local-ai-close").click();
    reader.close(); await sleep(200);
    reader = await Zotero.Reader.open(attachmentId); await reader._initPromise;
    await wait(() => reader._internalReader._state.annotations.some(annotation => annotation.id === firstItem.key), "reopened reader annotations");
    check("saved annotation survives popup and reader close", added().length === 3);
    check("pre-existing annotations preserved", [...beforeValues].every(([id, comment]) => Zotero.Items.get(id)?.annotationComment === comment));
    await write();
  } catch (error) {
    results.errors.push({ message: String(error), stack: error.stack }); await write(); Zotero.logError(error);
  } finally {
    if (restoreEditable) Zotero.Items.get(Zotero.Prefs.get("extensions.reader-local-ai.devAttachmentID", true)).isEditable = restoreEditable;
    if (restoreSave) Zotero.Annotations.saveFromJSON = restoreSave;
    if (Zotero.ReaderLocalAI) Zotero.ReaderLocalAI.saveSettings(initialSettings);
  }
})();
