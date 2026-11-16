import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));

async function readSnapshot(relative, fallback) {
  try {
    return JSON.parse((await readFile(path.join(siteRoot, relative), 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw error;
  }
}

// Data snapshots keep server inputs independent of frontend source files.
// Empty audio/metric snapshots allow code checks on a clone without WAVs.
export async function prepareBackend() {
  const runtimeRoot = path.join(siteRoot, '.sites-runtime');
  const target = path.join(runtimeRoot, 'backend');
  await mkdir(target, { recursive: true });
  if (await realpath(runtimeRoot) !== runtimeRoot || await realpath(target) !== target) {
    throw new Error('Backend snapshots must stay inside this Site.');
  }
  const dataset = await readSnapshot('public/data/metadata/dataset.json');
  const catalog = await readSnapshot('public/research-audio/catalog.json', { version: 1, files: [] });
  const metrics = await readSnapshot('public/metrics/results/stoi_estoi.json', { version: 1, metrics: [] });
  for (const [name, value] of [['dataset', dataset], ['audio-catalog', catalog], ['metrics', metrics]]) {
    await writeFile(path.join(target, name + '.json'), JSON.stringify(value, null, 2) + '\n');
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await prepareBackend();
  console.log('Prepared backend data snapshots in .sites-runtime/backend/.');
}
