import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNoiseAnalysis, noiseAnalysisAsset, noiseAnalysisImages, noiseAnalysisMatches } from '../../shared/research/noise-analysis-data.js';

const hash = character => character.repeat(64);
function fixture() {
  return { version: 1, sources: [{
    noise: 'single', inputs: [{ sample_id: 'noise_single', sha256: hash('a') }],
    analysis: { method: 'full_fft', sample_rate_hz: 16000, sample_count: 16000, fft_size: 16384, window_function: 'fixture', magnitude_reference: 'fixture full scale', peak_rule: 'fixture prominence rule' },
    spectrum_image: 'graphs/single/spectrum.png', peaks_image: 'graphs/single/peaks.png', summary: '검증용 자료',
    peaks: [{ id: 'p1', frequency_hz: 1000, magnitude_db: -12, bandwidth_hz: null, prominence_db: 0, zoom_image: 'graphs/single/p1.png' }],
    candidates: [{ low_hz: 990, high_hz: 1010, reason: '검증용 근거', speech_overlap: 'unknown', judgment: 'review' }],
  }], mixtures: [{
    noise: 'single', snr: 10, statement: 'instruction_01',
    inputs: [{ sample_id: 'noise_single', sha256: hash('a') }, { sample_id: 'clean_instruction_01', sha256: hash('b') }, { sample_id: 'single_snr10_instruction_01_noisy', sha256: hash('c') }],
    spectrum_image: 'graphs/single/instruction_01-snr10.png', comparison_basis: '검증용 공통 구간·크기 기준',
    observations: [{ peak_id: 'p1', mixture_frequency_hz: null, speech_overlap: 'unknown' }],
  }] };
}

test('소음 분석 자료가 없으면 빈 상태이며 0점·음수·미확인 관찰을 구분한다', () => {
  assert.deepEqual(normalizeNoiseAnalysis(null), { version: 1, sources: [], mixtures: [], overview: null });
  const data = normalizeNoiseAnalysis(fixture());
  assert.equal(data.sources[0].peaks[0].magnitude_db, -12);
  assert.equal(data.sources[0].peaks[0].prominence_db, 0);
  assert.equal(data.sources[0].peaks[0].bandwidth_hz, null);
  assert.equal(data.mixtures[0].observations[0].mixture_frequency_hz, null);
  const input = fixture(); input.mixtures[0].observations[0].mixture_frequency_hz = 0;
  assert.equal(normalizeNoiseAnalysis(input).mixtures[0].observations[0].mixture_frequency_hz, 0);
});

test('전체 FFT·주파수 범위·피크와 후보의 근거를 검증하고 미등록을 0개로 바꾸지 않는다', () => {
  for (const mutate of [
    input => { input.sources[0].analysis.method = 'welch'; },
    input => { input.sources[0].analysis.fft_size = 256; },
    input => { input.sources[0].peaks[0].frequency_hz = 8001; },
    input => { input.sources[0].candidates[0].high_hz = 8001; },
    input => { input.sources[0].candidates[0].reason = ''; },
    input => { delete input.sources[0].peaks; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => normalizeNoiseAnalysis(input), /소음 분석 자료/); }
  const input = fixture(); input.sources[0].peaks = []; input.mixtures = [];
  assert.deepEqual(normalizeNoiseAnalysis(input).sources[0].peaks, []);
});

test('소음·원음·합성음원의 세 입력 중 하나라도 바뀌면 기존 분석을 표시하지 않는다', () => {
  const data = normalizeNoiseAnalysis(fixture()), pathFor = sample => sample.path;
  const fingerprints = { 'data/noise/single.wav': hash('a'), 'data/clean/instruction_01.wav': hash('b'), 'data/mixed/single/snr10/instruction_01.wav': hash('c') };
  assert.equal(noiseAnalysisMatches(data.sources[0], pathFor, fingerprints), true);
  assert.equal(noiseAnalysisMatches(data.mixtures[0], pathFor, fingerprints), true);
  fingerprints['data/clean/instruction_01.wav'] = hash('d');
  assert.equal(noiseAnalysisMatches(data.sources[0], pathFor, fingerprints), true);
  assert.equal(noiseAnalysisMatches(data.mixtures[0], pathFor, fingerprints), false);
  assert.equal(noiseAnalysisMatches(data.sources[0], () => 'data/noise/replaced.wav', fingerprints), false);
  assert.equal(noiseAnalysisMatches(null, pathFor, fingerprints), false);
});

test('전체 FFT 등록과 피크 검출 완료를 구분하고 대기 상태를 0개로 표시하지 않는다', () => {
  const input = fixture(); input.sources[0].peaks = null;
  assert.throws(() => normalizeNoiseAnalysis(input), /피크 ID/);
  input.mixtures = [];
  input.sources[0].peaks_image = null;
  const pending = normalizeNoiseAnalysis(input);
  assert.equal(pending.sources[0].peaks, null);
  assert.deepEqual(noiseAnalysisImages(pending), ['graphs/single/spectrum.png']);
  input.sources[0].peaks = [];
  assert.deepEqual(normalizeNoiseAnalysis(input).sources[0].peaks, []);
});

test('합성 비교의 다른 소음·문장·SNR 바꿔치기와 존재하지 않는 피크 연결을 거부한다', () => {
  for (const mutate of [
    input => { input.sources[0].inputs[0].sample_id = 'noise_complex'; },
    input => { input.mixtures[0].snr = 0; },
    input => { input.mixtures[0].inputs[1].sample_id = 'clean_warning_01'; },
    input => { input.mixtures[0].observations[0].peak_id = 'missing'; },
    input => { input.mixtures.push(structuredClone(input.mixtures[0])); },
    input => { input.sources.push(structuredClone(input.sources[0])); },
  ]) { const input = fixture(); mutate(input); assert.throws(() => normalizeNoiseAnalysis(input), /소음 분석 자료/); }
});

test('그래프는 분석 자료의 상대 경로만 허용하고 등록된 모든 이미지 경로를 모은다', () => {
  for (const value of ['https://example.com/plot.png', '/graphs/plot.png', 'graphs/../plot.png', 'graphs/%2e%2e/plot.png', 'graphs/x.png?key=value', 'graphs//plot.png', 'graphs/.private/plot.png']) assert.throws(() => noiseAnalysisAsset(value));
  assert.equal(noiseAnalysisAsset(null), null);
  assert.deepEqual(noiseAnalysisImages(normalizeNoiseAnalysis(fixture())), ['graphs/single/spectrum.png', 'graphs/single/peaks.png', 'graphs/single/p1.png', 'graphs/single/instruction_01-snr10.png']);
  const input = fixture(); input.overview = { inputs: input.sources[0].inputs, spectrum_image: 'graphs/comparison.png', comparison_basis: '검증용' };
  assert.throws(() => normalizeNoiseAnalysis(input), /입력 음원/);
});
