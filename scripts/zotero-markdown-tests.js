// Native Markdown/MathML rendering and annotation source, isolated profile only.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow(), sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const result = { zoteroVersion: Zotero.version, profile: "isolated", checks: [], errors: [], saved: [] };
  const output = root + "/experiments/results/native-markdown.json";
  const original = Zotero.ReaderLocalAI.getSettings();
  let reader;
  const check = (name, passed) => { result.checks.push({ name, passed: !!passed }); if (!passed) throw new Error(name); };
  const wait = async (predicate, label, timeout = 15000) => {
    const started = Date.now();
    while (!predicate()) { if (Date.now() - started > timeout) throw new Error("Timeout: " + label); await sleep(50); }
  };
  const doc = () => reader._iframe.contentDocument;
  const popup = () => doc().querySelector(".reader-local-ai-popup");
  const answer = index => popup().querySelectorAll(".reader-local-ai-answer")[index];
  const button = label => [...popup().querySelectorAll("button")].find(node => node.textContent === label);
  const complete = () => wait(() => !button("Continuar perguntando").hidden, "complete Markdown answer");
  const submit = question => { popup().querySelector("textarea").value = question; popup().querySelector("form").requestSubmit(); };
  async function screenshot(name) {
    const bitmap = await win.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = win.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0); bitmap.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(root + "/.runtime/" + name + ".png", new Uint8Array(await blob.arrayBuffer()));
  }
  try {
    Zotero.ReaderLocalAI.saveSettings({ ...original, baseUrl: "http://127.0.0.1:18080", model: "lfm2.5-2.6b" });
    await win.fetch("http://127.0.0.1:18080/control", { method: "POST", body: JSON.stringify({ tokens: 10000, math: false }) });
    const id = Zotero.Prefs.get("extensions.reader-local-ai.devAttachmentID", true);
    reader = await Zotero.Reader.open(id); await reader._initPromise;
    const view = reader._internalReader._primaryView;
    await wait(() => view._pdfPages[0], "test PDF ready");
    const attachment = Zotero.Items.get(id), before = attachment.getAnnotations();
    const previous = new Map(before.map(item => [item.id, item.annotationComment]));
    const chars = view._pdfPages[0].chars.slice(0, 26);
    view._setSelectionRanges(Components.utils.cloneInto([{ collapsed: false, text: chars.map(char => char.u).join(""), sortIndex: "00000|000000|00000",
      position: { pageIndex: 0, rects: [[chars[0].rect[0], chars[0].rect[1], chars.at(-1).rect[2], chars[0].rect[3]]] } }], reader._iframe.contentWindow));
    await wait(() => doc().querySelector(".reader-local-ai-actions"), "selection actions");
    [...doc().querySelector(".reader-local-ai-actions").querySelectorAll("button")].find(node => node.textContent === "Fazer pergunta").click();
    await wait(popup, "AI popup");
    const question = "UI_MARKDOWN: explique o trecho com formatação.";
    submit(question);
    await wait(() => answer(0)?.querySelector("h2") && answer(0)?.querySelector("strong"), "streaming Markdown");
    check("heading and bold render during streaming", !!answer(0).querySelector("h2") && !!answer(0).querySelector("strong") && !button("Cancelar").hidden);
    await complete();
    const source = answer(0).dataset.readerLocalAiSource;
    check("headings, bold, italic and list render as HTML elements", ["h2", "strong", "em", "ul li"].every(selector => answer(0).querySelector(selector)) &&
      answer(0).querySelectorAll("ul li").length === 2 && !answer(0).textContent.includes("## Explicação") && !answer(0).textContent.includes("**atenção**"));
    check("LaTeX remains MathML alongside Markdown", !!answer(0).querySelector("math mfrac") && !!answer(0).querySelector("math msqrt"));
    check("code keeps its literal asterisks", answer(0).querySelector("code").textContent === "**literal**");
    check("unsafe HTML and remote image never become elements", !answer(0).querySelector("img,script,iframe,a"));
    check("original Markdown and LaTeX stay available", source.includes("## Explicação contextual") && source.includes("**atenção**") && source.includes(String.raw`\frac{QK`));
    await screenshot("native-markdown-popup");
    button("Continuar perguntando").click(); submit("UI_MARKDOWN: continue explicando."); await complete();
    check("follow-up renders both answers", popup().querySelectorAll(".reader-local-ai-answer h2").length === 2);
    popup().querySelectorAll(".reader-local-ai-save-answer")[1].click();
    await wait(() => popup().querySelectorAll(".reader-local-ai-save-answer")[1].textContent === "Salvo nas anotações", "answer saved");
    const added = attachment.getAnnotations().filter(item => !previous.has(item.id));
    check("only chosen follow-up is saved", added.length === 1);
    const item = added[0], comment = item.annotationComment;
    check("saved comment retains Markdown source and no generated markup", comment === "Resposta da IA\n\nPergunta: UI_MARKDOWN: continue explicando.\n\n" + source && !/<h2|<math|<strong/.test(comment));
    result.saved.push({ key: item.key, id: item.id, comment });
    if (!reader._internalReader._state.sidebarOpen) doc().querySelector(".sidebar-toggle").click();
    reader._internalReader.setSidebarView("annotations");
    const row = () => doc().querySelector(`[data-sidebar-annotation-id="${item.key}"]`);
    await wait(() => row()?.querySelector(".reader-local-ai-annotation-math h2"), "formatted annotation preview");
    check("annotation tab formats heading, bold and MathML", !!row().querySelector(".reader-local-ai-annotation-math strong") && !!row().querySelector(".reader-local-ai-annotation-math math mfrac"));
    check("native annotation editor retains the original source", row().querySelector(".comment .content").innerText === comment && !row().querySelector(".comment .content h2, .comment .content math"));
    await screenshot("native-markdown-annotation");
    const editor = row().querySelector(".comment .content"); row().querySelector(".comment").click();
    await wait(() => editor.isContentEditable, "native editor"); editor.focus();
    check("editing shows source instead of preview", doc().defaultView.getComputedStyle(row().querySelector(".reader-local-ai-annotation-math")).display === "none");
    check("prior annotations unchanged", [...previous].every(([id, text]) => Zotero.Items.get(id)?.annotationComment === text));
  } catch (error) { result.errors.push({ message: String(error), stack: error.stack }); }
  finally {
    if (reader) popup()?.querySelector(".reader-local-ai-close").click();
    if (Zotero.ReaderLocalAI) Zotero.ReaderLocalAI.saveSettings(original);
    await IOUtils.writeUTF8(output, JSON.stringify(result, null, 2));
  }
})();
