import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { normalizePrefilterInitial, prefilterMatchesAnalysis } from '../../shared/research/prefilter-data.js';

const bytes = readLegacyFixture('experiment/outputs/peak_analysis/results.json');
const analysis = JSON.parse(bytes), hash = createHash('sha256').update(bytes).digest('hex');
const settings = JSON.parse(readLegacyFixture('experiment/config/prefilter_initial.json'));

test('초기 EQ 세 설정은 원래 분석의 회차·지문·피크에 대응한다', () => {
  const normalized = normalizePrefilterInitial(settings);
  assert(prefilterMatchesAnalysis(normalized, analysis, hash));
  assert(prefilterMatchesAnalysis(normalized, { ...analysis, delivery: { source_sha256: hash } }));
  assert.equal(normalizePrefilterInitial(null), null);
  assert.equal(prefilterMatchesAnalysis(null, analysis, hash), false);
});

test('회차·지문·피크가 달라지면 초기 설정 표시를 보류한다', () => {
  assert.equal(prefilterMatchesAnalysis(settings, analysis, 'a'.repeat(64)), false);
  for (const change of [a => { a.engine.run_id = '20261120T000000Z-12345678'; },
    a => { a.sources[0].peaks[0].frequency_hz += 1; }, a => { a.sources[0].peaks[0].bandwidth_hz += 1; }]) {
    const changed = structuredClone(analysis); change(changed);
    assert.equal(prefilterMatchesAnalysis(settings, changed, hash), false);
  }
});

test('중복 소음·잘못된 이득·폭과 불일치하는 Q를 거부한다', () => {
  for (const change of [s => { s.presets[1].noise = 'single'; }, s => { s.presets[0].gain_db = 6; },
    s => { s.presets[0].q *= 2; }, s => { s.presets[0].bandwidth_hz = NaN; }, s => { s.status = 'validated'; }]) {
    const changed = structuredClone(settings); change(changed);
    assert.throws(() => normalizePrefilterInitial(changed));
  }
});
