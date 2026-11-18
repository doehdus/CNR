import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { conditionRows, metricMatchesInputs, listeningCellResults } from '../../shared/research/study-tables.js';
import { NOISE_SOURCES, SAMPLE_INDEX, requireEvaluationSample, normalizeNoiseSources } from '../../shared/research/dataset.js';
import { normalizeMetrics } from '../../shared/research/metrics.js';
import { normalizeBackup, aggregateRatings } from '../../shared/research/evaluation.js';
import { catalogFiles } from '../helpers/file-catalog.mjs';
import { writeTestLayout } from '../helpers/research-workspace.mjs';
import { sourceAudioPath } from '../helpers/research-layout.mjs';

test('모든 표는 소음×문장 9행과 SNR 20/10/5/0의 4열로 같은 36조건을 사용한다', () => {
  const rows = conditionRows(); assert.equal(rows.length, 9);
  const cells = rows.flatMap(row => row.cells); assert.equal(new Set(cells.map(cell => cell.id)).size, 36);
  for (const row of rows) {
    assert.deepEqual(row.cells.map(cell => cell.snr), [20,10,5,0]);
    for (const cell of row.cells) for (const key of ['noisy','ss_fixed','ss_pattern_fixed','ss_pattern_update','additional']) {
      const sample = SAMPLE_INDEX.get(cell[key]);
      assert.equal(sample.statement, row.statement.id); assert.equal(sample.speaker, row.statement.speaker); assert.equal(sample.noise, row.noise.id); assert.equal(sample.snr, cell.snr);
    }
  }
});

test('무처리만 응답한 경우에도 전체 방식 표에 나타나며 같은 조건의 SS와 0%를 함께 비교한다', () => {
  const cells = conditionRows().flatMap(row => row.cells);
  const ids = ['single_snr20_warning_01_noisy', 'complex_snr20_instruction_01_noisy', 'complex_snr00_instruction_01_noisy', 'changing_snr20_instruction_02_noisy'];
  const rows = ids.map((sample_id, index) => ({ listener_id: 'QR-example', sample_id, understanding: 5, noise: 2.5, naturalness: 7.5, grading_version: 'qr-mc-v1', key_correct: index ? 3 : 0, key_total: 3 }));
  let groups = new Map(aggregateRatings(rows).map(row => [row.sample_id, row]));
  assert.deepEqual(cells.flatMap(cell => listeningCellResults(groups, cell)).map(row => row.sampleId).sort(), [...ids].sort());
  assert.equal(cells.flatMap(cell => listeningCellResults(groups, cell, 'ss_fixed')).filter(row => row.result).length, 0);
  const cell = cells.find(cell => cell.noisy === ids[0]);
  groups = new Map(aggregateRatings([...rows, { ...rows[0], listener_id: 'P-manual', sample_id: cell.ss_fixed, key_correct: 2 }]).map(row => [row.sample_id, row]));
  const comparison = listeningCellResults(groups, cell);
  assert.deepEqual(comparison.map(row => row.method.id), ['noisy', 'ss_fixed']);
  assert.equal(comparison[0].result.key_rate, 0); assert.equal(comparison[1].result.key_rate, 2 / 3);
});
test('소음 원본은 별도 3개이며 객관 지표 대상에 들어가지 않는다', () => {
  assert.equal(NOISE_SOURCES.length, 3);
  for (const source of NOISE_SOURCES) assert.throws(() => requireEvaluationSample(source.id), /평가 음원/);
  assert.deepEqual(normalizeNoiseSources([{id:'noise_changing',path:'data/noise/custom.wav'}]), {noise_changing:'data/noise/custom.wav'});
  assert.throws(() => normalizeNoiseSources([{id:'unknown',path:'data/noise/a.wav'}]));
  const backup = normalizeBackup({version:1,paths:{},metrics:[],ratings:[]}); assert.deepEqual(backup.noise_paths, {});
});
test('실제 계산 출처를 보존하고 입력 경로·파일 변경·임시 교체 시 점수를 표시하지 않는다', () => {
  const raw = {sample_id:'single_snr20_instruction_01_ss_fixed',stoi:.6,estoi:.5,reference_id:'clean_instruction_01',reference_path:'data/clean/instruction_01.wav',compared_path:'outputs/ss_fixed/single/snr20/instruction_01.wav',reference_sha256:'a'.repeat(64),compared_sha256:'b'.repeat(64)};
  const metric = normalizeMetrics([raw])[0];
  const paths = {[raw.reference_id]:raw.reference_path,[raw.sample_id]:raw.compared_path}, hashes = {[raw.reference_path]:raw.reference_sha256,[raw.compared_path]:raw.compared_sha256};
  assert.equal(metric.reference_sha256,raw.reference_sha256); assert.ok(metricMatchesInputs(metric,paths,hashes));
  assert.equal(metricMatchesInputs(metric,paths,{...hashes,[raw.compared_path]:'c'.repeat(64)}),false);
  assert.equal(metricMatchesInputs(metric,{...paths,[raw.sample_id]:'outputs/ss_fixed/new.wav'},hashes),false);
  assert.equal(metricMatchesInputs(metric,paths,hashes,new Set([raw.reference_id])),false);
  assert.throws(() => normalizeMetrics([{...raw,reference_id:'clean_warning_01'}]), /기준 음원/);
  assert.throws(() => normalizeMetrics([{...raw,reference_sha256:'invalid'}]), /SHA-256/);
});
test('파일 목록의 지문은 실제 바이트를 반영하며 음원 변경 후 달라진다', async () => {
  const base = await realpath(tmpdir()), root = await mkdtemp(path.join(base,'cnr-catalog-test-'));
  try {
    const layout = await writeTestLayout(root);
    await mkdir(path.join(root,'experiment/data/clean'),{recursive:true}); await mkdir(path.join(root,'experiment/outputs/metrics'),{recursive:true});
    const relative = 'data/clean/reference.wav', bytes = Buffer.from('RIFFtestWAVEfixture-only');
    await writeFile(sourceAudioPath(root,relative,layout),bytes);
    await writeFile(path.join(root,layout.metric_results),JSON.stringify([{reference_path:relative,compared_path:relative}]));
    const first = await catalogFiles(root); assert.deepEqual(first.files,[relative]);
    assert.equal(first.fingerprints[relative],createHash('sha256').update(bytes).digest('hex'));
    await writeFile(sourceAudioPath(root,relative,layout),Buffer.concat([bytes,Buffer.from('changed')]));
    const second = await catalogFiles(root); assert.notEqual(second.fingerprints[relative],first.fingerprints[relative]);
  } finally {
    const checked = path.resolve(root);
    assert.equal(path.dirname(checked),base); assert.ok(path.basename(checked).startsWith('cnr-catalog-test-'));
    await rm(checked,{recursive:true,force:true});
  }
});
