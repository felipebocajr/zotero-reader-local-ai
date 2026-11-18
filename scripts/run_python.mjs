import { runPython } from "./python-command.mjs";

try {
  process.exitCode = runPython(process.argv.slice(2));
} catch (error) {
  console.error(String(error?.message ?? error));
  process.exitCode = 1;
}
