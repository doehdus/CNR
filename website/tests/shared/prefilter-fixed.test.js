import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeFixedPrefilter, fixedPrefilterInputsMatch } from '../../shared/research/prefilter-fixed-data.js';
const data = JSON.parse(readLegacyFixture('dataset/prefilter/results.json'));
test('고정 EQ 144조건은 원본과 처리 결과 모두 지문이 맞아야 재생 가능하다', () => {
  normalizeFixedPrefilter(data);
  const hashes = Object.fromEntries(data.conditions.flatMap(row => [[row.input_path, row.input_sha256], [row.output_path, row.output_sha256]]));
  assert(fixedPrefilterInputsMatch(data, hashes));
  for (const field of ['input_path', 'output_path']) {
    const changed = { ...hashes, [data.conditions[0][field]]: '0'.repeat(64) };
    assert.equal(fixedPrefilterInputsMatch(data, changed), false);
  }
});
test('중복 조건·잘못된 대응 경로·누락 음원·설정 변조를 거부한다', () => {
  for (const mutate of [d => d.conditions.pop(), d => { d.conditions[1] = d.conditions[0]; },
    d => { d.conditions[0].output_path = d.conditions[0].input_path; },
    d => { d.conditions[0].sample_count++; }, d => { d.settings.sections[0].gain_db = 6; },
    d => { d.recordings[1].id = d.recordings[0].id; }]) {
    const changed = structuredClone(data); mutate(changed); assert.throws(() => normalizeFixedPrefilter(changed));
  }
});
