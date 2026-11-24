import { researchPath } from './research_paths.mjs';
// Validate and deliver completed C summaries; no signal calculations run here.
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeMixtureSummary, mixtureSummaryMatches, normalizeSNRComparison, normalizePeakComparison } from '../website/shared/research/mixture-summary-data.js';
import { peakArtifactPath, peakSourcePath } from '../website/shared/research/peak-analysis-data.js';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export async function loadMixtureSummary(root) {
  root = await realpath(root);
  const output = researchPath(root, 'analysis/results/mixture_summary');
  let bytes;
  try { bytes = await readFile(path.join(output, 'results.json')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const data = normalizeMixtureSummary(JSON.parse(bytes));
  const analysisBytes = await readFile(researchPath(root, 'analysis/results/peak_analysis/results.json'));
  const analysis = JSON.parse(analysisBytes);
  analysis.delivery = { source_sha256: digest(analysisBytes) };
  const fingerprints = Object.fromEntries(analysis.files.map(file => [file.path, file.sha256]));
  if (!mixtureSummaryMatches(data, analysis, fingerprints)) throw Error('평균 분석과 원본 분석 회차·지문이 다릅니다.');
  const interval = await readFile(researchPath(root, 'data/preparation/tables/mixtures.csv'));
  if (digest(interval) !== data.interval_metadata_sha256) throw Error('평균 분석의 등록 발화 구간이 변경되었습니다.');
  for (const file of data.files) {
    const filename = researchPath(root, peakSourcePath(file.path));
    if (await realpath(filename) !== filename) throw Error('Summary inputs must be regular project files.');
    const contents = await readFile(filename);
    if (contents.length !== file.size || digest(contents) !== file.sha256) throw Error('평균 분석 이후 입력 음원이 변경되었습니다.');
  }
  const artifacts = [];
  for (const [relative, expected] of Object.entries(data.artifacts)) {
    peakArtifactPath(relative);
    const filename = path.join(output, relative);
    if (await realpath(filename) !== filename) throw Error('Summary artifacts must stay inside the output directory.');
    const contents = await readFile(filename);
    if (digest(contents) !== expected || !contents.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('평균 그래프 지문·PNG 형식을 확인하세요.');
    artifacts.push({ path: relative, bytes: contents });
  }
  let comparison = null, comparisonBytes = Buffer.alloc(0);
  const comparisonArtifacts = [];
  try { comparisonBytes = await readFile(path.join(output, 'snr_comparison.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (comparisonBytes.length) {
    comparison = normalizeSNRComparison(JSON.parse(comparisonBytes), data, digest(bytes));
    for (const [relative, expected] of Object.entries(comparison.artifacts)) {
      const filename = path.join(output, relative);
      if (await realpath(filename) !== filename) throw Error('SNR plots must stay inside the output directory.');
      const contents = await readFile(filename);
      if (digest(contents) !== expected || !contents.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('SNR 비교 그래프 지문·PNG 형식을 확인하세요.');
      comparisonArtifacts.push({ path: relative, bytes: contents });
    }
  }
  let peakComparison = null, peakBytes = Buffer.alloc(0);
  const peakArtifacts = [];
  try { peakBytes = await readFile(path.join(output, 'peak_comparison.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (peakBytes.length) {
    peakComparison = normalizePeakComparison(JSON.parse(peakBytes), data, digest(bytes));
    if (peakComparison.source_analysis_sha256 !== digest(analysisBytes)) throw Error('피크 비교와 개별 분석 출처가 다릅니다.');
    for (const [relative, expected] of Object.entries(peakComparison.detail_hashes)) {
      const filename = researchPath(root, 'analysis/results/peak_analysis', relative);
      if (analysis.artifacts[relative] !== expected || await realpath(filename) !== filename || digest(await readFile(filename)) !== expected) throw Error('피크 비교의 기존 추적 자료 지문이 다릅니다.');
    }
    for (const [relative, expected] of Object.entries(peakComparison.period_hashes)) {
      const filename = path.join(output, relative);
      if (await realpath(filename) !== filename || digest(await readFile(filename)) !== expected) throw Error('Changing 구간별 계산 자료 지문이 다릅니다.');
    }
    for (const [relative, expected] of Object.entries(peakComparison.artifacts)) {
      const filename = path.join(output, relative);
      if (await realpath(filename) !== filename) throw Error('Peak plots must stay inside the output directory.');
      const contents = await readFile(filename);
      if (digest(contents) !== expected || !contents.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('피크 비교 그래프 지문·PNG 형식을 확인하세요.');
      peakArtifacts.push({ path: relative, bytes: contents });
    }
  }
  return { data, artifacts, comparison, comparisonArtifacts, peakComparison, peakArtifacts, source_sha256: digest(bytes), sha256: digest(Buffer.concat([bytes, comparisonBytes, peakBytes])) };
}

export async function deliverMixtureSummary(summary, stage) {
  const destination = path.join(stage, 'mixture_summary');
  for (const file of [...summary.artifacts, ...(summary.comparisonArtifacts || []), ...(summary.peakArtifacts || [])]) {
    const filename = path.join(destination, file.path);
    await mkdir(path.dirname(filename), { recursive: true }); await writeFile(filename, file.bytes);
  }
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, 'results.json'), JSON.stringify({ ...summary.data, delivery: { source_sha256: summary.source_sha256 } }) + '\n');
  if (summary.comparison) await writeFile(path.join(destination, 'snr_comparison.json'), JSON.stringify(summary.comparison) + '\n');
  if (summary.peakComparison) await writeFile(path.join(destination, 'peak_comparison.json'), JSON.stringify(summary.peakComparison) + '\n');
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args[0] !== '--root' || args[2] !== '--destination' || args.length !== 4) throw Error('Expected --root PROJECT --destination STAGE');
  const summary = await loadMixtureSummary(args[1]);
  if (summary) await deliverMixtureSummary(summary, args[3]);
  console.log(JSON.stringify({ groups: summary?.data.groups.length || 0 }));
}
