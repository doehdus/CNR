import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePeakAnalysis, normalizePeakDetails, peakDetailsForWeb, peakInputsMatch, peakSourcePath, peakArtifactPath } from '../../shared/research/peak-analysis-data.js';
const measured = JSON.parse(readLegacyFixture('experiment/outputs/peak_analysis/results.json'));
test('12개 원음·3종 소음·144조건의 측정 분석과 입력 지문을 대응한다', () => {
  const d = normalizePeakAnalysis(measured);
  assert.equal(d.conditions.length, 144); assert.equal(d.files.length, 171);
  const hashes = Object.fromEntries(d.files.map(f => [f.path, f.sha256]));
  assert(peakInputsMatch(d, hashes));
  hashes['data/reference/instruction01.wav'] = '0'.repeat(64);
  assert.equal(peakInputsMatch(d, hashes), false);
  assert(d.sources.every(s => s.peaks.every(p => p.prominence_db >= 6)));
});
test('잘못된 SNR·중복 조건·손상된 스펙트럼을 표시하지 않는다', () => {
  for (const change of [d => {d.conditions[0].actual_snr_db = 99;}, d => {d.conditions[1] = d.conditions[0];}, d => {d.conditions[0].speech_db[0] = NaN;}, d => {d.sources[0].peaks[0].high_hz = -1;}]) {
    const d = structuredClone(measured); change(d); assert.throws(() => normalizePeakAnalysis(d));
  }
});
test('원본·대응 기준음·합성 경로를 구분하고 외부 경로를 거부한다', () => {
  assert.equal(peakSourcePath('data/reference/instruction01.wav'), 'data/reference/instruction01.wav');
  assert.equal(peakSourcePath('data/mixed/single/snr00/warning06.wav'), 'data/mixtures/single/snr00/warning06.wav');
  for (const p of ['../private.wav', 'data/clean/../../private.wav', 'https://example.com/a.wav']) assert.throws(() => peakSourcePath(p));
});

test('대역별 에너지는 100%로 보존되고 잘못된 요약값은 거부한다', () => {
  for (const source of measured.sources) {
    assert.equal(source.before_psd_db.length, 1025);
    assert.equal(source.after_psd_db.length, 1025);
    assert(Math.abs(source.band_energy.reduce((sum, band) => sum + band.energy_percent, 0) - 100) < 1e-6);
  }
  const broken = structuredClone(measured); broken.sources[0].band_energy[0].energy_percent += 10;
  assert.throws(() => normalizePeakAnalysis(broken));
});

test('완료된 C 계산의 회차·파일 지문·추적 구조를 검증한다', async () => {
  assert.equal(measured.engine.language, 'C');
  assert.equal(measured.engine.tool_version, 'cnr-frequency-analysis/1');
  const path = measured.sources[0].details;
  const detail = JSON.parse(readLegacyFixture('experiment/outputs/peak_analysis/' + path));
  assert.equal(normalizePeakDetails(detail, measured.engine.run_id).signal.frame_count, detail.signal.times_sec.length);
  for (const mutate of [d => { d.signal.tracking.tracks[0].points[0][0] = -1; }, d => { d.signal.tracking.tracks[0].std_hz = NaN; }, d => { d.engine.run_id = 'other'; }]) {
    const broken = structuredClone(detail); mutate(broken); assert.throws(() => normalizePeakDetails(broken, measured.engine.run_id));
  }
  for (const path of ['../private.json', 'runs/../graphs/a.png', 'runs/20261120T000000Z-12345678/details/../../private.json']) assert.throws(() => peakArtifactPath(path));
  const broken = structuredClone(measured); delete broken.artifacts[path]; assert.throws(() => normalizePeakAnalysis(broken));
});

test('웹 전달은 전체 C 기록을 보존하고 모든 궤적 통계값을 정확히 복원한다', async () => {
  const content = readLegacyFixture('experiment/outputs/peak_analysis/' + measured.sources[0].details);
  const original = JSON.parse(content);
  const compact = peakDetailsForWeb(original, 'a'.repeat(64));
  assert.equal(compact.signal.tracking.tracks.length, original.signal.tracking.tracks.length);
  assert.equal(compact.signal.psd_db, undefined);
  const broken = structuredClone(compact); broken.signal.tracking.tracks[0].pop();
  assert.throws(() => normalizePeakDetails(broken, measured.engine.run_id));
  const decoded = normalizePeakDetails(compact, measured.engine.run_id);
  for (const [index, track] of original.signal.tracking.tracks.entries()) {
    const stats = { ...track }; delete stats.points;
    assert.deepEqual(decoded.signal.tracking.tracks[index], stats);
  }
  assert(original.signal.tracking.tracks[0].points.length > 0);
});
