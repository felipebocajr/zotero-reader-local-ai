// Exercise a status response arriving after the preferences window is destroyed.
(async function () {
  const root=Zotero.Prefs.get("extensions.reader-local-ai.devRoot",true);
  if(Zotero.DataDirectory.dir !== root+"/.runtime/zotero-data")throw new Error("Isolated profile required");
  const api=Zotero.ReaderLocalAI, original=api.requestRuntimeRefresh, win=Zotero.getMainWindow();
  const sleep=ms=>new Promise(r=>win.setTimeout(r,ms));
  const results={profile:"isolated",checks:[],errors:[]}, consoleErrors=[];
  let pref, resolve, calls=0, replies=0;
  const listener={observe(message){if(String(message.message).includes("can't access dead object"))consoleErrors.push(String(message.message));}};
  const check=(name,passed)=>{results.checks.push({name,passed:!!passed});if(!passed)throw new Error(name);};
  Services.console.registerListener(listener);
  try {
    api.requestRuntimeRefresh=()=>{calls++;void new Promise(r=>{resolve=r;}).then(()=>{replies++;});};
    pref=Zotero.Utilities.Internal.openPreferences("reader-local-ai@local.invalid-preferences");
    const started=Date.now();
    while(!resolve){if(Date.now()-started>15000)throw new Error("Status polling did not start");await sleep(50);}
    check("native preferences poll status",calls===1);
    const state=api.getRuntimeState();pref.close();pref=null;await sleep(100);
    resolve(state);await sleep(1500);
    check("closed pane does not reschedule pending status polling",calls===1 && replies===1);
    check("late status response does not access a dead Gecko window",consoleErrors.length===0);
  }catch(error){results.errors.push({message:String(error),stack:error.stack,consoleErrors});}
  finally {
    pref?.close();resolve?.(api.getRuntimeState());api.requestRuntimeRefresh=original;
    Services.console.unregisterListener(listener);
    await IOUtils.writeUTF8(root+"/experiments/results/native-runtime-pane.json",JSON.stringify(results,null,2));
  }
})();
