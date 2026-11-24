import { researchPath } from './research_paths.mjs';
// Only completed measured analysis is delivered. No DSP runs during web preparation.
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizePeakAnalysis, normalizePeakDetails, peakDetailsForWeb, peakSourcePath, peakArtifactPath } from '../website/shared/research/peak-analysis-data.js';
import { normalizePrefilterInitial, prefilterMatchesAnalysis } from '../website/shared/research/prefilter-data.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function loadPeakAnalysis(root) {
  let bytes;
  try { bytes = await readFile(researchPath(root, 'analysis/results/peak_analysis/results.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const data = normalizePeakAnalysis(JSON.parse(bytes));
  let initialBytes = Buffer.alloc(0);
  try { initialBytes = await readFile(researchPath(root, 'code/config/prefilter_initial.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (initialBytes.length) {
    const initial = normalizePrefilterInitial(JSON.parse(initialBytes));
    if (prefilterMatchesAnalysis(initial, data, digest(bytes))) data.prefilter_initial = initial;
  }
  const files = [];
  for (const file of data.files) {
    const filename = researchPath(root, peakSourcePath(file.path));
    if (await realpath(filename) !== filename) throw new Error('Analysis inputs must not be symlinks.');
    const content = await readFile(filename);
    if (digest(content) !== file.sha256 || content.length !== file.size) throw new Error('피크 분석 이후 음원이 변경되었습니다: ' + file.path);
    files.push({ ...file, bytes: content });
  }
  const artifacts = [];
  for (const [relative, expected] of Object.entries(data.artifacts || {})) {
    peakArtifactPath(relative);
    const filename = researchPath(root, 'analysis/results/peak_analysis', relative);
    if (await realpath(filename) !== filename) throw new Error('Completed analysis artifacts must not be symlinks.');
    let content = await readFile(filename);
    if (digest(content) !== expected) throw new Error('완료된 C 분석 파일이 변경되었습니다: ' + relative);
    if (relative.endsWith('.json')) {
      const detail = normalizePeakDetails(JSON.parse(content), data.engine.run_id);
      const observations = data.conditions.find(row => row.details === relative)?.observations || [];
      content = Buffer.from(JSON.stringify(peakDetailsForWeb(detail, expected, observations)) + '\n');
      data.artifacts[relative] = digest(content);
    } else if (!content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('A valid completed PNG is required.');
    artifacts.push({ path: relative, bytes: content });
  }
  if (data.engine) data.delivery = { version:1, format:'track-summaries', source_sha256:digest(bytes) };
  return { data, files, artifacts, sha256: digest(Buffer.concat([bytes,Buffer.from('web-track-summaries/2'),initialBytes])) };
}
