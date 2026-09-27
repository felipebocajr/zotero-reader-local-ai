import type { LaunchConfig, OwnedProcess, RuntimePlatform, ServerProbe, SupervisorStatus } from "./runtime.ts";
import type { FetchLike } from "./types.ts";

interface NativeHost { io: any; paths: any; subprocess: any; FilePicker: any; processID: number; os: string;
  fetch: FetchLike; setTimeout: (callback: () => void, ms: number) => any; clearTimeout: (timer: any) => void }

/** Gecko process and folder-picker APIs stay outside the portable controller. No shell commands. */
export function createRuntimePlatform(host: NativeHost): RuntimePlatform {
  const { io, paths, subprocess } = host;
  const later = (callback: () => void, ms: number) => { const id = host.setTimeout(callback, ms); return () => host.clearTimeout(id); };
  return {
    later,
    async pickFolder(window, initial) {
      const picker = new host.FilePicker();
      picker.init(window, "Escolha a pasta do projeto Reader Local AI", picker.modeGetFolder);
      if (initial && await io.exists(initial)) picker.displayDirectory = initial;
      return await picker.show() === picker.returnOK ? picker.file : undefined;
    },
    async validateRoot(root) {
      if (host.os !== "Linux") throw new Error("O início pelo Zotero está disponível para Linux. Nos demais sistemas, inicie o runtime separadamente.");
      if (!root.startsWith("/")) throw new Error("Escolha uma pasta com caminho absoluto.");
      if (!await io.exists(root) || !await io.exists(paths.join(root, "scripts", "serve.py")) || !await io.exists(paths.join(root, "runtime.lock.json"))) {
        throw new Error("A pasta escolhida não contém scripts/serve.py e runtime.lock.json. Selecione a pasta deste projeto.");
      }
      return root;
    },
    async spawn(config: LaunchConfig): Promise<OwnedProcess> {
      const lock = await io.readJSON(paths.join(config.projectRoot, "runtime.lock.json"));
      const model = config.model === "lfm2.5-2.6b" ? lock.model : lock.additionalModels?.[config.model];
      const filename = model?.variants?.Q4_K_M?.filename;
      if (!filename || !await io.exists(paths.join(config.projectRoot, ".runtime", "models", filename))) {
        throw new Error(`Os pesos Q4 de ${config.model} ainda não foram preparados. Execute uma vez: python3 scripts/setup_runtime.py --model ${config.model}`);
      }
      let python: string;
      try { python = await subprocess.pathSearch("python3"); }
      catch { throw new Error("Python 3 não foi encontrado. Instale-o para iniciar o servidor local pelo Zotero."); }
      const process = await subprocess.call({ command: python, workdir: config.projectRoot, stderr: "stdout",
        arguments: ["-u", paths.join(config.projectRoot, "scripts", "serve.py"), "--model", config.model,
          "--context", String(config.contextTokens), "--port", String(config.port), "--managed", "--parent-pid", String(host.processID)] });
      let tail = "";
      const pump = (async () => {
        try { for (;;) { const chunk = await process.stdout.readString(); if (!chunk) break; tail = (tail + chunk).slice(-8000); } }
        catch { /* Pipe closes when Zotero shuts down. */ }
      })();
      const exited = process.wait().then(async ({ exitCode }: { exitCode: number }) => { await pump; return exitCode; });
      let stopping: Promise<void> | undefined;
      return { pid: process.pid, exited, tail: () => tail,
        stop() {
          if (!stopping) stopping = (async () => {
            // EOF is the managed launcher's graceful stop signal; it reaps its llama child.
            await process.stdin.close().catch(() => {});
            const cancel = later(() => { void process.kill(15000).catch(() => {}); }, 15000);
            try { await exited; } finally { cancel(); }
          })();
          return stopping;
        },
      };
    },
    async readStatus(config): Promise<SupervisorStatus | undefined> {
      try { return await io.readJSON(paths.join(config.projectRoot, ".runtime", `server-${config.port}.json`)); }
      catch { return undefined; }
    },
    async probe(baseUrl): Promise<ServerProbe | undefined> {
      const abort = new AbortController();
      const cancel = later(() => abort.abort(), 1500);
      let reachable = false;
      try {
        const health = await host.fetch(baseUrl + "/health", { signal: abort.signal, redirect: "error" });
        reachable = true;
        if (!health.ok) return { ready: false };
        const [models, props] = await Promise.all([
          host.fetch(baseUrl + "/v1/models", { signal: abort.signal, redirect: "error" }).then(r => r.json()),
          host.fetch(baseUrl + "/props", { signal: abort.signal, redirect: "error" }).then(r => r.json()),
        ]);
        return { ready: true, model: models.data?.[0]?.id, contextTokens: props.default_generation_settings?.n_ctx, slots: props.total_slots };
      } catch { return reachable ? { ready: false } : undefined; }
      finally { cancel(); }
    },
  };
}
