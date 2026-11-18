import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readExecutionProfile } from "./execution-profile.mjs";
import { prepareAudio } from "./prepare-audio.mjs";
import { prepareFrontend } from "./prepare-frontend.mjs";
import { prepareBackend } from "./prepare-backend.mjs";

const [command, ...args] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) throw new Error("Expected dev or build.");
const siteRoot = fileURLToPath(new URL("../", import.meta.url));
process.chdir(siteRoot);
process.env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "");

function runNode(arguments_, env = {}) {
  const result = spawnSync(process.execPath, arguments_, { cwd: siteRoot, stdio: "inherit", windowsHide: true, env: { ...process.env, ...env } });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (command === "dev") {
  const exporter = new URL("../../export/prepare_local_dataset.mjs", import.meta.url);
  if (existsSync(exporter)) {
    const { prepareLocalDataset } = await import(exporter.href);
    await prepareLocalDataset(fileURLToPath(new URL("../../", import.meta.url)));
  }
  runNode(["--import", "./scripts/sites-env.mjs", "./node_modules/wrangler/bin/wrangler.js",
    "d1", "migrations", "apply", "construction-noise-local", "--local", "--config", "wrangler.local.json",
    "--persist-to", ".wrangler/local-collab"], { CI: "true", CLOUDFLARE_API_TOKEN: "", CLOUDFLARE_ACCOUNT_ID: "" });
}

const audioCatalog = await prepareAudio();
await prepareBackend();
await prepareFrontend({ development: command === 'dev' });
console.log(`Prepared ${audioCatalog.files.length} local WAV files for ${command}.`);

// The standard build entry owns all checks; no root-level shell wrappers are needed.
if (command === "build") {
  await import("./verify-dataset.mjs");
  runNode(["--test", "tests/backend/*.test.js", "tests/frontend/*.test.js", "tests/shared/*.test.js", "tests/integration/*.test.js"]);
  runNode([fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url)), "--noEmit"]);
}

const managedLinux = readExecutionProfile() === "managed-linux";

if (managedLinux && command === "build") {
  const result = spawnSync("bash", [
    fileURLToPath(new URL("./build-verified.sh", import.meta.url)), ...args,
  ], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}

// Import in this process so the preview owner retains its PID and signals.
const cli = new URL(managedLinux
  ? "../node_modules/vite/bin/vite.js"
  : "../node_modules/vinext/dist/cli.js", import.meta.url);
process.argv = [process.execPath, fileURLToPath(cli), command,
  ...(!managedLinux && command === "dev" ? ["--port", "5173"] : []), ...args];
await import(cli.href);
