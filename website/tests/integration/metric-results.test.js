import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMetricResults } from '../../scripts/validate-metric-results.mjs';

const metric = {
  sample_id: 'single_snr20_instruction_01_noisy', stoi: 0, estoi: -.1,
  tool_version: 'cnr/2', reference_id: 'clean_instruction_01',
  reference_path: 'data/clean/instruction_01.wav', compared_path: 'data/mixed/single/snr20/instruction_01.wav',
  reference_sha256: 'a'.repeat(64), compared_sha256: 'b'.repeat(64),
  sample_rate: 16000, samples: 24000, calculated_at: '2026-11-15T00:00:00+09:00',
  alignment_delay_samples: -16, reference_trim_start: 16,
};

test('완료 지표 검증은 전체 출처·0점·음수 점수를 보존하고 누락·중복을 거부한다', () => {
  const rows = [structuredClone(metric)];
  assert.deepEqual(validateMetricResults(rows), [metric]);
  for (const broken of [[], [{ ...metric, estoi: null }], [{ ...metric, reference_sha256: '' }], [metric, metric]]) {
    assert.throws(() => validateMetricResults(broken));
  }
});

test('결과 전달 경계에서 잘못된 음원·점수·계산 출처를 거부한다', () => {
  for (const changes of [
    { sample_id: 'unknown' }, { stoi: '0.5' }, { stoi: 2 }, { estoi: NaN },
    { tool_version: '' }, { reference_id: 'clean_warning_01' }, { compared_path: '../outside.wav' },
    { samples: 0 }, { sample_rate: 0 }, { calculated_at: 'invalid' },
  ]) assert.throws(() => validateMetricResults([{ ...metric, ...changes }]));
});
