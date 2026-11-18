import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareAudio } from './prepare-audio.mjs';
import { validateMetricResults } from './validate-metric-results.mjs';
import { normalizeManifest, normalizeNoiseSources } from '../shared/research/dataset.js';
import { metricMatchesInputs } from '../shared/research/study-tables.js';
import { normalizeNoiseAnalysis, noiseAnalysisMatches, noiseAnalysisImages } from '../shared/research/noise-analysis-data.js';
import { normalizeCleanCollection, collectionMatches } from '../shared/research/collection-data.js';

const manifest = JSON.parse(await readFile(new URL('../public/dataset/manifest.json', import.meta.url), 'utf8'));
const rows = validateMetricResults(JSON.parse(await readFile(new URL('../public/dataset/results.json', import.meta.url), 'utf8')), { allowEmpty: manifest.samples.every(sample => sample.kind === 'clean') });
const catalog = await prepareAudio();
const paths = normalizeManifest(manifest);
const fingerprints = Object.fromEntries(catalog.files.map(file => [file.path, file.sha256]));
for (const row of rows) {
  if (!metricMatchesInputs(row, paths, fingerprints)) throw new Error(`${row.sample_id}: 내보낸 음원과 지표가 일치하지 않습니다.`);
}
console.log(`Verified exported dataset: ${catalog.files.length} WAV files, ${rows.length} metric rows.`);

let collection = null;
try { collection = JSON.parse(await readFile(new URL('../public/dataset/collection.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (collection !== null) {
  const data = normalizeCleanCollection(collection);
  for (const recording of data.recordings) {
    if (!collectionMatches(recording, fingerprints)) throw new Error('새 원음의 파일 지문이 내보낸 WAV와 일치하지 않습니다.');
  }
  console.log(`Verified clean collection: ${data.recordings.length} recordings.`);
}

// Optional analysis output is read and verified; the web build never runs analysis.
let noiseAnalysis = null;
try {
  noiseAnalysis = JSON.parse(await readFile(new URL('../public/dataset/noise_analysis/results.json', import.meta.url), 'utf8'));
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (noiseAnalysis !== null) {
  const data = normalizeNoiseAnalysis(noiseAnalysis), noisePaths = normalizeNoiseSources(manifest.noise_sources || []);
  const pathFor = sample => (sample.kind === 'noise' ? noisePaths[sample.id] : paths[sample.id]) || sample.path;
  for (const record of [...data.sources, ...data.mixtures, ...(data.overview ? [data.overview] : [])]) {
    if (!noiseAnalysisMatches(record, pathFor, fingerprints)) throw new Error('소음 분석 자료의 입력 지문이 내보낸 WAV와 일치하지 않습니다.');
  }
  for (const image of noiseAnalysisImages(data)) {
    const target = new URL('../public/dataset/noise_analysis/' + image, import.meta.url);
    if (await realpath(target) !== fileURLToPath(target)) throw new Error('소음 분석 그래프는 배포 자료 안의 실제 파일이어야 합니다.');
    if (noiseAnalysis.artifacts && createHash('sha256').update(await readFile(target)).digest('hex') !== noiseAnalysis.artifacts[image]) throw new Error('소음 분석 그래프가 내보낸 시점의 파일과 일치하지 않습니다.');
  }
  console.log(`Verified noise analysis: ${data.sources.length} sources, ${data.mixtures.length} mixture comparisons.`);
}
