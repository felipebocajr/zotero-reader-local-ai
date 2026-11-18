import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimePlatform } from "../src/zotero-runtime.ts";

function normalize(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function makeHost(options: {
  os: string;
  abi: string;
  files?: string[];
  lock?: unknown;
  search?: (name: string) => string;
  spawn?: (options: any) => any;
}) {
  const files = new Set((options.files ?? []).map(normalize));
  const searches: string[] = [];
  const calls: any[] = [];
  const host = {
    io: {
      async exists(path: string) { return files.has(normalize(path)); },
      async readJSON() { return options.lock; },
    },
    paths: {
      join(...parts: string[]) { return normalize(parts.join("/")); },
    },
    subprocess: {
      async pathSearch(name: string) {
        searches.push(name);
        if (options.search) return options.search(name);
        return name;
      },
      async call(input: any) {
        calls.push(input);
        return options.spawn ? options.spawn(input) : undefined;
      },
    },
    FilePicker: class {},
    processID: 99,
    os: options.os,
    abi: options.abi,
    fetch: async () => { throw new Error("unused"); },
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  return { platform: createRuntimePlatform(host), searches, calls };
}

const rootFiles = (root: string) => [normalize(root), normalize(`${root}/scripts/serve.py`), normalize(`${root}/runtime.lock.json`)];

test("native root validation accepts Linux and Windows x64 absolute folders", async () => {
  const linux = makeHost({ os: "Linux", abi: "x86_64-gcc", files: rootFiles("/project") });
  assert.equal(await linux.platform.validateRoot("/project"), "/project");
  const windows = makeHost({ os: "WINNT", abi: "x86_64-msvc", files: rootFiles("C:\\project") });
  assert.equal(await windows.platform.validateRoot("C:\\project"), "C:\\project");
  const unc = makeHost({ os: "WINNT", abi: "x86_64-msvc", files: rootFiles("\\\\server\\share\\project") });
  assert.equal(await unc.platform.validateRoot("\\\\server\\share\\project"), "\\\\server\\share\\project");
});

test("native root validation rejects Windows ARM64, relative paths and macOS", async () => {
  const arm = makeHost({ os: "WINNT", abi: "aarch64-msvc", files: rootFiles("C:\\project") });
  await assert.rejects(arm.platform.validateRoot("C:\\project"), /ARM64/);
  const relative = makeHost({ os: "WINNT", abi: "x86_64-msvc", files: [] });
  await assert.rejects(relative.platform.validateRoot("project"), /caminho absoluto/);
  const mac = makeHost({ os: "Darwin", abi: "x86_64", files: [] });
  await assert.rejects(mac.platform.validateRoot("/project"), /Linux e Windows x64/);
});

test("Windows spawn falls back to the py launcher and sends a stop byte", async () => {
  const writes: string[] = [];
  const child = {
    pid: 42,
    stdout: { async readString() { return ""; } },
    wait: async () => ({ exitCode: 0 }),
    stdin: {
      async write(value: string) { writes.push(value); },
      async close() {},
    },
    async kill() {},
  };
  const fake = makeHost({
    os: "WINNT", abi: "x86_64-msvc",
    files: ["C:\\project/runtime.lock.json", "C:\\project/.runtime/models/model.gguf"],
    lock: { model: { variants: { Q4_K_M: { filename: "model.gguf" } } }, additionalModels: {} },
    search(name) {
      if (name === "python3.exe" || name === "python.exe") throw new Error("missing");
      return "C:\\Windows\\py.exe";
    },
    spawn() { return child; },
  });
  const owned = await fake.platform.spawn({ projectRoot: "C:\\project", baseUrl: "http://127.0.0.1:8080",
    model: "lfm2.5-2.6b", contextTokens: 64000, port: 8080 });
  assert.deepEqual(fake.searches, ["python3.exe", "python.exe", "py.exe"]);
  assert.equal(fake.calls[0].command, "C:\\Windows\\py.exe");
  assert.deepEqual(fake.calls[0].arguments.slice(0, 3), ["-3", "-u", "C:/project/scripts/serve.py"]);
  assert.equal(owned.pid, 42);
  await owned.stop();
  assert.deepEqual(writes, ["stop\n"]);
});
