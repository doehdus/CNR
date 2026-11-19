// Only completed measured analysis is delivered. No DSP runs during web preparation.
import { readFile, realpath } from 'node:fs/promises';
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
