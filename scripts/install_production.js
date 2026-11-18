// Install/update the distributable in the production profile through AddonManager.
// Run only with an explicitly started loopback debugger on that profile.
(async function () {
  const base = Zotero.Prefs.get("extensions.reader-local-ai.projectRoot", true);
  const version = JSON.parse(await IOUtils.readUTF8(base + "/addon/manifest.json")).version;
  const artifact = "dist/reader-local-ai-" + version + ".xpi";
  const output = base + "/experiments/results/native-install-production-" + version + ".json";
  let install;
  try {
    const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const file = Zotero.File.pathToFile(base + "/" + artifact);
    install = await AddonManager.getInstallForFile(file);
    if (!install) throw new Error("AddonManager não criou a instalação.");
    const addon = await new Promise((resolve, reject) => {
      install.addListener({
        onInstallEnded: (_install, installed) => resolve(installed),
        onInstallFailed: (_install, error) => reject(new Error(String(error))),
      });
      install.install().catch(reject);
    });
    Zotero.Prefs.set("extensions.reader-local-ai.projectRoot", base, true);
    await IOUtils.writeUTF8(output, JSON.stringify({
      artifact, version: addon?.version, zoteroVersion: Zotero.version, profile: "production",
      dataDir: String(Zotero.DataDirectory.dir), installed: !!addon, active: addon?.isActive,
      appDisabled: addon?.appDisabled, userDisabled: addon?.userDisabled,
      error: install.error, state: install.state, projectRoot: base,
    }, null, 2));
  } catch (error) {
    await IOUtils.writeUTF8(output, JSON.stringify({
      artifact, version, error: String(error), stack: error?.stack, projectRoot: base,
    }, null, 2));
  }
})();
