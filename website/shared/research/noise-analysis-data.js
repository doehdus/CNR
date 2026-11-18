import { NOISES, NOISE_SOURCES, STATEMENTS, SNRS, SAMPLE_INDEX, conditionId } from './dataset.js';

const sourceIndex = new Map(NOISE_SOURCES.map(source => [source.id, source]));
const noiseIds = new Set(NOISES.map(noise => noise.id));
const overlaps = new Set(['weak', 'present', 'unknown']);
const judgments = new Set(['candidate', 'review', 'hold']);
const fail = message => { throw new Error('소음 분석 자료: ' + message); };
const text = (value, required = false) => {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string' || required && !value.trim()) fail('설명과 분석 조건을 확인하세요.');
  return value.trim();
};
const numeric = (value, nullable = false) => {
  if (nullable && (value === undefined || value === null)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('유효한 숫자가 필요합니다.');
  return value;
};
const rows = value => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) fail('목록은 배열이어야 합니다.');
  return value;
};
const choice = (value, allowed) => {
  if (!allowed.has(value)) fail('관찰 결과의 분류를 확인하세요.');
  return value;
};

export function noiseAnalysisAsset(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^graphs\/[a-zA-Z0-9_./-]+\.(png|svg|webp)$/i.test(value) || value.split('/').some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) fail('그래프는 분석 자료 안의 graphs/ 상대 경로여야 합니다.');
  return value;
}

function inputs(value, expected) {
  const result = rows(value);
  if (result.length !== expected.length || new Set(result.map(row => row?.sample_id)).size !== result.length) fail('입력 음원과 파일 지문이 필요합니다.');
  return result.map(row => {
    if (!row || !expected.includes(row.sample_id) || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(row.sha256)) fail('선택한 소음·문장의 입력 지문을 확인하세요.');
    return { sample_id: row.sample_id, sha256: row.sha256 };
  });
}

function parameters(value) {
  if (!value || value.method !== 'full_fft') fail('소음 전체를 대상으로 한 full_fft 분석 조건이 필요합니다.');
  const result = { method: 'full_fft', sample_rate_hz: numeric(value.sample_rate_hz), sample_count: numeric(value.sample_count), fft_size: numeric(value.fft_size), window_function: text(value.window_function, true), magnitude_reference: text(value.magnitude_reference, true), peak_rule: text(value.peak_rule, true) };
  if (![result.sample_rate_hz, result.sample_count, result.fft_size].every(number => Number.isSafeInteger(number) && number > 0) || result.fft_size < result.sample_count) fail('전체 음원의 샘플 수·FFT 크기·샘플링 주파수를 확인하세요.');
  return result;
}

