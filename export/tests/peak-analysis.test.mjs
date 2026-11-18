import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPeakAnalysis } from '../peak_analysis.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
test('171개 실제 입력 지문을 검증한 완료 분석만 전달한다', async () => {
  const measured = await loadPeakAnalysis(root);
  assert.equal(measured.files.length, 171); assert.equal(measured.data.conditions.length, 144);
});
test('계산 후 교체된 음원을 검출하고 기존 웹 자료를 건드리지 않는다', async t => {
  const base = await realpath(tmpdir()), temporary = await mkdtemp(path.join(base, 'cnr-peak-export-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const data = JSON.parse(await readFile(path.join(root,'experiment/outputs/peak_analysis/results.json')));
  await mkdir(path.join(temporary,'experiment/outputs/peak_analysis'),{recursive:true});
  await writeFile(path.join(temporary,'experiment/outputs/peak_analysis/results.json'),JSON.stringify(data));
  const first=data.files[0]; await mkdir(path.dirname(path.join(temporary,first.source)),{recursive:true});
  const bytes=await readFile(path.join(root,first.source));bytes[bytes.length-1]^=1;await writeFile(path.join(temporary,first.source),bytes);
  await mkdir(path.join(temporary,'website/public/dataset'),{recursive:true});
  const sentinel=path.join(temporary,'website/public/dataset/keep.txt');await writeFile(sentinel,'preserve');
  await assert.rejects(()=>loadPeakAnalysis(temporary),/변경/);
  assert.equal(await readFile(sentinel,'utf8'),'preserve');
});
