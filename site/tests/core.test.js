import test from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLES, SAMPLE_INDEX, STATEMENTS, normalizeManifest, parseCSV, csvText, parseRecords } from '../public/website/js/dataset.js';
import { normalizeMetrics, improvement, mergeMetrics } from '../public/website/js/metrics.js';
import { normalizeRatings, mergeRatings, aggregateRatings, normalizeBackup } from '../public/website/js/evaluation.js';
import { spearman, pairedSamples, correlationResults } from '../public/website/js/correlation.js';

const a = 'single_snr20_instruction_01_noisy', b = 'single_snr20_instruction_01_ss_fixed', c = 'complex_snr10_warning_01_noisy';
const rating = (sample_id = a, listener_id = 'P001', fields = {}) => ({ sample_id, listener_id, understanding: 0, noise: 2.5, naturalness: 10, key_response: '', ...fields });

test('선정 문장·화자와 3+36+144 음원 연결이 정확하다', () => {
  assert.equal(SAMPLES.length, 183); assert.equal(SAMPLE_INDEX.size, 183);
  assert.equal(SAMPLES.filter(row => row.kind === 'clean').length, 3);
  assert.equal(SAMPLES.filter(row => row.kind === 'noisy').length, 36);
  assert.equal(SAMPLES.filter(row => row.kind === 'processed').length, 144);
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
test('종이 응답은 세 척도를 검증하고 중복을 덮어쓰지 않는다', () => {
  const rows = normalizeRatings([rating()]);
  assert.equal(rows[0].understanding, 0); assert.equal(rows[0].key_total, null);
  assert.throws(() => normalizeRatings([rating(a, 'P001', { understanding: '' })]), /3항목/);
  assert.throws(() => normalizeRatings([rating(a, 'P001', { noise: 3 })]), /3항목/);
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
test('상관분석은 동일 음원 이해도 평균을 대응시키며 누락 지표를 제외한다', () => {
  const ratings = normalizeRatings([rating(a, 'P001', { understanding: 0 }), rating(a, 'P002', { understanding: 10 }), rating(b, 'P001', { understanding: 10 }), rating(c, 'P001', { understanding: 0 })]);
  const metrics = normalizeMetrics([{ sample_id: a, stoi: 0, estoi: .2 }, { sample_id: b, stoi: 1 }]);
  const pairs = pairedSamples(metrics, ratings, { noise: 'single' }); assert.equal(pairs.length, 2); assert.equal(pairs[0].understanding, 5);
  assert.deepEqual(correlationResults(pairs).stoi, { rho: 1, n: 2, reason: null }); assert.equal(correlationResults(pairs).estoi.n, 1);
  assert.equal(pairedSamples(metrics, ratings, { algorithm: 'ss_fixed', snr: '20' }).length, 1);
});
test('경로 JSON은 문장·화자 바꿔치기와 외부·상위 경로를 거부한다', () => {
  assert.deepEqual(normalizeManifest({ version: 1, samples: [{ id: a, path: 'data/mixed/custom.wav' }] }), { [a]: 'data/mixed/custom.wav' });
  for (const value of ['https://example.com/a.wav', '../a.wav', 'data/../a.wav', 'data/%2e%2e/a.wav', 'data/.private/a.wav']) assert.throws(() => normalizeManifest({ version: 1, samples: [{ id: a, path: value }] }));
  assert.throws(() => normalizeManifest({ version: 1, samples: [{ id: a, path: 'data/a.wav', speaker: '김도연' }] }), /일치/);
});
test('백업은 전체 자료 검증 후 복원할 수 있고 잘못된 후반 행을 허용하지 않는다', () => {
  const input = { version: 1, paths: { [a]: 'data/a.wav' }, metrics: [{ sample_id: a, stoi: 0 }], ratings: [rating()] };
  const restored = normalizeBackup(JSON.parse(JSON.stringify(input))); assert.equal(restored.metrics[0].stoi, 0); assert.equal(restored.ratings[0].understanding, 0);
  const bad = structuredClone(input); bad.ratings.push(rating(b, 'P002', { noise: 9 })); assert.throws(() => normalizeBackup(bad), /3항목/);
  assert.equal(input.ratings.length, 1); assert.equal(parseRecords(JSON.stringify(input.metrics), 'scores.json', 'metrics').length, 1);
});
