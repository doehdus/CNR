import { createHash } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeLocalDatabase, localSiteRoot, runLocalNode } from './init-local-db.mjs';

export async function prepareLocalDevelopment() {
  const repositoryRoot = path.dirname(localSiteRoot);
  const exporter = path.join(repositoryRoot, 'export/prepare_local_dataset.mjs');
  try {
    await access(exporter);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await access(path.join(localSiteRoot, 'public/dataset/collection.json'));
    await initializeLocalDatabase();
    return;
  }
  const { prepareLocalDataset } = await import(pathToFileURL(exporter));
  await prepareLocalDataset(repositoryRoot);
  await initializeLocalDatabase();
}

async function ensureDependencies({ install = false } = {}) {
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or later is required.');
  const repositoryRoot = path.dirname(localSiteRoot), cache = path.join(repositoryRoot, '.cache/local');
  const lock = await readFile(path.join(localSiteRoot, 'package-lock.json'));
  const digest = createHash('sha256').update(lock).update(process.version + process.platform + process.arch).digest('hex');
  const stamp = path.join(cache, 'dependencies.sha256');
  let installed = false;
  try { installed = (await readFile(stamp, 'utf8')).trim() === digest; await access(path.join(localSiteRoot, 'node_modules/vinext/package.json')); }
  catch { installed = false; }
  if (installed) return;
  if (!install) throw new Error('Web dependencies need preparation. Nothing was installed. To choose installation, run: bash scripts/dev-local.sh --install');
  const npm = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
  await runLocalNode([npm, 'ci', '--no-audit', '--no-fund'], { env: { npm_config_cache: path.join(repositoryRoot, '.cache/npm') } });
  await mkdir(cache, { recursive: true });
  await writeFile(stamp, digest + '\n');
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  if ([...flags].some(flag => !['--install', '--prepare-only', '--check'].includes(flag)) || flags.has('--prepare-only') && flags.has('--check')) throw new Error('Usage: local-setup.mjs [--install] [--prepare-only|--check]');
  await ensureDependencies({ install: flags.has('--install') });
  await prepareLocalDevelopment();
  if (flags.has('--prepare-only')) { console.log('Local data and database are ready.'); return; }
  if (flags.has('--check')) {
    const datasetTest = path.join(path.dirname(localSiteRoot), 'export/tests/local-dataset.test.mjs');
    let hasDatasetTest = true;
    try { await access(datasetTest); } catch (error) { if (error.code !== 'ENOENT') throw error; hasDatasetTest = false; }
    if (hasDatasetTest) await runLocalNode(['--test', datasetTest]);
    const npm = path.resolve(path.dirname(process.execPath), process.platform === 'win32' ? 'node_modules/npm/bin/npm-cli.js' : '../lib/node_modules/npm/bin/npm-cli.js');
    await runLocalNode([npm, 'run', 'build']);
    await runLocalNode(['scripts/smoke-local.mjs']);
    return;
  }
  console.log('Starting local development at http://localhost:5173/website/');
  await runLocalNode(['scripts/run-framework.mjs', 'dev']);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
