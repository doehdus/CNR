import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { importMetricResults, validateMetricResults } from '../../scripts/import-metric-results.mjs';

const metric = {
  sample_id: 'single_snr20_instruction_01_noisy', stoi: 0, estoi: -.1,
  tool_version: 'cnr/2', reference_id: 'clean_instruction_01',
  reference_path: 'data/clean/instruction_01.wav', compared_path: 'data/mixed/single/snr20/instruction_01.wav',
  reference_sha256: 'a'.repeat(64), compared_sha256: 'b'.repeat(64),
  sample_rate: 16000, samples: 24000, calculated_at: '2026-11-15T00:00:00+09:00',
  alignment_delay_samples: -16, reference_trim_start: 16,
};

test('완료 결과 JSON만으로 웹 입력을 만들고 전체 출처·0점·음수 점수를 보존한다', async t => {
  const base = await realpath(tmpdir()), root = await mkdtemp(path.join(base, 'cnr-result-import-'));
  t.after(async () => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith('cnr-result-import-'));
    await rm(root, { recursive: true, force: true });
  });
  const site = path.join(root, 'site'), source = path.join(root, 'results.json');
  await mkdir(site);
  const content = JSON.stringify([metric], null, 2) + '\n';
  await writeFile(source, content);
  const result = await importMetricResults(source, site);
  assert.equal(result.count, 1);
  assert.equal(await readFile(result.destination, 'utf8'), content);
  // No WAVs, Python or database exist in this workspace.
  for (const broken of [[], [{ ...metric, estoi: null }], [{ ...metric, reference_sha256: '' }], [metric, metric]]) {
    await writeFile(source, JSON.stringify(broken));
    await assert.rejects(importMetricResults(source, site));
    assert.equal(await readFile(result.destination, 'utf8'), content);
  }
  await writeFile(source, '{broken');
  await assert.rejects(importMetricResults(source, site));
  assert.equal(await readFile(result.destination, 'utf8'), content);
});

test('결과 전달 경계에서 잘못된 음원·점수·계산 출처를 거부한다', () => {
  for (const changes of [
    { sample_id: 'unknown' }, { stoi: '0.5' }, { stoi: 2 }, { estoi: NaN },
    { tool_version: '' }, { reference_id: 'clean_warning_01' }, { compared_path: '../outside.wav' },
    { samples: 0 }, { sample_rate: 0 }, { calculated_at: 'invalid' },
  ]) assert.throws(() => validateMetricResults([{ ...metric, ...changes }]));
});
