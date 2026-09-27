// After restarting the isolated Zotero normally: verify auto-start and restore fixtures.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot",true);
  if (Zotero.DataDirectory.dir !== root+"/.runtime/zotero-data") throw new Error("Isolated profile required");
  const before = await IOUtils.readJSON(root+"/.runtime/native-runtime-restart-before.json");
  const win = Zotero.getMainWindow(), sleep = ms=>new Promise(r=>win.setTimeout(r,ms));
  const results = {zoteroVersion:Zotero.version,profile:"isolated",checks:[],beforePid:before.zoteroPid,afterPid:Services.appinfo.processID,errors:[]};
  const check = (name,passed)=>{results.checks.push({name,passed:!!passed});if(!passed)throw new Error(name);};
  let pref;
  try {
    const started=Date.now();
    while (Zotero.ReaderLocalAI?.getRuntimeState().phase !== "ready") {
      if (Date.now()-started > 150000 || Zotero.ReaderLocalAI?.getRuntimeState().phase === "error") throw new Error("Automatic startup failed: "+JSON.stringify(Zotero.ReaderLocalAI?.getRuntimeState()));
      await sleep(250);
    }
    check("full Zotero process restart",before.zoteroPid !== Services.appinfo.processID);
    check("closing Zotero reaped previous supervisor",!await IOUtils.exists("/proc/"+before.status.supervisorPid));
    check("closing Zotero reaped previous llama child",!await IOUtils.exists("/proc/"+before.status.attempts.at(-1).pid));
    results.state = Zotero.ReaderLocalAI.getRuntimeState();
    results.status = await IOUtils.readJSON(root+"/.runtime/server-18094.json");
    check("automatic startup owns a fresh ready process",results.state.owned && results.state.pid !== before.state.pid);
    check("automatic startup retains model/context",results.state.model === "lfm2.5-2.6b" && results.state.contextTokens === 32768);
    pref=Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    while (!pref.document.getElementById("reader-local-ai-autoStart")) await sleep(100);
    await sleep(2000);
    check("native checkbox survives Zotero restart",pref.document.getElementById("reader-local-ai-autoStart").checked);
    const bitmap=await pref.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null,1,"white");
    const canvas=pref.document.createElementNS("http://www.w3.org/1999/xhtml","canvas");
    canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();
    const blob=await new Promise(r=>canvas.toBlob(r,"image/png"));
    await IOUtils.write(root+"/.runtime/native-runtime-ready.png",new Uint8Array(await blob.arrayBuffer()));
  } catch(error){results.errors.push({message:String(error),stack:error.stack});}
  finally {
    pref?.close();
    await IOUtils.writeUTF8(root+"/.runtime/zotero-profile/user.js",await IOUtils.readUTF8(root+"/.runtime/native-runtime-user.js.backup"));
    if (Zotero.ReaderLocalAI) {
      await Zotero.ReaderLocalAI.stopRuntime();
      Zotero.ReaderLocalAI.saveConfiguration(before.settings,before.preferences);
      check("restart fixture restores automatic startup preference",Zotero.ReaderLocalAI.getRuntimePreferences().autoStart === before.preferences.autoStart);
      if(results.status) check("restoring fixture reaps the new server",!await IOUtils.exists("/proc/"+results.status.supervisorPid) && !await IOUtils.exists("/proc/"+results.status.attempts.at(-1).pid));
    }
    await IOUtils.writeUTF8(root+"/experiments/results/native-runtime-restart.json",JSON.stringify(results,null,2));
  }
})();
