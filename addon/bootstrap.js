var ReaderLocalAI;

function install() {}
function uninstall() {}

async function startup(data) {
  Components.utils.importGlobalProperties(["fetch", "AbortController", "TextDecoder", "URL", "IOUtils", "PathUtils"]);
  const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
  const { FilePicker } = ChromeUtils.importESModule("chrome://zotero/content/modules/filePicker.mjs");
  const { setTimeout, clearTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  Services.scriptloader.loadSubScript(data.rootURI + "reader-local-ai.js");
  const fetcher = (url, options) => fetch(url, options);
  const runtime = ReaderLocalAI.createRuntimePlatform({ io: IOUtils, paths: PathUtils, subprocess: Subprocess, FilePicker,
    processID: Services.appinfo.processID, os: Services.appinfo.OS, fetch: fetcher, setTimeout, clearTimeout });
  await ReaderLocalAI.start(data, { zotero: Zotero, io: IOUtils, fetch: fetcher, runtime });
  // DEV_HARNESS_INSERTION_POINT
}

async function shutdown() {
  await ReaderLocalAI?.stop();
  ReaderLocalAI = undefined;
}
