import test from "node:test";
import assert from "node:assert/strict";
import { EmbeddingController } from "../src/embedding-runtime.ts";
import type { EmbeddingProbe, OwnedProcess, RuntimePlatform } from "../src/runtime.ts";

function fixture(options: { projectRoot?: string; probes?: (EmbeddingProbe | undefined)[] } = {}) {
  const calls = { spawn: 0, stop: 0, probes: 0 };
  let resolveExit: (code: number) => void = () => {};
  const exited = new Promise<number>(resolve => { resolveExit = resolve; });
  const process: OwnedProcess = {
    pid: 4242,
    exited,
    stop: async () => { calls.stop++; resolveExit(0); },
    tail: () => "embedding log",
  };
  const probes = [...(options.probes ?? [])];
  const platform: RuntimePlatform = {
    async pickFolder() { return undefined; },
    async validateRoot(root) { return root; },
    async spawn() { throw new Error("chat spawn not expected"); },
    async spawnEmbedding() { calls.spawn++; return process; },
    async probe() { return undefined; },
    async probeEmbedding() { calls.probes++; return probes.shift(); },
    async readStatus() { return undefined; },
    later(callback) { const id = setTimeout(callback, 0); return () => clearTimeout(id); },
  };
  const preferences = () => ({ projectRoot: options.projectRoot ?? "/project", autoStart: false });
  const controller = new EmbeddingController(platform, preferences, "http://127.0.0.1:18081", "qwen3-embedding-0.6b", () => {});
  return { controller, calls };
}

test("embedding controller starts one owned server and stops it", async () => {
  const { controller, calls } = fixture({ probes: [
    undefined,
    undefined,
    { ready: true, model: "qwen3-embedding-0.6b" },
  ] });
  await controller.ensureReady();
  assert.equal(controller.getState().phase, "ready");
  assert.equal(controller.getState().owned, true);
  assert.equal(calls.spawn, 1);
  await controller.stop();
  assert.equal(calls.stop, 1);
  assert.equal(controller.getState().phase, "stopped");
});

test("embedding controller reuses an external server and never stops it", async () => {
  const { controller, calls } = fixture({ probes: [{ ready: true, model: "qwen3-embedding-0.6b" }] });
  await controller.ensureReady();
  assert.equal(controller.getState().phase, "external");
  assert.equal(calls.spawn, 0);
  await controller.stop();
  assert.equal(calls.stop, 0);
});

test("embedding controller refuses a missing project folder or a different model", async () => {
  const missing = fixture({ projectRoot: "", probes: [undefined] });
  await assert.rejects(missing.controller.ensureReady(), /pasta do projeto/i);
  assert.equal(missing.calls.spawn, 0);

  const mismatch = fixture({ probes: [{ ready: true, model: "other-model" }] });
  await assert.rejects(mismatch.controller.ensureReady(), /esperado qwen3-embedding-0\.6b/i);
  assert.equal(mismatch.calls.spawn, 0);
});
