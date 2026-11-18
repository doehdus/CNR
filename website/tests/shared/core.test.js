import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLES, SAMPLE_INDEX, CURRENT_EVALUATION_SAMPLES, STATEMENTS, normalizeManifest, parseCSV, csvText, parseRecords } from '../../shared/research/dataset.js';
import { normalizeMetrics, improvement, mergeMetrics } from '../../shared/research/metrics.js';
import { normalizeRatings, mergeRatings, aggregateRatings, normalizeBackup } from '../../shared/research/evaluation.js';
import { spearman, pairedSamples, correlationResults } from '../../shared/research/correlation.js';

const a = 'single_snr20_instruction_01_noisy', b = 'single_snr20_instruction_01_ss_fixed', c = 'complex_snr10_warning_01_noisy';
const rating = (sample_id = a, listener_id = 'P001', fields = {}) => ({ sample_id, listener_id, understanding: 0, noise: 2.5, naturalness: 10, key_response: '', ...fields });

test('12조건 432개와 기준 음성·이전 ID의 연결을 구분한다', () => {
  assert.equal(SAMPLES.length, 471); assert.equal(SAMPLE_INDEX.size, 471);
  assert.equal(CURRENT_EVALUATION_SAMPLES.length, 432);
  assert.equal(SAMPLES.filter(row => row.kind === 'clean').length, 3);
  assert.equal(SAMPLES.filter(row => row.kind === 'noisy').length, 36);
  assert.equal(SAMPLES.filter(row => row.kind === 'processed' && !row.legacy).length, 396);
  assert.equal(SAMPLES.filter(row => row.legacy).length, 36);
  assert.deepEqual(STATEMENTS.map(row => row.speaker), ['유채원', '유채원', '김도연']);
  assert.equal(SAMPLE_INDEX.get('changing_snr05_warning_01_ss_fixed').path, 'outputs/ss_fixed/changing/snr05/warning_01.wav');
});
test('CSV는 BOM·따옴표·쉼표·개행을 보존하고 손상된 행을 거부한다', () => {
  const rows = [{ listener_id: 'P001', key_response: '"멈춰", 장비 뒤\n사람' }];
  assert.deepEqual(parseCSV(csvText(rows, ['listener_id', 'key_response'])), rows);
  assert.throws(() => parseCSV('a,b\n1'), /열 개수/); assert.throws(() => parseCSV('a,a\n1,2'), /열 이름/);
  assert.throws(() => parseCSV('a\n"끝'), /닫히지/); assert.deepEqual(parseCSV(''), []);
});
test('지표의 0점은 보존하고 누락된 기준 점수로 개선량을 만들지 않는다', () => {
  const rows = normalizeMetrics([{ sample_id: a, stoi: '0', estoi: '' }, { sample_id: b, stoi: '.25', estoi: '.4' }]);
  assert.equal(rows[0].stoi, 0); assert.equal(rows[0].estoi, null);
  assert.equal(improvement(rows[1], rows[0], 'stoi'), .25); assert.equal(improvement(rows[1], rows[0], 'estoi'), null);
  assert.equal(mergeMetrics(rows, normalizeMetrics([{ sample_id: a, stoi: '.1' }])).length, 2);
  assert.throws(() => normalizeMetrics([{ sample_id: a, stoi: '' }]), /실측값/);
  assert.throws(() => normalizeMetrics([{ sample_id: a, stoi: Infinity }]), /숫자/);
  assert.throws(() => normalizeMetrics([{ sample_id: a, stoi: 2 }]), /범위/);
  assert.throws(() => normalizeMetrics([{ sample_id: 'clean_warning_01', stoi: .5 }]), /평가 음원/);
  assert.throws(() => normalizeMetrics([{ sample_id: a, stoi: 0 }, { sample_id: a, stoi: .2 }]), /중복/);
});
test('종이 응답은 소음·자연스러움 두 척도를 검증하고 이전 이해도는 제거한다', () => {
  const rows = normalizeRatings([rating()]);
  assert.equal('understanding' in rows[0], false); assert.equal(rows[0].key_total, null);
  assert.equal(normalizeRatings([rating(a, 'P001', { understanding: undefined })])[0].noise, 2.5);
  assert.throws(() => normalizeRatings([rating(a, 'P001', { noise: '' })]), /두 항목/);
  assert.throws(() => normalizeRatings([rating(a, 'P001', { noise: 3 })]), /두 항목/);
  assert.throws(() => normalizeRatings([rating(a, '')]), /평가자/);
  assert.throws(() => mergeRatings(rows, normalizeRatings([rating()])), /이미/);
  assert.equal(rows.length, 1);
});
test('채점표 없이 정답률을 만들지 않고 채점 기준이 섞이면 합산하지 않는다', () => {
  assert.throws(() => normalizeRatings([rating(a, 'P001', { key_correct: 1, key_total: 2 })]), /기준 버전/);
  assert.throws(() => normalizeRatings([rating(a, 'P001', { grading_version: 'v1', key_correct: 3, key_total: 2 })]), /기준 버전/);
  const first = normalizeRatings([rating(a, 'P001', { grading_version: 'v1', key_correct: 0, key_total: 2 })]);
  assert.equal(aggregateRatings(first)[0].key_rate, 0);
  const second = normalizeRatings([rating(a, 'P002', { grading_version: 'v2', key_correct: 2, key_total: 2 })]);
  const mixed = aggregateRatings([...first, ...second])[0]; assert.equal(mixed.key_rate, null); assert.equal(mixed.grading_mixed, true);
});
test('Spearman은 동점 평균 순위와 역상관·상수·자료 부족을 처리한다', () => {
  assert.equal(spearman([1, 2, 3], [3, 2, 1]).rho, -1);
  assert.ok(Math.abs(spearman([1, 1, 2], [1, 2, 3]).rho - Math.sqrt(3) / 2) < 1e-12);
  assert.equal(spearman([1, 1], [0, 10]).rho, null);
  assert.equal(spearman([], []).rho, null); assert.equal(spearman([0], [0]).rho, null);
});
test('기본 상관분석은 음원별 정답률을 대응시키며 응답자 수와 음원 수를 구분한다', () => {
  const graded = (sample, listener, correct) => rating(sample, listener, { grading_version: 'v1', key_correct: correct, key_total: 2 });
  const ratings = normalizeRatings([graded(a, 'P001', 0), graded(a, 'P002', 2), graded(b, 'P001', 2), graded(c, 'P001', 0)]);
  const metrics = normalizeMetrics([{ sample_id: a, stoi: 0, estoi: .2 }, { sample_id: b, stoi: 1 }]);
  const pairs = pairedSamples(metrics, ratings, { noise: 'single' }); assert.equal(pairs.length, 2); assert.equal(pairs[0].key_rate, .5); assert.equal(pairs[0].count, 2);
  assert.deepEqual(correlationResults(pairs).stoi, { rho: 1, n: 2, reason: null }); assert.equal(correlationResults(pairs).estoi.n, 1);
  assert.throws(() => correlationResults(pairs, 'understanding'), /항목/);
  assert.equal(pairedSamples(metrics, ratings, { algorithm: 'ss_fixed', snr: '20' }).length, 1);
});
test('경로 JSON은 문장·화자 바꿔치기와 외부·상위 경로를 거부한다', () => {
  assert.deepEqual(normalizeManifest({ version: 1, samples: [{ id: a, path: 'data/mixed/custom.wav' }] }), { [a]: 'data/mixed/custom.wav' });
  for (const value of ['https://example.com/a.wav', '../a.wav', 'data/../a.wav', 'data/%2e%2e/a.wav', 'data/.private/a.wav']) assert.throws(() => normalizeManifest({ version: 1, samples: [{ id: a, path: value }] }));
  assert.throws(() => normalizeManifest({ version: 1, samples: [{ id: a, path: 'data/a.wav', speaker: '김도연' }] }), /일치/);
});
test('백업은 전체 자료 검증 후 복원할 수 있고 잘못된 후반 행을 허용하지 않는다', () => {
  const input = { version: 1, paths: { [a]: 'data/a.wav' }, metrics: [{ sample_id: a, stoi: 0 }], ratings: [rating()] };
  const restored = normalizeBackup(JSON.parse(JSON.stringify(input))); assert.equal(restored.metrics[0].stoi, 0); assert.equal('understanding' in restored.ratings[0], false);
  const bad = structuredClone(input); bad.ratings.push(rating(b, 'P002', { noise: 9 })); assert.throws(() => normalizeBackup(bad), /두 항목/);
  assert.equal(input.ratings.length, 1); assert.equal(parseRecords(JSON.stringify(input.metrics), 'scores.json', 'metrics').length, 1);
});

test('5단계 평균과 분포는 원점수·0점·응답 수를 보존하고 정답률과 분리한다', () => {
  const raw = normalizeRatings([rating(a, 'P1', { noise: 0, naturalness: 10 }), rating(a, 'P2', { noise: 10, naturalness: 0 }), rating(a, 'P3', { noise: 10, naturalness: 5 })]);
  const group = aggregateRatings(raw)[0];
  assert.equal(group.count, 3); assert.equal(group.noise, 20 / 3); assert.equal(group.naturalness, 5);
  assert.deepEqual(group.noise_distribution, [{ score: 0, count: 1 }, { score: 2.5, count: 0 }, { score: 5, count: 0 }, { score: 7.5, count: 0 }, { score: 10, count: 2 }]);
  assert.equal(group.naturalness_distribution.reduce((sum, level) => sum + level.count, 0), 3);
  assert.deepEqual(raw.map(row => row.noise), [0, 10, 10]); assert.equal(group.key_rate, null);
  assert.equal('understanding' in group, false);
});
