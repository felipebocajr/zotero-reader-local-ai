#!/usr/bin/env python3
"""Prepare an isolated Zotero profile with a development-only test harness."""
import json
from pathlib import Path
from zipfile import ZipFile

ROOT = Path(__file__).resolve().parents[1]
profile = ROOT / ".runtime/zotero-profile"
data = ROOT / ".runtime/zotero-data"
profile.mkdir(parents=True, exist_ok=True)
data.mkdir(parents=True, exist_ok=True)
version = json.loads((ROOT / "addon/manifest.json").read_text())["version"]
source = ROOT / f"dist/reader-local-ai-{version}.xpi"
if not source.exists(): raise SystemExit("Execute npm run build antes de preparar o perfil.")
harness = ROOT / "scripts/zotero-harness.js"
with ZipFile(source) as original, ZipFile(ROOT / ".runtime/dev-reader-local-ai.xpi", "w") as dev:
    for name in original.namelist():
        contents = original.read(name)
        if name == "bootstrap.js":
            contents = contents.decode().replace(
                "// DEV_HARNESS_INSERTION_POINT",
                "Services.scriptloader.loadSubScript(" + json.dumps(harness.as_uri()) + ", {Zotero, IOUtils, Services, ReaderLocalAI});"
            ).encode()
        dev.writestr(name, contents)
prefs = {
    "extensions.zotero.useDataDir": True, "extensions.zotero.dataDir": str(data),
    "extensions.zotero.firstRun2": False, "extensions.zotero.firstRunGuidance": False,
    "extensions.zotero.httpServer.enabled": False, "extensions.zotero.sync.autoSync": False,
    "extensions.autoDisableScopes": 0, "extensions.enabledScopes": 15,
    "browser.dom.window.dump.enabled": True,
    "devtools.debugger.remote-enabled": True, "devtools.debugger.prompt-connection": False,
    "devtools.chrome.enabled": True, "devtools.debugger.force-local": True,
    "extensions.reader-local-ai.baseUrl": "http://127.0.0.1:18080",
    "extensions.reader-local-ai.timeoutMs": 600000,
    "extensions.reader-local-ai.devRoot": str(ROOT),
    "extensions.reader-local-ai.projectRoot": str(ROOT),
    "extensions.reader-local-ai.autoStart": False,
}
(profile / "user.js").write_text("\n".join(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in prefs.items()) + "\n")
print(f"Perfil: {profile}\nBiblioteca: {data}\nExecute Zotero com -no-remote -profile neste perfil.")
