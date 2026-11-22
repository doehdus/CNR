import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMixtureSummary, deliverMixtureSummary } from '../mixture_summary.mjs';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../../', import.meta.url));
test('피크 비교 9개를 기존 평균·SNR 그래프와 함께 지문 검증해 전달한다', async () => {
  const stage = await mkdtemp(path.join(root, '.cache/noise_analysis/peak-delivery-'));
  try {
    const summary = await loadMixtureSummary(root);
    assert.equal(summary.peakComparison.groups.length, 20);
    assert.equal(summary.peakArtifacts.length, 9);
    assert.equal(summary.artifacts.length, 40);
    assert.equal(summary.comparisonArtifacts.length, 3);
    await deliverMixtureSummary(summary, stage);
    assert.deepEqual(JSON.parse(await readFile(path.join(stage, 'mixture_summary/peak_comparison.json'))), summary.peakComparison);
    for (const [relative, expected] of Object.entries(summary.peakComparison.artifacts)) assert.equal(createHash('sha256').update(await readFile(path.join(stage, 'mixture_summary', relative))).digest('hex'), expected);
  } finally {
    if (!path.resolve(stage).startsWith(path.resolve(root, '.cache/noise_analysis') + path.sep)) throw Error('Unexpected test cache path.');
    await rm(stage, { recursive: true, force: true });
  }
});
test('완료 평균의 입력·발화 구간·PNG를 검증하고 현재 산출물만 전달한다', async () => {
  const temporary = await mkdtemp(path.join(root, '.cache/noise_analysis/summary-export-'));
  const copy = async relative => { const target = path.join(temporary, relative); await mkdir(path.dirname(target), { recursive: true }); await cp(path.join(root, relative), target); };
  try {
    const data = JSON.parse(await readFile(path.join(root, 'experiment/outputs/mixture_summary/results.json')));
    const comparison = JSON.parse(await readFile(path.join(root, 'experiment/outputs/mixture_summary/snr_comparison.json')));
    for (const file of data.files) await copy(file.source);
    for (const relative of ['experiment/outputs/mixture_summary/results.json', 'experiment/outputs/peak_analysis/results.json', 'experiment/outputs/mixture_preparation/tables/mixtures.csv']) await copy(relative);
    for (const relative of Object.keys(data.artifacts)) await copy('experiment/outputs/mixture_summary/' + relative);
    await copy('experiment/outputs/mixture_summary/snr_comparison.json');
    for (const relative of Object.keys(comparison.artifacts)) await copy('experiment/outputs/mixture_summary/' + relative);
    const measured = await loadMixtureSummary(temporary);
    assert.equal(measured.data.groups.length, 12); assert.equal(measured.artifacts.length, 40);
    assert.equal(measured.comparisonArtifacts.length, 3);
    const stage = path.join(temporary, 'snapshot');
    await deliverMixtureSummary(measured, stage);
    assert.deepEqual(JSON.parse(await readFile(path.join(stage, 'mixture_summary/results.json'))), { ...data, delivery: { source_sha256: measured.source_sha256 } });
    assert.deepEqual(JSON.parse(await readFile(path.join(stage, 'mixture_summary/snr_comparison.json'))), comparison);
    const artifact = Object.keys(data.artifacts)[0], filename = path.join(temporary, 'experiment/outputs/mixture_summary', artifact);
    const bytes = await readFile(filename); await writeFile(filename, 'invalid PNG');
    await assert.rejects(loadMixtureSummary(temporary), /PNG/);
    await writeFile(filename, bytes);
    const interval = path.join(temporary, 'experiment/outputs/mixture_preparation/tables/mixtures.csv');
    await writeFile(interval, Buffer.concat([await readFile(interval), Buffer.from('\n')]));
    await assert.rejects(loadMixtureSummary(temporary), /발화 구간/);
  } finally {
    const base = path.resolve(root, '.cache/noise_analysis') + path.sep;
    if (!path.resolve(temporary).startsWith(base)) throw Error('Unexpected test cache cleanup path.');
    await rm(temporary, { recursive: true, force: true });
  }
});
