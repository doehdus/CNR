import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localPath, normalizeManifest, normalizeNoiseSources } from '../shared/research/dataset.js';

const defaultSiteRoot = fileURLToPath(new URL('../', import.meta.url));
const MAX_ASSET_SIZE = 25 * 1024 * 1024;

async function exists(filename) {
  try { await access(filename); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function prepareAudio(siteRoot = defaultSiteRoot) {
  siteRoot = await realpath(siteRoot);
  const projectRoot = path.resolve(siteRoot, '..');
  const publicRoot = path.resolve(siteRoot, 'public');
  const audioRoot = path.resolve(publicRoot, 'research-audio');
  if (path.relative(publicRoot, audioRoot) !== 'research-audio') throw new Error('음원 배포 경로를 확인하세요.');
  if (await realpath(publicRoot) !== publicRoot || (await exists(audioRoot) && await realpath(audioRoot) !== audioRoot)) {
    throw new Error('음원 배포 폴더는 이 사이트 안의 실제 폴더여야 합니다.');
  }

  // A hosted source checkout already contains the prepared audio snapshot.
  if (!await exists(path.join(projectRoot, 'PROJECT_CONTEXT.md'))) {
    const catalog = JSON.parse(await readFile(path.join(audioRoot, 'catalog.json'), 'utf8'));
    return catalog;
  }

  const manifestPath = path.join(projectRoot, 'data/metadata/dataset.json');
  let manifest;
  if (await exists(manifestPath)) {
    manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
    normalizeManifest(manifest);
    normalizeNoiseSources(manifest.noise_sources || []);
  }

  const relativePaths = [];
  async function collect(directory) {
    if (!await exists(directory)) return;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(filename);
      else if (entry.isFile() && /\.wav$/i.test(entry.name)) {
        relativePaths.push(localPath(path.relative(projectRoot, filename).split(path.sep).join('/')));
      }
    }
  }
  for (const directory of ['data/clean', 'data/noise', 'data/mixed', 'outputs']) {
    await collect(path.join(projectRoot, directory));
  }

  const stagingRoot = path.resolve(siteRoot, '.sites-runtime');
  await mkdir(stagingRoot, { recursive: true });
  if (await realpath(stagingRoot) !== stagingRoot) throw new Error('음원 준비 폴더는 이 사이트 안에 있어야 합니다.');
  const stage = await mkdtemp(path.join(stagingRoot, 'audio-'));
  if (path.dirname(stage) !== stagingRoot) throw new Error('음원 준비 경로를 확인하세요.');
  const files = [];
  try {
    for (const relative of relativePaths.sort()) {
      const filename = path.join(projectRoot, relative);
      const before = await stat(filename);
      if (before.size > MAX_ASSET_SIZE) throw new Error(`${relative}: 배포에 포함할 WAV는 25 MiB 이하로 준비하세요.`);
      const bytes = await readFile(filename);
      const after = await stat(filename);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) {
        throw new Error(`${relative}: 파일 저장이 끝난 뒤 다시 배포하세요.`);
      }
      if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error(`${relative}: RIFF/WAVE 형식의 WAV 파일이 필요합니다.`);
      }
      const destination = path.join(stage, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      files.push({ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
    const catalog = { version: 1, files };
    await writeFile(path.join(stage, 'catalog.json'), JSON.stringify(catalog, null, 2) + '\n');
    // Only the generated audio directory inside this Site's public folder is replaced.
    await rm(audioRoot, { recursive: true, force: true });
    await rename(stage, audioRoot);
    if (manifest) {
      await mkdir(path.join(publicRoot, 'data/metadata'), { recursive: true });
      await writeFile(path.join(publicRoot, 'data/metadata/dataset.json'), JSON.stringify(manifest, null, 2) + '\n');
    }
    return catalog;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const catalog = await prepareAudio();
  console.log(`Prepared ${catalog.files.length} local WAV files for deployment.`);
}
