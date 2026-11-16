import { cp, mkdir, mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareSurvey } from './prepare-survey.mjs';

const siteRoot = fileURLToPath(new URL('../', import.meta.url));
const sharedModules = ['dataset.js', 'evaluation.js', 'metrics.js', 'correlation.js', 'report.js', 'study-tables.js'];

// Only explicitly public research modules enter the browser asset tree.
export async function prepareFrontend() {
  const runtimeRoot = path.join(siteRoot, '.sites-runtime');
  await mkdir(runtimeRoot, { recursive: true });
  if (await realpath(runtimeRoot) !== runtimeRoot) throw new Error('Runtime files must stay inside this Site.');
  const publicRoot = path.join(runtimeRoot, 'public');
  try {
    if (await realpath(publicRoot) !== publicRoot) throw new Error('Generated assets must stay inside this Site.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const stage = await mkdtemp(path.join(runtimeRoot, 'public-'));
  try {
    await cp(path.join(siteRoot, 'frontend/public'), stage, { recursive: true });
    for (const name of sharedModules) {
      await cp(path.join(siteRoot, 'shared/research', name), path.join(stage, 'website/js', name));
    }
    for (const name of ['data', 'metrics', 'research-audio']) {
      try {
        await cp(path.join(siteRoot, 'public', name), path.join(stage, name), { recursive: true });
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    await prepareSurvey(stage);
    // Both paths are resolved beneath the verified runtime directory above.
    await rm(publicRoot, { recursive: true, force: true });
    await rename(stage, publicRoot);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await prepareFrontend();
  console.log('Prepared frontend assets in .sites-runtime/public/.');
}
