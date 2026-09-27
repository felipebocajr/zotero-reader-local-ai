// Development-only end-to-end checks with the real local model, after UI fixture tests.
(async function () {
  await Zotero.initializationPromise;
  await Zotero.uiReadyPromise;
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
  const win = Zotero.getMainWindow();
  const sleep = ms => new Promise(resolve => win.setTimeout(resolve, ms));
  const results = { zoteroVersion: Zotero.version, profile:"isolated", model:"LFM2.5-2.6B Q4_K_M", cases:[], errors:[] };
  const save = () => IOUtils.writeUTF8(root + "/experiments/results/native-model.json", JSON.stringify(results,null,2));
  const wait = async (predicate, label, timeout=600000) => {
    const start = Date.now();
    while (!predicate()) { if (Date.now()-start > timeout) throw new Error("Timeout: " + label); await sleep(50); }
  };
  const cases = [
    {paper:"attention",question:"Explique a atenção por produto escalar escalonado e o motivo do fator de escala.",
      followup:"Como o decoder impede acesso aos tokens futuros durante o treinamento?"},
    {paper:"rmsnorm",question:"O que é pRMSNorm e qual hipótese permite estimar a RMS usando apenas parte das unidades?"},
    {paper:"llada",question:"Quais resultados o artigo apresenta para quantização Q4 dos pesos e Q8 do KV cache?"},
  ];
  try {
    Zotero.ReaderLocalAI.saveSettings({...Zotero.ReaderLocalAI.getSettings(),baseUrl:"http://127.0.0.1:18080",timeoutMs:600000});
    for (const test of cases) {
      const attachment = await Zotero.Attachments.importFromFile({file:root + "/experiments/data/" + test.paper + ".pdf"});
      const reader = await Zotero.Reader.open(attachment.id); await reader._initPromise;
      const view = reader._internalReader._primaryView;
      await wait(()=>view._pdfPages[0],"page initialized",30000);
      const doc = reader._iframe.contentDocument;
      // A selection on the first page; the question may require any page of the article.
      const chars = view._pdfPages[0].chars.slice(0,18);
      const rect = [Math.min(...chars.map(c=>c.rect[0])),Math.min(...chars.map(c=>c.rect[1])),Math.max(...chars.map(c=>c.rect[2])),Math.max(...chars.map(c=>c.rect[3]))];
      view._setSelectionRanges(Components.utils.cloneInto([{collapsed:false,text:chars.map(c=>c.u).join(""),sortIndex:"00000|000000|00000",position:{pageIndex:0,rects:[rect]}}],reader._iframeWindow));
      await wait(()=>doc.querySelector(".reader-local-ai-actions"),"selection actions",10000);
      [...doc.querySelectorAll(".reader-local-ai-actions button")].find(b=>b.textContent==="Fazer pergunta").click();
      const popup = doc.querySelector(".reader-local-ai-popup");
      for (const [index, question] of [test.question, test.followup].filter(Boolean).entries()) {
      if (index) [...popup.querySelectorAll("button")].find(b=>b.textContent==="Continuar perguntando").click();
      popup.querySelector("textarea").value=question;
      const start=Date.now(); let firstFinalTokenMs=null;
      const watch=win.setInterval(()=>{if(popup.querySelectorAll(".reader-local-ai-answer")[index]?.textContent) firstFinalTokenMs??=Date.now()-start;},25);
      try {
        popup.querySelector("form").requestSubmit();
        await wait(()=>[...popup.querySelectorAll("button")].some(b=>b.textContent==="Continuar perguntando"&&!b.hidden)||popup.querySelector(".reader-local-ai-error").textContent,"model response");
        const error=popup.querySelector(".reader-local-ai-error").textContent;
        if(error) throw new Error(error);
        const totalMs=Date.now()-start;
        const text=await Zotero.PDFWorker.getFullText(attachment.id,null);
        results.cases.push({paper:test.paper,question,followup:!!index,conversationTurns:popup.querySelectorAll(".reader-local-ai-answer").length,
          selectedPage:1,extractedPages:text.extractedPages,totalPages:text.totalPages,paperChars:text.text.length,
          answer:popup.querySelectorAll(".reader-local-ai-answer")[index].textContent,firstFinalTokenMs,totalMs});
        const snapshot=await win.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null,1,"white");
        const canvas=win.document.createElementNS("http://www.w3.org/1999/xhtml","canvas"); canvas.width=snapshot.width;canvas.height=snapshot.height;
        canvas.getContext("2d").drawImage(snapshot,0,0);snapshot.close();
        const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));
        await IOUtils.write(root+"/.runtime/native-model-"+test.paper+(index?"-followup":"")+".png",new Uint8Array(await blob.arrayBuffer()));
      } finally {win.clearInterval(watch);}
      await save();
      }
      popup.querySelector(".reader-local-ai-close").click(); reader.close();
    }
  } catch(error) {results.errors.push({message:String(error),stack:error.stack});await save();}
})();
