import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArchitecture } from '../../scripts/check-architecture.mjs';

test('프론트·백엔드의 직접 의존과 공용 로직의 실행 환경 의존을 금지한다', async () => {
  assert.deepEqual(await checkArchitecture(), []);
});
