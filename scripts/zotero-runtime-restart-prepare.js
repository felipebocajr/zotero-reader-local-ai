// Isolated-profile-only: enable automatic startup, start, then quit Zotero normally.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  if (Zotero.DataDirectory.dir !== root+"/.runtime/zotero-data") throw new Error("Isolated profile required");
  const profile = root+"/.runtime/zotero-profile", backup = root+"/.runtime/native-runtime-user.js.backup";
  const before = { settings: Zotero.ReaderLocalAI.getSettings(), preferences: Zotero.ReaderLocalAI.getRuntimePreferences(), zoteroPid: Services.appinfo.processID };
  const userJS = await IOUtils.readUTF8(profile+"/user.js");
  await IOUtils.writeUTF8(backup, userJS);
  try {
    const filtered = userJS.split("\n").filter(line => !/extensions\.reader-local-ai\.(autoStart|baseUrl|model)"/.test(line)).join("\n");
    await IOUtils.writeUTF8(profile+"/user.js", filtered+'\nuser_pref("extensions.reader-local-ai.autoStart", true);\nuser_pref("extensions.reader-local-ai.baseUrl", "http://127.0.0.1:18094");\nuser_pref("extensions.reader-local-ai.model", "lfm2.5-2.6b");\n');
    Zotero.ReaderLocalAI.saveConfiguration({...before.settings,baseUrl:"http://127.0.0.1:18094",model:"lfm2.5-2.6b",contextTokens:32768}, {projectRoot:root,autoStart:true});
    await Zotero.ReaderLocalAI.startRuntime();
    const win = Zotero.getMainWindow(), started = Date.now();
    while (Zotero.ReaderLocalAI.getRuntimeState().phase !== "ready") {
      const state = Zotero.ReaderLocalAI.getRuntimeState();
      if (state.phase === "error" || Date.now()-started > 150000) throw new Error(state.message+" "+state.details);
      await new Promise(r=>win.setTimeout(r,250));
    }
    before.state = Zotero.ReaderLocalAI.getRuntimeState();
    before.status = await IOUtils.readJSON(root+"/.runtime/server-18094.json");
    await IOUtils.writeUTF8(root+"/.runtime/native-runtime-restart-before.json",JSON.stringify(before,null,2));
    Services.startup.quit(Ci.nsIAppStartup.eAttemptQuit);
  } catch (error) {
    await IOUtils.writeUTF8(profile+"/user.js",userJS);
    await Zotero.ReaderLocalAI.stopRuntime(); Zotero.ReaderLocalAI.saveConfiguration(before.settings,before.preferences);
    await IOUtils.writeUTF8(root+"/.runtime/native-runtime-restart-error.json",JSON.stringify({error:String(error),stack:error.stack},null,2));
  }
})();
