import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePeakAnalysis, peakInputsMatch, peakSourcePath } from '../../shared/research/peak-analysis-data.js';
const measured = JSON.parse(await readFile(new URL('../../../experiment/outputs/peak_analysis/results.json', import.meta.url)));
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
  assert.equal(peakSourcePath('data/reference/instruction01.wav'), 'experiment/data/reference/instruction01.wav');
  assert.equal(peakSourcePath('data/mixed/single/snr00/warning06.wav'), 'experiment/mixtures/single/snr00/warning06.wav');
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
