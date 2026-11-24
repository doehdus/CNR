import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeMixtureSummary, mixtureSummaryMatches, normalizeSNRComparison, normalizePeakComparison } from '../../shared/research/mixture-summary-data.js';

const data = JSON.parse(readLegacyFixture('dataset/mixture_summary/results.json'));
const analysis = JSON.parse(readLegacyFixture('dataset/peak_analysis/results.json'));
const fingerprints = Object.fromEntries(data.files.map(file => [file.path, file.sha256]));
const comparison = JSON.parse(readLegacyFixture('dataset/mixture_summary/snr_comparison.json'));
const peakComparison = JSON.parse(readLegacyFixture('dataset/mixture_summary/peak_comparison.json'));

test('9개 피크 비교와 20개 구간 집계의 출처·유효 수·정규화·미검출 규칙을 검증한다', () => {
  assert.equal(normalizePeakComparison(peakComparison, data), peakComparison);
  assert.equal(peakComparison.groups.filter(g => g.period === 'whole').length, 12);
  assert.equal(peakComparison.groups.filter(g => g.period === 'before').length, 4);
  assert.equal(peakComparison.groups.filter(g => g.period === 'after').length, 4);
  const edits = [
    d => { d.source_summary_sha256 = '0'.repeat(64); },
    d => { d.groups[0].peaks[0].valid_tracks = 0; },
    d => { d.groups[0].peaks[0].mean_frequency_hz = null; },
    d => { d.method.appearance_missing = 'exclude'; },
    d => { d.groups.find(g => g.period === 'before').members[0].normalization_gain *= 2; },
    d => { d.graphs['single/peaks'] = '../private.png'; },
    d => { d.groups.pop(); },
  ];
  for (const edit of edits) { const copy = structuredClone(peakComparison); edit(copy); assert.throws(() => normalizePeakComparison(copy, data)); }
});

test('SNR 비교의 원본 지문·네 곡선 조건·공통 축·세 그래프를 검증한다', () => {
  assert.equal(normalizeSNRComparison(comparison, data), comparison);
  for (const mutate of [d => { d.snrs = [0, 5, 10]; }, d => { d.source_summary_sha256 = '0'.repeat(64); },
    d => { d.y_range_db = [-60, -20]; }, d => { d.graphs.single = d.graphs.complex; }]) {
    const copy = structuredClone(comparison); mutate(copy); assert.throws(() => normalizeSNRComparison(copy, data));
  }
});

test('12개 묶음의 정규화·시간별 참여 수와 현재 분석 대응을 검증한다', () => {
  assert.equal(normalizeMixtureSummary(data).groups.length, 12);
  assert(mixtureSummaryMatches(data, analysis, fingerprints));
  for (const group of data.groups) {
    assert.equal(group.members.length, 12);
    assert.equal(group.participant_counts[0], 12);
    assert.equal(group.participant_counts.at(-1), 1);
    assert.equal(group.split_sec, group.noise === 'changing' ? 2.5 : 0);
  }
});

test('잘못된 RMS 배율·중복 조건·가짜 참여 수·잘못된 검출 통계를 거부한다', () => {
  const changes = [
    d => { d.groups[0].members[0].normalization_gain *= 2; },
    d => { d.groups[1] = d.groups[0]; },
    d => { d.groups[0].participant_counts.at(-1); d.groups[0].participant_counts[d.groups[0].participant_counts.length - 1] = 12; },
    d => { d.groups[0].signals.mixture.temporal_peaks[0].frames[0][1] = -1; },
    d => { d.groups[0].signals.mixture.peak_counts[0] = 13; },
    d => { d.groups[0].graphs.welch = '../private.png'; },
    d => { d.groups[8].signals.mixture.before_db = []; },
  ];
  for (const change of changes) { const copy = structuredClone(data); change(copy); assert.throws(() => normalizeMixtureSummary(copy)); }
  assert.equal(mixtureSummaryMatches(data, analysis, { ...fingerprints, [data.files[0].path]: '0'.repeat(64) }), false);
  assert.equal(mixtureSummaryMatches(data, { ...analysis, delivery: { source_sha256: '0'.repeat(64) } }, fingerprints), false);
});
