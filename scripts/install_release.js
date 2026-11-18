// Install the distributable in the isolated profile, without the development harness.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const dataDir = String(Zotero.DataDirectory.dir).replace(/\\/g, "/").replace(/\/+$/, "");
  const version = JSON.parse(await IOUtils.readUTF8(base + "/addon/manifest.json")).version;
  const artifact = "dist/reader-local-ai-" + version + ".xpi";
  const output = base + "/experiments/results/native-install-" + version + ".json";
  try {
    if (dataDir !== base + "/.runtime/zotero-data") throw new Error("Isolated profile required");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const file = Zotero.File.pathToFile(base + "/" + artifact);
    const install = await AddonManager.getInstallForFile(file);
    await install.install();
    const addon = await AddonManager.getAddonByID("reader-local-ai@local.invalid");
    await IOUtils.writeUTF8(output, JSON.stringify({ artifact, version:addon?.version, zoteroVersion:Zotero.version,
      profile:"isolated", installed:!!addon, active:addon?.isActive, appDisabled:addon?.appDisabled,
      error:install.error, state:install.state, harnessIncluded:false }, null, 2));
  } catch (error) { await IOUtils.writeUTF8(output, JSON.stringify({ error:String(error), stack:error.stack }, null, 2)); }
})();
