// Executed through the isolated profile's debugger, after verifying its data directory.
(async function () {
  const root = Zotero.Prefs.get("extensions.reader-local-ai.devRoot", true);
  const output = root + "/.runtime/install-result.json";
  try {
    if (Zotero.DataDirectory.dir !== root + "/.runtime/zotero-data") throw new Error("Refusing to install outside the development profile");
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const file = Zotero.File.pathToFile(root + "/.runtime/dev-reader-local-ai.xpi");
    const install = await AddonManager.getInstallForFile(file);
    await install.install();
    const addon = await AddonManager.getAddonByID("reader-local-ai@local.invalid");
    await IOUtils.writeUTF8(output, JSON.stringify({ installed: !!addon, active: addon?.isActive, appDisabled: addon?.appDisabled, error: install.error, state: install.state }, null, 2));
  } catch (error) { await IOUtils.writeUTF8(output, JSON.stringify({ error: String(error), stack: error.stack }, null, 2)); }
})();
