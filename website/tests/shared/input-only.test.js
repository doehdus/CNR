import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMetricResults } from '../../scripts/validate-metric-results.mjs';

test('계산 전 입력 전용 자료는 명시적으로 빈 지표를 허용하며 점수를 만들지 않는다', () => {
  assert.throws(() => validateMetricResults([]), /지표/);
  assert.deepEqual(validateMetricResults([], { allowEmpty: true }), []);
  assert.throws(() => validateMetricResults(null, { allowEmpty: true }), /지표/);
});
