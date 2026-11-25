import { normalizePeakAnalysis, normalizePeakDetails, peakInputsMatch } from '../shared/research/peak-analysis-data.js';
import { normalizeMixtureSummary, mixtureSummaryMatches, normalizeSNRComparison, normalizePeakComparison } from '../shared/research/mixture-summary-data.js';
import { normalizePrefilterInitial, prefilterMatchesAnalysis } from '../shared/research/prefilter-data.js';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareAudio } from './prepare-audio.mjs';
import { validateMetricResults } from './validate-metric-results.mjs';
import { normalizeManifest, normalizeNoiseSources } from '../shared/research/dataset.js';
import { metricMatchesInputs } from '../shared/research/study-tables.js';
import { normalizeNoiseAnalysis, noiseAnalysisMatches, noiseAnalysisImages } from '../shared/research/noise-analysis-data.js';
import { normalizeCleanCollection, collectionMatches } from '../shared/research/collection-data.js';
import { normalizeListeningAssignment } from '../shared/research/prefilter-listening-data.js';

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

let peakAnalysis = null;
try { peakAnalysis = JSON.parse(await readFile(new URL('../public/dataset/peak_analysis/results.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (peakAnalysis) {
  const data = normalizePeakAnalysis(peakAnalysis);
  if (data.prefilter_initial && !prefilterMatchesAnalysis(normalizePrefilterInitial(data.prefilter_initial), data)) throw new Error('초기 EQ 설정과 내보낸 분석 회차·지문이 일치하지 않습니다.');
  if (!peakInputsMatch(data, fingerprints)) throw new Error('피크 분석과 내보낸 원본·기준음·합성음의 지문이 일치하지 않습니다.');
  for (const [relative, hash] of Object.entries(data.artifacts || {})) {
    const target = new URL('../public/dataset/peak_analysis/' + relative, import.meta.url);
    if (await realpath(target) !== fileURLToPath(target)) throw new Error('C 분석 파일은 배포 자료 내부에 있어야 합니다.');
    const content = await readFile(target);
    if (createHash('sha256').update(content).digest('hex') !== hash) throw new Error('C 분석 결과 파일 지문이 일치하지 않습니다.');
    if (relative.endsWith('.json')) normalizePeakDetails(JSON.parse(content), data.engine.run_id);
  }
  console.log(`Verified peak analysis: ${data.sources.length} noises, ${data.conditions.length} comparisons.`);
}

let summary = null;
try { summary = JSON.parse(await readFile(new URL('../public/dataset/mixture_summary/results.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (summary) {
  normalizeMixtureSummary(summary);
  if (!mixtureSummaryMatches(summary, peakAnalysis, fingerprints)) throw Error('평균 분석과 내보낸 입력·원본 분석이 다릅니다.');
  for (const [relative, expected] of Object.entries(summary.artifacts)) {
    const target = new URL('../public/dataset/mixture_summary/' + relative, import.meta.url);
    if (await realpath(target) !== fileURLToPath(target)) throw Error('평균 그래프는 배포 자료 내부에 있어야 합니다.');
    const bytes = await readFile(target);
    if (createHash('sha256').update(bytes).digest('hex') !== expected || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('평균 그래프 지문·형식이 다릅니다.');
  }
  console.log(`Verified mixture summary: ${summary.groups.length} groups, 144 conditions.`);
  let comparison = null;
  try { comparison = JSON.parse(await readFile(new URL('../public/dataset/mixture_summary/snr_comparison.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (comparison) {
    normalizeSNRComparison(comparison, summary);
    for (const [relative, expected] of Object.entries(comparison.artifacts)) {
      const target = new URL('../public/dataset/mixture_summary/' + relative, import.meta.url);
      if (await realpath(target) !== fileURLToPath(target)) throw Error('SNR 비교 그래프 경로를 확인하세요.');
      const bytes = await readFile(target);
      if (createHash('sha256').update(bytes).digest('hex') !== expected || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('SNR 비교 그래프 지문·형식이 다릅니다.');
    }
    console.log('Verified SNR comparison: 3 plots, 4 unchanged curves each.');
  }
  let peakComparison = null;
  try { peakComparison = JSON.parse(await readFile(new URL('../public/dataset/mixture_summary/peak_comparison.json', import.meta.url), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (peakComparison) {
    normalizePeakComparison(peakComparison, summary);
    for (const [relative, expected] of Object.entries(peakComparison.artifacts)) {
      const target = new URL('../public/dataset/mixture_summary/' + relative, import.meta.url);
      if (await realpath(target) !== fileURLToPath(target)) throw Error('피크 비교 그래프 경로를 확인하세요.');
      const bytes = await readFile(target);
      if (createHash('sha256').update(bytes).digest('hex') !== expected || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw Error('피크 비교 그래프 지문·형식이 다릅니다.');
    }
    console.log('Verified peak comparisons: 9 graphs, 12 whole groups + 8 Changing segments.');
  }
}
import { normalizeFixedPrefilter, fixedPrefilterInputsMatch } from '../shared/research/prefilter-fixed-data.js';

let fixedPrefilter = null;
try { fixedPrefilter = JSON.parse(await readFile(new URL('../public/dataset/prefilter/results.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (fixedPrefilter) {
  normalizeFixedPrefilter(fixedPrefilter);
  if (!fixedPrefilter.archived && !fixedPrefilterInputsMatch(fixedPrefilter, fingerprints)) throw Error('Fixed EQ audio fingerprints differ from the exported catalog.');
  console.log(fixedPrefilter.archived ? 'Verified archived Peaking EQ metadata; WAVs preserved in experiment outputs.' : 'Verified fixed Peaking EQ: 144 input/output pairs.');
}
import { normalizeBpfPrefilter, bpfPrefilterInputsMatch } from '../shared/research/prefilter-bpf-data.js';
let bpfPrefilter = null;
try { bpfPrefilter = JSON.parse(await readFile(new URL('../public/dataset/prefilter_bpf/results.json',import.meta.url),'utf8')); }
catch(error) { if(error.code !== 'ENOENT') throw error; }
if(fixedPrefilter?.archived && !bpfPrefilter) throw Error('Archived EQ requires the completed replacement BPF snapshot.');
if(bpfPrefilter) {
  normalizeBpfPrefilter(bpfPrefilter);
  if(!bpfPrefilterInputsMatch(bpfPrefilter,fingerprints)) throw Error('BPF comparison audio fingerprints differ.');
  for(const [name,sha] of Object.entries(bpfPrefilter.artifacts)) {
    const bytes=await readFile(new URL('../public/dataset/prefilter_bpf/'+name,import.meta.url));
    if(createHash('sha256').update(bytes).digest('hex')!==sha) throw Error('BPF response artifact changed.');
  }
  console.log('Verified Butterworth BPF: 144 original/processed pairs; historical gain-matched copies are optional.');
}
import { normalizePrefilterMetrics,prefilterMetricInputsMatch,prefilterMetricBpfMatches } from '../shared/research/prefilter-metrics-data.js';
let prefilterMetrics=null;
try{prefilterMetrics=JSON.parse(await readFile(new URL('../public/dataset/prefilter_analysis/results.json',import.meta.url),'utf8'));}
catch(error){if(error.code!=='ENOENT')throw error;}
if(prefilterMetrics){
  normalizePrefilterMetrics(prefilterMetrics);
  if(!prefilterMetricInputsMatch(prefilterMetrics,fingerprints)||!prefilterMetricBpfMatches(prefilterMetrics,bpfPrefilter))throw Error('Prefilter metric sources differ from deployed audio.');
  const csv=await readFile(new URL('../public/dataset/prefilter_analysis/comparison.csv',import.meta.url));
  if(createHash('sha256').update(csv).digest('hex')!==prefilterMetrics.artifacts['comparison.csv'])throw Error('Prefilter comparison CSV changed.');
  console.log('Verified prefilter STOI/ESTOI: 144 pairs, 288 scored WAVs, 576 values.');
}
try {
 const listening=normalizeListeningAssignment(JSON.parse(await readFile(new URL('../public/dataset/prefilter_listening/assignment.json',import.meta.url),'utf8')));
 for(const group of listening.groups)for(const row of group.conditions)for(const kind of ['input','output'])if(fingerprints[row[kind+'_path']]!==row[kind+'_sha256'])throw Error('Listening assignment WAV fingerprint mismatch.');
 console.log('Verified prefilter listening: 5 groups, 30 paired conditions, 60 existing WAVs.');
}catch(e){if(e.code!=='ENOENT')throw e;}

// New SS comparisons are separate from historical evaluation catalogs and responses.
const { normalizeSSFixed, SS_METHODS } = await import('../shared/research/ss-fixed-data.js');
let ssFixed = null;
try { ssFixed = JSON.parse(await readFile(new URL('../public/dataset/ss_fixed/results.json', import.meta.url), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (ssFixed) {
  normalizeSSFixed(ssFixed);
  for (const row of ssFixed.conditions) for (const method of SS_METHODS) {
    const item = row.methods[method];
    if (fingerprints[item.path] !== item.sha256) throw Error('SS scores do not match exported audio.');
  }
  for (const [name, sha] of Object.entries(ssFixed.artifacts)) {
    const bytes = await readFile(new URL('../public/dataset/ss_fixed/' + name, import.meta.url));
    if (createHash('sha256').update(bytes).digest('hex') !== sha) throw Error('SS comparison CSV changed.');
  }
  console.log('Verified fixed SS: 288 matched triples, 576 processed WAVs and paired STOI/ESTOI.');
}
