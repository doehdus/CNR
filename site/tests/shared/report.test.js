import test from 'node:test';
import assert from 'node:assert/strict';
import { resultRows, snrSummary } from '../../shared/research/report.js';
import { previewRating, normalizeRatings } from '../../shared/research/evaluation.js';
import { pairedSamples, correlationResults } from '../../shared/research/correlation.js';

const base = 'single_snr20_instruction_01_';
test('새 처리 결과까지 180개를 정리하고 같은 조건의 무처리와만 개선량을 계산한다', () => {
  const metrics = [{ sample_id: base + 'noisy', stoi: 0, estoi: .2 }, { sample_id: base + 'ss_pattern_update', stoi: .6, estoi: .7 }];
  const all = resultRows(metrics, []); assert.equal(all.length, 180);
  const result = all.find(row => row.sample_id === base + 'ss_pattern_update');
  assert.equal(result.delta_stoi, .6); assert.ok(Math.abs(result.delta_estoi - .5) < 1e-10);
  assert.equal(all.find(row => row.sample_id === base + 'additional').delta_stoi, null);
  assert.equal(snrSummary(metrics, 'ss_pattern_update', 'stoi')[0].count, 1);
  assert.equal(snrSummary([], 'ss_pattern_update', 'stoi')[0].mean, null);
  assert.equal(resultRows(metrics, [], { algorithm: 'additional', noise: 'single', snr: '20' }).length, 3);
});

test('입력 중 정답률은 올바른 채점 기준·정수 분모가 있어야 계산하며 0점을 보존한다', () => {
  assert.equal(previewRating({ understanding: '0', grading_version: 'v1', key_correct: '0', key_total: '3' }).key_rate, 0);
  assert.equal(previewRating({ noise: '0' }).noise, 0);
  assert.equal(previewRating({}).noise, null);
  assert.equal('understanding' in previewRating({ understanding: '10' }), false);
  for (const fields of [{ key_correct: '2', key_total: '3' }, { grading_version: 'v1', key_correct: '4', key_total: '3' }, { grading_version: 'v1', key_correct: '1', key_total: '0' }]) assert.equal(previewRating(fields).key_rate, null);
});

test('정답률 비교는 채점 기준이 섞이면 상관을 계산하지 않으며 5단계 항목은 따로 비교한다', () => {
  const ids = ['noisy', 'ss_pattern_fixed'].map(algorithm => base + algorithm);
  const ratings = normalizeRatings(ids.map((sample_id, index) => ({ sample_id, listener_id: 'P001', understanding: index * 10, noise: 10 - index * 10, naturalness: 5, grading_version: 'v' + index, key_correct: index, key_total: 1 })));
  const pairs = pairedSamples(ids.map((sample_id, index) => ({ sample_id, stoi: index, estoi: 1 - index })), ratings);
  assert.equal(correlationResults(pairs, 'noise').stoi.rho, -1);
  assert.equal(correlationResults(pairs, 'naturalness').stoi.rho, null);
  assert.match(correlationResults(pairs, 'key_rate').stoi.reason, /채점 기준/);
});
