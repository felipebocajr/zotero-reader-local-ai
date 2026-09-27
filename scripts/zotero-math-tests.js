// Native MathML, streaming, annotation editing and cleanup in the isolated profile.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow(), sleep = ms => new Promise(resolve=>win.setTimeout(resolve,ms));
  const result = { zoteroVersion:Zotero.version, profile:"isolated", checks:[], errors:[], saved:[] };
  const output = root + "/experiments/results/native-math.json";
  const original = Zotero.ReaderLocalAI.getSettings();
  let reader;
  const check = (name, passed, detail={}) => { result.checks.push({name,passed:!!passed,...detail}); if (!passed) throw new Error(name); };
  const wait = async (predicate,label) => {
    const started=Date.now(); while (!predicate()) { if(Date.now()-started>15000)throw new Error("Timeout: "+label); await sleep(50); }
  };
  const doc = () => reader._iframe.contentDocument;
  const popup = () => doc().querySelector(".reader-local-ai-popup");
  const button = label => [...popup().querySelectorAll("button")].find(node=>node.textContent===label);
  const complete = () => wait(()=>!button("Continuar perguntando").hidden,"complete answer");
  const answer = index => popup().querySelectorAll(".reader-local-ai-answer")[index];
  async function open() {
    popup()?.querySelector(".reader-local-ai-close").click();
    const view=reader._internalReader._primaryView; await view.initializedPromise;
    const chars=view._pdfPages[0].chars.slice(0,26);
    view._setSelectionRanges(Components.utils.cloneInto([{collapsed:false,text:chars.map(c=>c.u).join(""),sortIndex:"00000|000000|00000",
      position:{pageIndex:0,rects:[[chars[0].rect[0],chars[0].rect[1],chars.at(-1).rect[2],chars[0].rect[3]]]}}],reader._iframe.contentWindow));
    await wait(()=>doc().querySelector(".reader-local-ai-actions"),"selection actions");
    [...doc().querySelector(".reader-local-ai-actions").querySelectorAll("button")].find(node=>node.textContent==="Fazer pergunta").click();
    await wait(popup,"AI popup");
  }
  function submit(question) { popup().querySelector("textarea").value=question; popup().querySelector("form").requestSubmit(); }
  async function screenshot(name) {
    const bitmap=await win.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null,1,"white");
    const canvas=win.document.createElementNS("http://www.w3.org/1999/xhtml","canvas"); canvas.width=bitmap.width;canvas.height=bitmap.height;
    canvas.getContext("2d").drawImage(bitmap,0,0); bitmap.close();
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
    await IOUtils.write(root+"/.runtime/"+name+".png",new Uint8Array(await blob.arrayBuffer()));
  }
  try {
    Zotero.ReaderLocalAI.saveSettings({...original,baseUrl:"http://127.0.0.1:18080",model:"lfm2.5-2.6b"});
    await win.fetch("http://127.0.0.1:18080/control",{method:"POST",body:JSON.stringify({tokens:10000,math:true})});
    const id=Zotero.Prefs.get("extensions.reader-local-ai.devAttachmentID",true);
    reader=await Zotero.Reader.open(id);await reader._initPromise;
    await wait(()=>reader._internalReader._primaryView._pdfPages[0],"PDF ready");
    const attachment=Zotero.Items.get(id), before=attachment.getAnnotations();
    const prior=new Map(before.map(item=>[item.id,item.annotationComment]));
    await open(); submit("Explique a fórmula da distribuição condicional.");
    await wait(()=>answer(0)?.querySelector("math"),"streaming MathML");
    check("completed formula renders while streaming continues",!button("Cancelar").hidden);
    check("streaming formula has no save action",!popup().querySelector(".reader-local-ai-save-answer"));
    await complete();
    const source=answer(0).dataset.readerLocalAiSource;
    check("four inline and display formulas render",answer(0).querySelectorAll("math").length===4);
    check("subscripts and product bounds are structural MathML",!!answer(0).querySelector("msub")&&!!answer(0).querySelector("munderover"));
    check("fractions and square roots are structural MathML",!!answer(0).querySelector("mfrac")&&!!answer(0).querySelector("msqrt"));
    check("native MathML namespace is retained",answer(0).querySelector("math").namespaceURI==="http://www.w3.org/1998/Math/MathML");
    check("original LaTeX remains available for saving",source.includes(String.raw`\prod_{i=1}^{n}`));
    check("MathML has visible dimensions",answer(0).querySelector("math").getBoundingClientRect().height>10);
    check("display equations scroll inside the popup",[...answer(0).querySelectorAll(".reader-local-ai-math-block")].every(node=>node.getBoundingClientRect().width<=popup().getBoundingClientRect().width));
    await screenshot("native-math-popup");
    button("Continuar perguntando").click();submit("Como os índices se relacionam com as posições?"); await complete();
    check("continuation preserves rendered formulas in both answers",popup().querySelectorAll(".reader-local-ai-answer math").length===8);
    popup().querySelector(".reader-local-ai-save-answer").click();
    await wait(()=>popup().querySelector(".reader-local-ai-save-answer").textContent==="Salvo nas anotações","saved answer");
    const added=attachment.getAnnotations().filter(item=>!prior.has(item.id));
    check("only chosen answer creates one annotation",added.length===1);
    const item=added[0], originalComment=item.annotationComment;
    check("saved comment preserves exact original TeX",originalComment==="Resposta da IA\n\nPergunta: Explique a fórmula da distribuição condicional.\n\n"+source);
    check("generated markup is never stored",!/<math|<span/.test(originalComment));
    result.saved.push({key:item.key,id:item.id,comment:originalComment});
    const native=reader._internalReader;
    if(!native._state.sidebarOpen)doc().querySelector(".sidebar-toggle").click(); native.setSidebarView("annotations");
    const row=()=>doc().querySelector(`[data-sidebar-annotation-id="${item.key}"]`);
    await wait(()=>row()?.querySelector(".reader-local-ai-annotation-math math"),"annotation MathML preview");
    check("saved annotation shows four formatted equations",row().querySelectorAll(".reader-local-ai-annotation-math math").length===4);
    let editor=row().querySelector(".comment .content");
    check("native editor contains original source and no MathML",editor.innerText===originalComment&&!editor.querySelector("math"));
    const comment=row().querySelector(".comment"); comment.click();
    await wait(()=>row().querySelector(".comment .content").isContentEditable,"native editor enabled");
    editor=row().querySelector(".comment .content"); editor.focus();
    check("native editing shows the original text",doc().activeElement===editor&&editor.getBoundingClientRect().width>50);
    const preview=row().querySelector(".reader-local-ai-annotation-math");
    check("formatted projection hides while editing",doc().defaultView.getComputedStyle(preview).display==="none");
    editor.innerText=originalComment+String.raw` Edição: \(\alpha_0\).`;
    editor.dispatchEvent(new (doc().defaultView.InputEvent)("input",{bubbles:true,inputType:"insertText"})); editor.blur();
    await wait(()=>item.annotationComment.includes("Edição:"),"edited source persisted");
    await wait(()=>row()?.querySelectorAll(".reader-local-ai-annotation-math math").length===5,"preview after native editing");
    check("native edits refresh math without inserting markup",!/<math|<span/.test(item.annotationComment));
    check("pre-existing annotations remain unchanged",[...prior].every(([id,text])=>Zotero.Items.get(id).annotationComment===text));
    await screenshot("native-math-annotation");
    await open();submit("UI_MATH_INVALID: expressão incompleta");await complete();
    check("invalid formula remains readable without dropping the answer",answer(0).textContent.includes(String.raw`\[\frac{a}{\]`));
    check("model HTML does not become executable markup",!answer(0).querySelector("img,script,iframe,a"));
    const requests=await(await win.fetch("http://127.0.0.1:18080/requests")).json();
    check("prompt requests explicit LaTeX delimiters",requests.at(-1).messages[0].content.includes(String.raw`\( ... \)`));
    const manager=ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs").AddonManager;
    const addon=await manager.getAddonByID("reader-local-ai@local.invalid");await addon.disable();
    await wait(()=>!Zotero.ReaderLocalAI,"plugin disabled");
    check("disable removes projections and restores native comments",!doc().querySelector(".reader-local-ai-annotation-math,.reader-local-ai-math-comment"));
    await addon.enable();await wait(()=>!!Zotero.ReaderLocalAI,"plugin enabled");
    await wait(()=>row()?.querySelector(".reader-local-ai-annotation-math math"),"existing annotation restored without a new selection");
    check("re-enable formats existing saved math",row().querySelectorAll(".reader-local-ai-annotation-math math").length===5);
  } catch(error) {result.errors.push({message:String(error),stack:error.stack});}
  finally {
    if(reader)popup()?.querySelector(".reader-local-ai-close").click();
    if(Zotero.ReaderLocalAI)Zotero.ReaderLocalAI.saveSettings(original);
    await win.fetch("http://127.0.0.1:18080/control",{method:"POST",body:JSON.stringify({math:false})}).catch(()=>{});
    await IOUtils.writeUTF8(output,JSON.stringify(result,null,2));
  }
})();
