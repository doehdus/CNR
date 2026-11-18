import test from 'node:test';
import assert from 'node:assert/strict';
import { PROCESSORS, EVALUATION_METHODS, CURRENT_EVALUATION_SAMPLES, SAMPLE_INDEX, methodsForPrefilter, processingMethod, matchesFilters, normalizeManifest } from '../../shared/research/dataset.js';
import { resultRows } from '../../shared/research/report.js';
import { normalizeRatings, aggregateRatings } from '../../shared/research/evaluation.js';
import { conditionRows, listeningCellResults } from '../../shared/research/study-tables.js';
import { pairedSamples } from '../../shared/research/correlation.js';

const base = 'single_snr20_instruction_01_';

test('전처리 두 분류는 5개씩 겹치지 않고 기준 두 종류를 더해 12조건이다', () => {
  const off = methodsForPrefilter(false), on = methodsForPrefilter(true);
  assert.equal(off.length, 5); assert.equal(on.length, 5);
  assert.equal(EVALUATION_METHODS.length, 12);
  assert.equal(new Set([...off, ...on].map(method => method.id)).size, 10);
  assert.equal(new Set(CURRENT_EVALUATION_SAMPLES.map(sample => sample.id)).size, 432);
  for (const processor of PROCESSORS) {
    const first = processingMethod(processor.id, false), second = processingMethod(processor.id, true);
    assert.equal(first.id, processor.id);
    assert.notEqual(first.id, second.id);
    assert.equal(first.processor, second.processor);
    assert.notEqual(SAMPLE_INDEX.get(base + first.id).path, SAMPLE_INDEX.get(base + second.id).path);
  }
});

test('새 전처리 결과는 기존 무처리·SS 경로를 바꾸지 않는다', () => {
  assert.equal(SAMPLE_INDEX.get(base + 'noisy').path, 'data/mixed/single/snr20/instruction_01.wav');
  assert.equal(SAMPLE_INDEX.get(base + 'ss_fixed').path, 'outputs/ss_fixed/single/snr20/instruction_01.wav');
  assert.equal(SAMPLE_INDEX.get(base + 'prefilter_only').prefilter, true);
  assert.equal(SAMPLE_INDEX.get(base + 'prefilter_only').processor, null);
  assert.equal(SAMPLE_INDEX.get(base + 'additional').legacy, true);
  assert.equal(normalizeManifest({ version: 1, samples: [{ id: base + 'additional', path: 'outputs/additional/custom.wav' }] })[base + 'additional'], 'outputs/additional/custom.wav');
});

test('경로 등록은 전처리 유무의 바꿔치기를 거부한다', () => {
  const sample = SAMPLE_INDEX.get(base + 'ss_fixed_prefilter');
  assert.equal(normalizeManifest({ version: 1, samples: [{ ...sample }] })[sample.id], sample.path);
  assert.throws(() => normalizeManifest({ version: 1, samples: [{ ...sample, prefilter: false }] }), /일치/);
  assert.throws(() => normalizeManifest({ version: 1, samples: [{ ...sample, processor: 'wiener' }] }), /일치/);
});

test('전처리 효과는 같은 소음·SNR·문장의 같은 알고리즘과 대응한다', () => {
  const scores = [
    { sample_id: base + 'noisy', stoi: 0, estoi: .2 },
    { sample_id: base + 'ss_fixed', stoi: .5, estoi: .6 },
    { sample_id: base + 'ss_fixed_prefilter', stoi: .7, estoi: .75 },
    { sample_id: 'complex_snr20_instruction_01_ss_fixed', stoi: .99, estoi: .99 },
  ];
  const row = resultRows(scores, [], { algorithm: 'ss_fixed_prefilter', noise: 'single', snr: 20, statement: 'instruction_01' })[0];
  assert.equal(row.delta_stoi, .7);
  assert.ok(Math.abs(row.delta_prefilter_stoi - .2) < 1e-12);
  assert.ok(Math.abs(row.delta_prefilter_estoi - .15) < 1e-12);
  const withoutPair = resultRows(scores.filter(score => score.sample_id !== base + 'ss_fixed'), [], { algorithm: 'ss_fixed_prefilter', noise: 'single', snr: 20, statement: 'instruction_01' })[0];
  assert.equal(withoutPair.delta_prefilter_stoi, null);
});

test('전처리 필터는 기준 음원까지 포함해 216조건씩 구분한다', () => {
  assert.equal(resultRows([], [], { prefilter: 'off' }).length, 216);
  assert.equal(resultRows([], [], { prefilter: 'on' }).length, 216);
  assert.equal(resultRows([], [], { processor: 'ss_fixed' }).length, 72);
  assert.ok(matchesFilters(SAMPLE_INDEX.get(base + 'ss_fixed'), { prefilter: false }));
  assert.ok(!matchesFilters(SAMPLE_INDEX.get(base + 'ss_fixed_prefilter'), { prefilter: false }));
});

test('청음 결과와 지표 대응은 전처리 두 분류의 응답을 섞지 않는다', () => {
  const ids = ['noisy', 'ss_fixed', 'ss_fixed_prefilter'].map(method => base + method);
  const ratings = normalizeRatings(ids.map((sample_id, index) => ({ sample_id, listener_id: 'P001', noise: 5, naturalness: 7.5, grading_version: 'qr-mc-v1', key_correct: index, key_total: 3 })));
  const groups = new Map(aggregateRatings(ratings).map(row => [row.sample_id, row]));
  const cell = conditionRows().flatMap(row => row.cells).find(row => row.id === base.slice(0, -1));
  assert.deepEqual(listeningCellResults(groups, cell, 'all', { prefilter: 'off' }).map(row => row.sampleId), ids.slice(0, 2));
  assert.deepEqual(listeningCellResults(groups, cell, 'all', { prefilter: 'on' }).map(row => row.sampleId), ids.slice(2));
  assert.deepEqual(pairedSamples([], ratings, { prefilter: 'on' }).map(row => row.sample_id), ids.slice(2));
});
