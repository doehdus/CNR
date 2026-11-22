import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { localPath } from '../shared/research/dataset.js';
import { normalizeBpfPrefilter } from '../shared/research/prefilter-bpf-data.js';

const defaultSiteRoot = fileURLToPath(new URL('../', import.meta.url));

// Builds consume only the exported snapshot. They never inspect experiment/.
export async function prepareAudio(siteRoot = defaultSiteRoot) {
  const root = await realpath(siteRoot);
  const audioRoot = path.join(root, 'public/dataset/audio');
  let catalog;
  try {
    catalog = JSON.parse(await readFile(path.join(audioRoot, 'catalog.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, files: [] };
    throw error;
  }
  if (await realpath(audioRoot) !== audioRoot || catalog.version !== 1 || !Array.isArray(catalog.files)) throw new Error('내보낸 음원 목록을 확인하세요.');
  const seen = new Set();
  for (const file of catalog.files) {
    const relative = localPath(file.path);
    if (relative !== file.path || seen.has(relative) || !Number.isSafeInteger(file.size) || file.size < 12 || !/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error('내보낸 음원 경로·크기·지문을 확인하세요.');
    seen.add(relative);
    const target = path.join(audioRoot, relative);
    if (await realpath(target) !== target) throw new Error('내보낸 음원은 실제 파일이어야 합니다.');
    const bytes = await readFile(target);
    if (bytes.length !== file.size || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
      throw new Error(`${relative}: 내보낸 음원이 변경되었습니다. export_results.py를 다시 실행하세요.`);
    }
  }
  // Keep the complete local dataset; publish only the active raw/BPF pair.
  // Historical gain-matched listening copies remain available in the source snapshot.
  let bpf;
  try { bpf = normalizeBpfPrefilter(JSON.parse(await readFile(path.join(root, 'public/dataset/prefilter_bpf/results.json'), 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const archived = new Set(bpf?.conditions.map(row => row.comparison_input_path) || []);
  return { ...catalog, files: catalog.files.filter(file => !archived.has(file.path)) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  console.log(`Verified ${(await prepareAudio()).files.length} exported WAV files.`);
}