export function normalizeNoiseAnalysis(input) {
  if (input === null || input === undefined) return { version: 1, sources: [], mixtures: [], overview: null };
  if (!input || input.version !== 1) fail('version: 1 형식이 필요합니다.');
  const seen = new Set();
  const sources = rows(input.sources).map(row => {
    if (!row || !noiseIds.has(row.noise) || seen.has(row.noise)) fail('소음 ID가 없거나 중복되었습니다.');
    seen.add(row.noise);
    const analysis = parameters(row.analysis), nyquist = analysis.sample_rate_hz / 2, peakIds = new Set();
    if (row.peaks !== null && !Array.isArray(row.peaks)) fail('피크 검출 대기는 null, 검출 완료 결과는 배열로 명시하세요.');
    const peaks = row.peaks === null ? null : rows(row.peaks).map(peak => {
      if (!peak || typeof peak.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(peak.id) || peakIds.has(peak.id)) fail('피크 ID가 없거나 중복되었습니다.');
      peakIds.add(peak.id);
      const frequency = numeric(peak.frequency_hz), bandwidth = numeric(peak.bandwidth_hz, true), prominence = numeric(peak.prominence_db, true);
      if (frequency < 0 || frequency > nyquist || bandwidth !== null && (bandwidth < 0 || bandwidth > nyquist) || prominence !== null && prominence < 0) fail('피크 주파수·폭·돌출 정도의 범위를 확인하세요.');
      return { id: peak.id, frequency_hz: frequency, magnitude_db: numeric(peak.magnitude_db), bandwidth_hz: bandwidth, prominence_db: prominence, zoom_image: noiseAnalysisAsset(peak.zoom_image), note: text(peak.note) };
    });
    const candidates = rows(row.candidates).map(candidate => {
      if (!candidate) fail('후보 대역을 확인하세요.');
      const low = numeric(candidate.low_hz), high = numeric(candidate.high_hz);
      if (low < 0 || high <= low || high > nyquist) fail('후보 대역의 시작·끝 주파수를 확인하세요.');
      return { low_hz: low, high_hz: high, reason: text(candidate.reason, true), speech_overlap: choice(candidate.speech_overlap, overlaps), judgment: choice(candidate.judgment, judgments), stability_note: text(candidate.stability_note) };
    });
    return { noise: row.noise, inputs: inputs(row.inputs, ['noise_' + row.noise]), analysis, spectrum_image: noiseAnalysisAsset(row.spectrum_image), peaks_image: noiseAnalysisAsset(row.peaks_image), summary: text(row.summary), peaks, candidates };
  });
  const conditions = new Set();
  const mixtures = rows(input.mixtures).map(row => {
    if (!row || !seen.has(row.noise) || !SNRS.includes(row.snr) || !STATEMENTS.some(statement => statement.id === row.statement)) fail('합성음원의 소음·문장·SNR을 확인하세요.');
    const id = conditionId(row.noise, row.snr, row.statement);
    if (conditions.has(id)) fail('같은 합성 조건이 중복되었습니다.');
    conditions.add(id);
    const source = sources.find(source => source.noise === row.noise), observed = new Set();
    const observations = rows(row.observations).map(observation => {
      if (!observation || !source.peaks?.some(peak => peak.id === observation.peak_id) || observed.has(observation.peak_id)) fail('대응하는 소음 피크 ID를 확인하세요.');
      observed.add(observation.peak_id);
      const frequency = numeric(observation.mixture_frequency_hz, true);
      if (frequency !== null && (frequency < 0 || frequency > source.analysis.sample_rate_hz / 2)) fail('합성음원의 피크 주파수를 확인하세요.');
      return { peak_id: observation.peak_id, mixture_frequency_hz: frequency, speech_overlap: choice(observation.speech_overlap, overlaps), note: text(observation.note) };
    });
    return { noise: row.noise, statement: row.statement, snr: row.snr, inputs: inputs(row.inputs, ['noise_' + row.noise, 'clean_' + row.statement, id + '_noisy']), spectrum_image: noiseAnalysisAsset(row.spectrum_image), comparison_basis: text(row.comparison_basis, true), observations };
  });
  let overview = null;
  if (input.overview !== undefined && input.overview !== null) {
    overview = { inputs: inputs(input.overview.inputs, NOISE_SOURCES.map(source => source.id)), spectrum_image: noiseAnalysisAsset(input.overview.spectrum_image), comparison_basis: text(input.overview.comparison_basis, true) };
  }
  return { version: 1, sources, mixtures, overview };
}

export function noiseAnalysisMatches(record, pathFor, fingerprints) {
  return Boolean(record?.inputs?.length) && record.inputs.every(input => {
    const sample = sourceIndex.get(input.sample_id) || SAMPLE_INDEX.get(input.sample_id);
    return sample && fingerprints[pathFor(sample)] === input.sha256;
  });
}

export function noiseAnalysisImages(data) {
  return [...new Set([data.overview?.spectrum_image, ...data.sources.flatMap(source => [source.spectrum_image, source.peaks_image, ...(source.peaks || []).map(peak => peak.zoom_image)]), ...data.mixtures.map(mixture => mixture.spectrum_image)].filter(Boolean))];
}
