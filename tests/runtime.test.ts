import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULTS } from "../src/config.ts";
import { RuntimeController, validateRuntimePreferences } from "../src/runtime.ts";
import type { LaunchConfig, OwnedProcess, RuntimePlatform, ServerProbe, SupervisorStatus } from "../src/runtime.ts";

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture() {
  let settings = { ...DEFAULTS }, preferences = { projectRoot: "/project with spaces", autoStart: false };
  let probe: ServerProbe | undefined, status: SupervisorStatus | undefined;
  const exit = deferred<number>(), spawned = deferred<OwnedProcess>();
  const launches: LaunchConfig[] = [], timers: (() => void)[] = [];
  let stops = 0, cancelled = 0, delaySpawn = false;
  const process: OwnedProcess = { pid: 42, exited: exit.promise, tail: () => "CUDA startup diagnostic",
    async stop() { stops++; exit.resolve(0); } };
  const platform: RuntimePlatform = {
    async pickFolder() { return "/picked"; }, async validateRoot(root) { return root; },
    async spawn(config) { launches.push(config); return delaySpawn ? spawned.promise : process; },
    async probe() { return probe; }, async readStatus() { return status; },
    later(callback) { timers.push(callback); return () => { const index = timers.indexOf(callback); if (index >= 0) timers.splice(index, 1); }; },
  };
  const controller = new RuntimeController(platform, () => settings, () => preferences, () => { cancelled++; });
  return { controller, process, launches, timers, spawned, exit,
    setProbe: (value?: ServerProbe) => { probe = value; }, setStatus: (value?: SupervisorStatus) => { status = value; },
    setSettings: (value: Partial<typeof settings>) => { settings = { ...settings, ...value }; },
    setRoot: (root: string) => { preferences = { ...preferences, projectRoot: root }; },
    delaySpawn: () => { delaySpawn = true; }, get stops() { return stops; }, get cancelled() { return cancelled; },
  };
}

test("native runtime requires a configured folder for automatic startup", async () => {
  assert.throws(() => validateRuntimePreferences({ projectRoot: "", autoStart: true }), /Escolha/);
  assert.throws(() => validateRuntimePreferences({ projectRoot: "/project\nother", autoStart: false }), /Confira/);
  const f = fixture(); f.setRoot(""); await f.controller.start();
  assert.equal(f.controller.getState().phase, "error"); assert.match(f.controller.getState().message, /pasta/);
  assert.equal(f.launches.length, 0);
});

test("repeated start creates one process with selected model/context/port and preserves spaces", async () => {
  const f = fixture(); f.setSettings({ baseUrl: "http://127.0.0.1:18090", model: "lfm2.5-8b-a1b", contextTokens: 65536 });
  await Promise.all([f.controller.start(), f.controller.start()]); await f.controller.start();
  assert.equal(f.launches.length, 1);
  assert.deepEqual(f.launches[0], { projectRoot: "/project with spaces", baseUrl: "http://127.0.0.1:18090", model: "lfm2.5-8b-a1b", contextTokens: 65536, port: 18090 });
  await f.controller.dispose(); assert.equal(f.stops, 1); assert.equal(f.timers.length, 0);
});

test("an external server is never adopted, stopped or restarted, even with a different model", async () => {
  const f = fixture(); f.setProbe({ ready: true, model: "other", contextTokens: 8192, slots: 1 });
  await f.controller.start();
  assert.equal(f.controller.getState().phase, "external"); assert.equal(f.controller.getState().owned, false);
  await assert.rejects(f.controller.restart(), /fora do Zotero/);
  await f.controller.stop(); await f.controller.dispose();
  assert.equal(f.launches.length, 0); assert.equal(f.stops, 0);
});

test("ready state requires both the owned PID and matching HTTP model/context", async () => {
  const f = fixture(); await f.controller.start();
  f.setProbe({ ready: true, model: DEFAULTS.model, contextTokens: 32768, slots: 1 });
  f.setStatus({ supervisorPid: 99, phase: "ready", backend: "cuda", gpuLayers: "all" });
  await f.controller.refresh(); assert.equal(f.controller.getState().phase, "starting");
  f.setStatus({ supervisorPid: 42, phase: "ready", backend: "cuda", gpuLayers: "all" });
  f.setProbe({ ready: true, model: "wrong", contextTokens: 32768, slots: 1 });
  await f.controller.refresh(); assert.equal(f.controller.getState().phase, "starting");
  f.setProbe({ ready: true, model: DEFAULTS.model, contextTokens: 32768, slots: 1 });
  await f.controller.refresh(); assert.match(f.controller.getState().message, /GPU inteira/);
  assert.equal(f.controller.getState().phase, "ready"); await f.controller.dispose();
});

test("fallback transitions preserve ownership and show shared GPU/CPU then CPU", async () => {
  const f = fixture(); await f.controller.start();
  f.setStatus({ supervisorPid: 42, phase: "loading", backend: "cuda", gpuLayers: "auto" });
  await f.controller.refresh(); assert.match(f.controller.getState().message, /GPU\/CPU/);
  f.setStatus({ supervisorPid: 42, phase: "ready", backend: "cpu", gpuLayers: 0 });
  f.setProbe({ ready: true, model: DEFAULTS.model, contextTokens: 32768, slots: 1 });
  await f.controller.refresh(); assert.equal(f.controller.getState().backend, "cpu");
  assert.equal(f.controller.getState().owned, true); await f.controller.dispose();
});

test("configuration change needs explicit restart and cancels current requests", async () => {
  const f = fixture(); await f.controller.start(); f.setSettings({ responseLanguage: "en" });
  assert.equal(f.controller.getState().restartRequired, false); assert.equal(f.launches.length, 1);
  f.setSettings({ model: "lfm2.5-8b-a1b" });
  assert.equal(f.controller.getState().restartRequired, true); assert.equal(f.launches.length, 1);
  await f.controller.restart(); assert.equal(f.stops, 1); assert.equal(f.cancelled, 1);
  assert.equal(f.launches.length, 2); assert.equal(f.launches[1].model, "lfm2.5-8b-a1b");
  await f.controller.dispose();
});

test("stop while process creation is pending reaps the late process and leaves no monitor", async () => {
  const f = fixture(); f.delaySpawn(); const starting = f.controller.start();
  while (!f.launches.length) await Promise.resolve();
  const stopping = f.controller.stop(); f.spawned.resolve(f.process);
  await starting; await stopping;
  assert.equal(f.stops, 1); assert.equal(f.controller.getState().owned, false);
  assert.equal(f.controller.getState().phase, "stopped"); assert.equal(f.timers.length, 0);
});

test("unexpected process exit releases ownership and exposes readable diagnostics", async () => {
  const f = fixture(); await f.controller.start(); f.exit.resolve(1); await Promise.resolve();
  assert.equal(f.controller.getState().phase, "error"); assert.equal(f.controller.getState().owned, false);
  assert.equal(f.controller.getState().details, "CUDA startup diagnostic"); assert.equal(f.timers.length, 0);
  await f.controller.dispose(); assert.equal(f.stops, 0);
});

test("disabling during the external-server probe cannot start a process later", async () => {
  const f = fixture(); const starting = f.controller.start(); const disposed = f.controller.dispose();
  await starting; await disposed; assert.equal(f.launches.length, 0);
  await assert.rejects(f.controller.start(), /desativado/);
});
