// Development-only native acceptance tests. Run with scripts/rdp.py --file.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow();
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const results = { zoteroVersion: Zotero.version, profile: "isolated", checks: [], errors: [] };
  const output = root + "/experiments/results/native-acceptance.json";
  const save = () => IOUtils.writeUTF8(output, JSON.stringify(results, null, 2));
  const check = (name, okay, detail = {}) => {
    results.checks.push({ name, passed: !!okay, ...detail });
    if (!okay) throw new Error(name);
  };
  const wait = async (predicate, label, timeout = 15000) => {
    const start = Date.now();
    while (!predicate()) { if (Date.now() - start > timeout) throw new Error("Timeout: " + label); await sleep(100); }
  };
  function doc(reader) { return reader._iframe.contentDocument; }
  function popup(reader) { return doc(reader)?.querySelector(".reader-local-ai-popup"); }
  function button(reader, label, within = popup(reader)) { return [...within.querySelectorAll("button")].find(b => b.textContent === label); }
  async function select(reader, edge = false) {
    const view = reader._internalReader._primaryView;
    await view.initializedPromise;
    const chars = view._pdfPages[0].chars.slice(0, 26);
    view._setSelectionRanges(Components.utils.cloneInto([{ collapsed: false, text: chars.map(c => c.u).join(""), sortIndex: "00000|000000|00000",
      position: { pageIndex: 0, rects: [[chars[0].rect[0], chars[0].rect[1], chars.at(-1).rect[2], chars[0].rect[3]]] } }], reader._iframe.contentWindow));
    if (edge) view._onSetSelectionPopup(Components.utils.cloneInto({ annotation: view._getAnnotationFromSelectionRanges(view._selectionRanges, "highlight"),
      rect: [doc(reader).defaultView.innerWidth - 15, doc(reader).defaultView.innerHeight - 30,
        doc(reader).defaultView.innerWidth - 5, doc(reader).defaultView.innerHeight - 10] }, reader._iframe.contentWindow));
    await sleep(200);
    await wait(() => doc(reader).querySelector(".reader-local-ai-actions"), "selection actions");
  }
  async function open(reader, explain = false) {
    popup(reader)?.querySelector(".reader-local-ai-close").click();
    await select(reader);
    const actions = doc(reader).querySelector(".reader-local-ai-actions");
    button(reader, explain ? "Explicar trecho" : "Fazer pergunta", actions).click();
    await wait(() => popup(reader), "AI popup");
  }
  function submit(reader, question) {
    const field = popup(reader).querySelector("textarea"); field.value = question;
    popup(reader).querySelector("form").requestSubmit();
  }
  async function complete(reader) {
    await wait(() => button(reader, "Continuar perguntando") && !button(reader, "Continuar perguntando").hidden, "final response");
  }
  async function expectError(reader, match) {
    await wait(() => popup(reader)?.querySelector(".reader-local-ai-error").textContent, "error");
    const text = popup(reader).querySelector(".reader-local-ai-error").textContent;
    check("legible error: " + match, text.toLowerCase().includes(match.toLowerCase()), { text });
  }
  async function screenshot(name, target = win) {
    const snapshot = await target.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null, 1, "white");
    const canvas = target.document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
    canvas.width = snapshot.width; canvas.height = snapshot.height;
    canvas.getContext("2d").drawImage(snapshot, 0, 0); snapshot.close();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/png"));
    await IOUtils.write(root + "/.runtime/" + name + ".png", new Uint8Array(await blob.arrayBuffer()));
  }
  const originalSettings = Zotero.ReaderLocalAI.getSettings();
  try {
    // The mock serves 2.6B only; persisted optional-model preferences are unrelated.
    Zotero.ReaderLocalAI.saveSettings({...originalSettings,baseUrl:"http://127.0.0.1:18080",model:"lfm2.5-2.6b",responseLanguage:"pt-BR",contextTokens:32768,generationTokens:4096});
    const settingsBefore = Zotero.ReaderLocalAI.getSettings();
    const pref = Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    await wait(() => pref.document.getElementById("reader-local-ai-baseUrl")?.value, "preferences loaded");
    check("native preference pane initializes", pref.document.getElementById("reader-local-ai-baseUrl").value === settingsBefore.baseUrl);
    const languageSelect = pref.document.getElementById("reader-local-ai-responseLanguage");
    check("native language selector offers Brazilian Portuguese and English", languageSelect.localName === "select" &&
      [...languageSelect.options].map(option=>option.value).join(",") === "pt-BR,en");
    check("native language selector initializes in Brazilian Portuguese", languageSelect.value === "pt-BR");
    languageSelect.value = "en";
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    check("native preferences save the English response preference", Zotero.ReaderLocalAI.getSettings().responseLanguage === "en");
    languageSelect.value = "pt-BR";
    const modelSelect = pref.document.getElementById("reader-local-ai-model");
    check("native model selector offers both models", modelSelect.localName === "select" &&
      [...modelSelect.options].map(option=>option.value).join(",") === "lfm2.5-2.6b,lfm2.5-8b-a1b");
    modelSelect.value = "lfm2.5-8b-a1b";
    modelSelect.dispatchEvent(new pref.Event("change",{bubbles:true}));
    check("larger model shows native launch controls and context limit",
      !!pref.document.getElementById("reader-local-ai-start-server") &&
      pref.document.getElementById("reader-local-ai-contextTokens").max === "128000");
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    check("native preference pane saves larger model", Zotero.ReaderLocalAI.getSettings().model === "lfm2.5-8b-a1b");
    modelSelect.value = settingsBefore.model;
    modelSelect.dispatchEvent(new pref.Event("change",{bubbles:true}));
    pref.document.getElementById("reader-local-ai-contextTokens").value = "16384";
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    check("native preference pane saves", Zotero.ReaderLocalAI.getSettings().contextTokens === 16384);
    pref.document.getElementById("reader-local-ai-baseUrl").value = "http://example.com";
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    check("native preference pane rejects remote endpoint", pref.document.getElementById("reader-local-ai-settings-status").textContent.includes("servidor local"));
    await screenshot("native-preferences-error",pref);
    Zotero.ReaderLocalAI.saveSettings(settingsBefore);
    pref.document.getElementById("reader-local-ai-baseUrl").value=settingsBefore.baseUrl;
    pref.document.getElementById("reader-local-ai-contextTokens").value=String(settingsBefore.contextTokens);
    pref.document.getElementById("reader-local-ai-preferences").requestSubmit();
    await screenshot("native-preferences",pref); pref.close();
    const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) || Zotero.Reader._readers.at(-1);
    const attachment = Zotero.Items.get(reader.itemID);
    const before = attachment.getAnnotations().length;
    Zotero.ReaderLocalAI.saveSettings({...settingsBefore, model:"lfm2.5-8b-a1b"});
    await open(reader); submit(reader, "Modelo escolhido ainda não carregado");
    await expectError(reader, "--model lfm2.5-8b-a1b");
    Zotero.ReaderLocalAI.saveSettings(settingsBefore);
    await open(reader);
    check("question field focused", doc(reader).activeElement === popup(reader).querySelector("textarea"));
    const field = popup(reader).querySelector("textarea");
    const keyboardWindow = reader._iframeWindow;
    const keyboard = Components.classes["@mozilla.org/text-input-processor;1"].createInstance(Components.interfaces.nsITextInputProcessor);
    if (!keyboard.beginInputTransactionForTests(keyboardWindow)) throw new Error("Keyboard transaction unavailable");
    field.value = "ABCDE"; field.setSelectionRange(5,5);
    keyboard.keydown(new keyboardWindow.KeyboardEvent("keydown",{key:"ArrowLeft",code:"ArrowLeft",keyCode:37}));
    keyboard.keyup(new keyboardWindow.KeyboardEvent("keyup",{key:"ArrowLeft",code:"ArrowLeft",keyCode:37}));
    check("arrow key edits question instead of moving reader focus", field.selectionStart === 4);
    keyboard.keydown(new keyboardWindow.KeyboardEvent("keydown",{key:"h",code:"KeyH",keyCode:72}));
    keyboard.keyup(new keyboardWindow.KeyboardEvent("keyup",{key:"h",code:"KeyH",keyCode:72}));
    check("typing does not switch annotation tools", field.value === "ABCDhE" && reader._internalReader._state.tool.type === "pointer");
    keyboard.keydown(new keyboardWindow.KeyboardEvent("keydown",{key:"Control",code:"ControlLeft",keyCode:17}));
    keyboard.keydown(new keyboardWindow.KeyboardEvent("keydown",{key:"a",code:"KeyA",keyCode:65,ctrlKey:true}));
    keyboard.keyup(new keyboardWindow.KeyboardEvent("keyup",{key:"a",code:"KeyA",keyCode:65,ctrlKey:true}));
    keyboard.keyup(new keyboardWindow.KeyboardEvent("keyup",{key:"Control",code:"ControlLeft",keyCode:17}));
    check("Ctrl+A selects question text", field.selectionStart === 0 && field.selectionEnd === field.value.length);
    field.value = "Explique a relação com o restante do artigo.";
    keyboard.keydown(new keyboardWindow.KeyboardEvent("keydown",{key:"Enter",code:"Enter",keyCode:13}));
    keyboard.keyup(new keyboardWindow.KeyboardEvent("keyup",{key:"Enter",code:"Enter",keyCode:13}));
    await complete(reader);
    check("Enter submits the question", !!popup(reader).querySelector(".reader-local-ai-answer"));
    check("final text streamed without reasoning", popup(reader).textContent.includes("A atenção calcula") && !popup(reader).textContent.includes("SECRET_REASONING"));
    await screenshot("native-popup-final");
    button(reader, "Continuar perguntando").click(); submit(reader, "Por que dividir pela raiz quadrada?");
    await complete(reader);
    check("continuation displays both turns", popup(reader).querySelectorAll(".reader-local-ai-turn").length === 2);
    let requests = await (await win.fetch("http://127.0.0.1:18080/requests")).json();
    check("follow-up preserves history and one article", requests.at(-1).messages.length === 4 && requests.at(-1).messages.filter(m=>m.content.includes("<artigo")).length === 1);
    const text = (await Zotero.PDFWorker.getFullText(reader.itemID, null)).text;
    check("entire native extracted paper sent", requests.at(-1).messages[1].content.includes(text), { chars: text.length, pages: 15 });
    button(reader, "Nova pergunta").click(); submit(reader, "Uma pergunta independente."); await complete(reader);
    requests = await (await win.fetch("http://127.0.0.1:18080/requests")).json();
    check("new question resets history", requests.at(-1).messages.length === 2 && popup(reader).querySelectorAll(".reader-local-ai-turn").length === 1);
    popup(reader).querySelector(".reader-local-ai-close").click();
    await open(reader, true); await complete(reader);
    check("generic explanation action works", popup(reader).querySelector(".reader-local-ai-question").textContent.includes("Explique"));
    requests = await (await win.fetch("http://127.0.0.1:18080/requests")).json();
    check("generic explanation sends Portuguese after the entire English article",
      requests.at(-1).messages[0].content.startsWith("Answer in Brazilian Portuguese") &&
      requests.at(-1).messages.at(-1).content.lastIndexOf("Answer in Brazilian Portuguese") > requests.at(-1).messages.at(-1).content.indexOf("</artigo>"));
    await open(reader); submit(reader, "UI_SLOW: aguarde");
    await wait(() => !button(reader, "Cancelar").hidden, "cancel button");
    await sleep(300); button(reader, "Cancelar").click(); await expectError(reader, "cancelado");
    await open(reader); submit(reader, "UI_INTERRUPTED"); await expectError(reader, "antes");
    await open(reader); submit(reader, "UI_LENGTH"); await expectError(reader, "limite");
    await win.fetch("http://127.0.0.1:18080/control", { method: "POST", body: JSON.stringify({tokens:30000}) });
    await open(reader); submit(reader, "Contexto excedido"); await expectError(reader, "não será cortado");
    await win.fetch("http://127.0.0.1:18080/control", { method: "POST", body: JSON.stringify({tokens:10000}) });
    const settings = Zotero.ReaderLocalAI.getSettings();
    Zotero.ReaderLocalAI.saveSettings({...settings, baseUrl:"http://127.0.0.1:18081"});
    await open(reader); submit(reader, "Servidor indisponível"); await expectError(reader, "conectar");
    Zotero.ReaderLocalAI.saveSettings(settings);
    await open(reader); popup(reader).querySelector(".reader-local-ai-close").click(); await select(reader, true);
    button(reader, "Fazer pergunta", doc(reader).querySelector(".reader-local-ai-actions")).click(); await sleep(300);
    const r = popup(reader).getBoundingClientRect(); const w = doc(reader).defaultView;
    check("popup clamped to viewport edges", r.left >= 0 && r.top >= 0 && r.right <= w.innerWidth + 1 && r.bottom <= w.innerHeight + 1, {bounds:r.toJSON(),viewport:[w.innerWidth,w.innerHeight]});
    await screenshot("native-popup-question-edge");
    popup(reader).querySelector("textarea").dispatchEvent(new w.KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
    check("Escape closes popup", !popup(reader));
    reader._internalReader.zoomIn(); await sleep(300);
    await open(reader); submit(reader, "Pergunta após zoom"); await complete(reader);
    check("popup works after zoom", !!popup(reader).querySelector(".reader-local-ai-answer"));
    reader._internalReader.zoomReset();
    await open(reader); submit(reader, "UI_SLOW: teste entre abas");
    await wait(() => popup(reader).querySelector(".reader-local-ai-status").textContent.includes("explicação"), "stream started");
    const other = await Zotero.Reader.open(reader.itemID, null, {allowDuplicate:true});
    await other._initPromise; await wait(() => other._internalReader._primaryView._pdfPages[0], "second PDF tab");
    await open(other); submit(other, "Pergunta na segunda aba"); await expectError(other, "andamento");
    check("multiple PDF tabs have separate popups", !!popup(reader) && !!popup(other));
    button(reader,"Cancelar").click(); await expectError(reader,"cancelado");
    submit(other, "Pergunta na segunda aba após cancelamento"); await complete(other);
    check("other tab can generate after cancellation", !!popup(other).querySelector(".reader-local-ai-answer"));
    await open(other); submit(other, "UI_SLOW: fechar leitor");
    await wait(() => !button(other,"Cancelar").hidden, "second pending request");
    other.close(); await sleep(400);
    check("closing reader removes popup", !popup(other));
    win.Zotero_Tabs.select(reader.tabID); await sleep(200);
    check("no mandatory annotation created", before === attachment.getAnnotations().length);
    await open(reader); submit(reader, "UI_SLOW: desativar plugin");
    await wait(() => !button(reader,"Cancelar").hidden,"pending on disable");
    const manager = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;
    const addon = await manager.getAddonByID("reader-local-ai@local.invalid");
    await addon.disable(); await wait(() => !Zotero.ReaderLocalAI,"plugin shutdown");
    check("disable removes popups actions and styles", Zotero.Reader._readers.every(r=>!doc(r)?.querySelector("[data-reader-local-ai],#reader-local-ai-style")));
    check("disable removes preference pane", !Zotero.PreferencePanes.pluginPanes.some(p=>p.pluginID===addon.id));
    await addon.enable(); await wait(() => !!Zotero.ReaderLocalAI,"plugin enabled again");
    check("plugin can be re-enabled", addon.isActive);
    await save();
  } catch (error) {
    results.errors.push({message:String(error),stack:error.stack}); await save(); Zotero.debug("READER_LOCAL_AI_UI_ERROR: " + error + "\n" + error.stack);
  } finally {
    if (Zotero.ReaderLocalAI) Zotero.ReaderLocalAI.saveSettings(originalSettings);
  }
})();
