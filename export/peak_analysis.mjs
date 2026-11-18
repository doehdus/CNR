// Only completed measured analysis is delivered. No DSP runs during web preparation.
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizePeakAnalysis, peakSourcePath } from '../website/shared/research/peak-analysis-data.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function loadPeakAnalysis(root) {
  let bytes;
  try { bytes = await readFile(path.join(root, 'experiment/outputs/peak_analysis/results.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const data = normalizePeakAnalysis(JSON.parse(bytes));
  const files = [];
  for (const file of data.files) {
    const filename = path.join(root, peakSourcePath(file.path));
    if (await realpath(filename) !== filename) throw new Error('Analysis inputs must not be symlinks.');
    const content = await readFile(filename);
    if (digest(content) !== file.sha256 || content.length !== file.size) throw new Error('피크 분석 이후 음원이 변경되었습니다: ' + file.path);
    files.push({ ...file, bytes: content });
  }
  return { data, files, sha256: digest(bytes) };
}
export async function deliverPeakAnalysis(stage, analysis, catalogFiles) {
  if (!analysis) return;
  const entries = new Map(catalogFiles.map(file => [file.path, file]));
  for (const { bytes, source, ...file } of analysis.files) {
    if (entries.has(file.path) && entries.get(file.path).sha256 !== file.sha256) throw new Error('기존 스냅샷의 음원과 피크 분석 입력이 다릅니다.');
    const filename = path.join(stage, 'audio', file.path);
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, bytes);
    entries.set(file.path, file);
  }
  catalogFiles.splice(0, catalogFiles.length, ...[...entries.values()].sort((a, b) => a.path.localeCompare(b.path)));
  await mkdir(path.join(stage, 'peak_analysis'), { recursive: true });
  await writeFile(path.join(stage, 'peak_analysis/results.json'), JSON.stringify(analysis.data));
}
