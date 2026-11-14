import test from 'node:test';
import assert from 'node:assert/strict';
import { objectiveComparison } from '../public/website/js/report.js';
import { pairedSamples, correlationResults } from '../public/website/js/correlation.js';
import { normalizeRatings } from '../public/website/js/evaluation.js';

const first = 'single_snr20_instruction_01_';
const second = 'single_snr20_instruction_02_';

test('그래프의 무처리·처리 평균은 지표별로 같은 조건만 대응하며 0점과 누락을 보존한다', () => {
  const metrics = [
    { sample_id: first + 'noisy', stoi: 0, estoi: .2 },
    { sample_id: first + 'ss_fixed', stoi: .4, estoi: .3 },
    { sample_id: second + 'noisy', stoi: .8, estoi: null },
    { sample_id: second + 'ss_fixed', stoi: .9, estoi: .5 },
    { sample_id: 'single_snr20_warning_01_noisy', stoi: 1, estoi: 1 },
    { sample_id: 'single_snr10_instruction_01_ss_fixed', stoi: .5, estoi: .5 },
  ];
  const result = objectiveComparison(metrics, 'ss_fixed');
  assert.deepEqual(result.stoi.map(point => point.snr), [0, 5, 10, 20]);
  const stoi = result.stoi[3], estoi = result.estoi[3];
  assert.equal(stoi.count, 2);
  assert.ok(Math.abs(stoi.baseline - .4) < 1e-12);
  assert.ok(Math.abs(stoi.processed - .65) < 1e-12);
  assert.ok(Math.abs(stoi.delta - .25) < 1e-12);
  assert.equal(estoi.count, 1);
  assert.equal(estoi.baseline, .2);
  assert.equal(estoi.processed, .3);
  assert.equal(result.stoi[2].count, 0);
  assert.equal(result.stoi[2].baseline, null);
});

test('소음·문장 필터와 선택한 처리 방식이 그래프에 적용되고 음수 점수를 유지한다', () => {
  const metrics = [
    { sample_id: first + 'noisy', stoi: -.2, estoi: .1 },
    { sample_id: first + 'ss_fixed', stoi: .1, estoi: .2 },
    { sample_id: second + 'noisy', stoi: .8, estoi: .8 },
    { sample_id: second + 'ss_fixed', stoi: .9, estoi: .9 },
    { sample_id: 'complex_snr20_instruction_01_noisy', stoi: .7, estoi: .7 },
    { sample_id: 'complex_snr20_instruction_01_ss_fixed', stoi: .8, estoi: .8 },
  ];
  const result = objectiveComparison(metrics, 'ss_fixed', { noise: 'single', statement: 'instruction_01' });
  assert.equal(result.stoi[3].count, 1);
  assert.ok(Math.abs(result.stoi[3].baseline + .2) < 1e-12);
  assert.equal(result.stoi[3].processed, .1);
  assert.ok(objectiveComparison(metrics, 'additional').stoi.every(point => point.count === 0));
});

test('채점 기준을 먼저 선택해 같은 음원의 혼재된 응답에서 정확한 정답률을 집계한다', () => {
  const sample_id = first + 'noisy';
  const ratings = normalizeRatings([
    { sample_id, listener_id: 'P1', understanding: 5, noise: 5, naturalness: 5, grading_version: 'v1', key_correct: 1, key_total: 2 },
    { sample_id, listener_id: 'P2', understanding: 10, noise: 10, naturalness: 10, grading_version: 'v2', key_correct: 3, key_total: 3 },
    { sample_id, listener_id: 'P3', understanding: 0, noise: 0, naturalness: 0, grading_version: 'v1', key_correct: 0, key_total: 1 },
  ]);
  const metrics = [{ sample_id, stoi: .7, estoi: .6 }];
  assert.equal(pairedSamples(metrics, ratings)[0].key_rate, null);
  const pairs = pairedSamples(metrics, ratings, { grading_version: 'v1', statement: 'instruction_01' });
  assert.equal(pairs[0].key_rate, 1 / 3);
  assert.equal(pairs[0].count, 2);
  assert.equal(pairs[0].understanding, 2.5);
  assert.equal(pairedSamples(metrics, ratings, { statement: 'warning_01' }).length, 0);
});

test('상관은 지표가 있는 대응 음원의 채점 기준만 검사하고 두 지표를 개별 계산한다', () => {
  const result = correlationResults([
    { stoi: .2, estoi: .8, key_rate: 0, grading_version: 'v1' },
    { stoi: .8, estoi: .2, key_rate: 1, grading_version: 'v1' },
    { stoi: null, estoi: null, key_rate: .5, grading_version: 'v2' },
  ], 'key_rate');
  assert.deepEqual(result.stoi, { rho: 1, n: 2, reason: null });
  assert.deepEqual(result.estoi, { rho: -1, n: 2, reason: null });
});
