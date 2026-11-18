import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { configureToolEnvironment } from './tool-environment.mjs';

export const localSiteRoot = fileURLToPath(new URL('../', import.meta.url));
export const localStateDirectory = path.join(localSiteRoot, '.wrangler/local-collab');

export function runLocalNode(args, { cwd = localSiteRoot, stdio = 'inherit', env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio, windowsHide: true, env: {
      ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || ''),
      WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false', ...env,
    } });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('Local command failed with exit code ' + code)));
  });
}

export async function initializeLocalDatabase({ stateDirectory = localStateDirectory } = {}) {
  configureToolEnvironment(localSiteRoot);
  const relative = path.relative(localSiteRoot, stateDirectory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Local database must stay inside this checkout.');
  await mkdir(stateDirectory, { recursive: true });
  await runLocalNode(['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js',
    'd1', 'migrations', 'apply', 'construction-noise-local', '--local', '--config', 'wrangler.local.json', '--persist-to', stateDirectory], {
    env: { CI: 'true', CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_ACCOUNT_ID: '' },
  });
}
