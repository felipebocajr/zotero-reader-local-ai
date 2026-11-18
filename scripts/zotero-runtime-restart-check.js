// After restarting the isolated Zotero normally: verify auto-start and restore fixtures.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot",true);
  const base = root.replace(/\\/g,"/").replace(/\/+$/,"");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g,"/").replace(/\/+$/,"");
  if (dataDir !== base+"/.runtime/zotero-data") throw new Error("Isolated profile required");
  const processExists = async pid => {
    if (!pid) return false;
    if (Services.appinfo.OS !== "WINNT") return IOUtils.exists("/proc/"+pid);
    const {Subprocess} = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const tasklist = await Subprocess.pathSearch("tasklist.exe");
    const proc = await Subprocess.call({command:tasklist,arguments:["/FI",`PID eq ${pid}`,"/NH"],stdout:"pipe",stderr:"ignore"});
    const output = await proc.stdout.readString(); await proc.wait();
    return output.includes(String(pid));
  };
  const before = await IOUtils.readJSON(base+"/.runtime/native-runtime-restart-before.json");
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
    check("closing Zotero reaped previous supervisor",!await processExists(before.status.supervisorPid));
    check("closing Zotero reaped previous llama child",!await processExists(before.status.attempts.at(-1).pid));
    results.state = Zotero.ReaderLocalAI.getRuntimeState();
    results.status = await IOUtils.readJSON(base+"/.runtime/server-18094.json");
    check("automatic startup owns a fresh ready process",results.state.owned && results.state.pid !== before.state.pid);
    check("automatic startup retains model/context",results.state.model === "lfm2.5-8b-a1b" && results.state.contextTokens === 32768);
    pref=Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    while (!pref.document.getElementById("reader-local-ai-autoStart")) await sleep(100);
    await sleep(2000);
    check("native checkbox survives Zotero restart",pref.document.getElementById("reader-local-ai-autoStart").checked);
    const bitmap=await pref.docShell.browsingContext.currentWindowGlobal.drawSnapshot(null,1,"white");
    const canvas=pref.document.createElementNS("http://www.w3.org/1999/xhtml","canvas");
    canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext("2d").drawImage(bitmap,0,0);bitmap.close();
    const blob=await new Promise(r=>canvas.toBlob(r,"image/png"));
    await IOUtils.write(base+"/.runtime/native-runtime-ready.png",new Uint8Array(await blob.arrayBuffer()));
  } catch(error){results.errors.push({message:String(error),stack:error.stack});}
  finally {
    pref?.close();
    await IOUtils.writeUTF8(base+"/.runtime/zotero-profile/user.js",await IOUtils.readUTF8(base+"/.runtime/native-runtime-user.js.backup"));
    if (Zotero.ReaderLocalAI) {
      await Zotero.ReaderLocalAI.stopRuntime();
      Zotero.ReaderLocalAI.saveConfiguration(before.settings,before.preferences);
      check("restart fixture restores automatic startup preference",Zotero.ReaderLocalAI.getRuntimePreferences().autoStart === before.preferences.autoStart);
      if(results.status) check("restoring fixture reaps the new server",!await processExists(results.status.supervisorPid) && !await processExists(results.status.attempts.at(-1).pid));
    }
    await IOUtils.writeUTF8(base+"/experiments/results/native-runtime-restart.json",JSON.stringify(results,null,2));
  }
})();
