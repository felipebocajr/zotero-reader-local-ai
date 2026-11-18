import { spawnSync } from "node:child_process";

/** Locate the same Python 3.12+ installation the plugin will use. */
export function pythonCandidates() {
  if (process.env.PYTHON) return [{ command: process.env.PYTHON, prefix: [] }];
  if (process.platform === "win32") {
    return [
      { command: "python", prefix: [] },
      { command: "py", prefix: ["-3"] },
      { command: "python3", prefix: [] },
    ];
  }
  return [{ command: "python3", prefix: [] }, { command: "python", prefix: [] }];
}

export function runPython(args, options = {}) {
  for (const candidate of pythonCandidates()) {
    const result = spawnSync(candidate.command, [...candidate.prefix, ...args], { stdio: "inherit", ...options });
    if (result.error?.code === "ENOENT") continue;
    if (result.error) throw result.error;
    return result.status ?? 1;
  }
  throw new Error("Python 3.12+ não foi encontrado. Defina PYTHON com o caminho do interpretador.");
}
