// Install the distributable in the isolated profile, without the development harness.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const output = root + "/experiments/results/native-install.json";
  try {
    if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Isolated profile required");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const file = Zotero.File.pathToFile(root + "/dist/reader-local-ai-0.1.0.xpi");
    const install = await AddonManager.getInstallForFile(file);
    await install.install();
    const addon = await AddonManager.getAddonByID("reader-local-ai@local.invalid");
    await IOUtils.writeUTF8(output, JSON.stringify({ artifact:"dist/reader-local-ai-0.1.0.xpi", zoteroVersion:Zotero.version,
      profile:"isolated", installed:!!addon, active:addon?.isActive, appDisabled:addon?.appDisabled,
      error:install.error, state:install.state, harnessIncluded:false }, null, 2));
  } catch (error) { await IOUtils.writeUTF8(output, JSON.stringify({ error:String(error), stack:error.stack }, null, 2)); }
})();
