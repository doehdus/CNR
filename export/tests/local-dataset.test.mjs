import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareLocalDataset, waveMetadata } from '../prepare_local_dataset.mjs';

function pcmWave(rate = 16000, extended = false) {
  const formatSize = extended ? 40 : 16, dataSize = 320;
  const bytes = Buffer.alloc(12 + 8 + formatSize + 8 + dataSize);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(formatSize, 16);
  bytes.writeUInt16LE(extended ? 65534 : 1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  if (extended) { bytes.writeUInt16LE(22, 36); bytes.writeUInt16LE(16, 38); Buffer.from('0100000000001000800000aa00389b71', 'hex').copy(bytes, 44); }
  bytes.write('data', 20 + formatSize); bytes.writeUInt32LE(dataSize, 24 + formatSize);
  return bytes;
}

async function fixture(t) {
  const base = await realpath(tmpdir()), root = await mkdtemp(path.join(base, 'cnr-local-inputs-'));
  t.after(async () => { assert.equal(path.dirname(root), base); await rm(root, { recursive: true, force: true }); });
  const recordings = ['instruction', 'warning'].flatMap(category => Array.from({ length: 6 }, (_, index) => ({ id: category + String(index + 1).padStart(2, '0'), category, speaker: index < 3 ? '유채원' : '김도연', text: 'fixture' })));
  const noises = ['single', 'complex', 'changing'];
  for (const folder of ['code/config', 'data/metadata', 'data/clean', 'data/noise']) await mkdir(path.join(root, folder), { recursive: true });
  await writeFile(path.join(root, 'data/metadata/collection.json'), JSON.stringify({ version: 1, source_root: 'data/clean', recordings }));
  await writeFile(path.join(root, 'data/metadata/dataset.json'), JSON.stringify({ version: 1, samples: [], noise_sources: noises.map(noise => ({ id: 'noise_' + noise, path: 'data/noise/' + noise + '.wav' })) }));
  for (const recording of recordings) await writeFile(path.join(root, 'data/clean', recording.id + '.wav'), pcmWave(recording.id.endsWith('04') ? 48000 : 16000, recording.id.endsWith('04')));
  for (const noise of noises) await writeFile(path.join(root, 'data/noise', noise + '.wav'), pcmWave());
  return root;
}

test('공유 PCM·확장 PCM WAV를 변환 없이 읽고 손상된 입력은 거부한다', () => {
  assert.equal(waveMetadata(pcmWave()).sample_count, 160);
  assert.equal(waveMetadata(pcmWave(48000, true)).sample_rate_hz, 48000);
  assert.throws(() => waveMetadata(pcmWave().subarray(0, 100)), /Truncated/);
});

test('개인 배포 설정·Python 없이 새 복제본의 15개 입력과 빈 지표를 준비한다', async t => {
  const root = await fixture(t), prepared = await prepareLocalDataset(root);
  assert.equal(prepared.recordings, 12);
  const destination = path.join(root, 'website/public/dataset');
  assert.equal(JSON.parse(await readFile(path.join(destination, 'audio/catalog.json'))).files.length, 15);
  assert.deepEqual(JSON.parse(await readFile(path.join(destination, 'results.json'))), []);
  const original = await readFile(path.join(root, 'data/clean/instruction04.wav'));
  assert.deepEqual(await readFile(path.join(destination, 'audio/data/clean/instruction04.wav')), original);
  assert.equal((await prepareLocalDataset(root)).changed, false);
});

test('기존 실험 결과가 있으면 로컬 초기화가 덮어쓰지 않는다', async t => {
  const root = await fixture(t); await prepareLocalDataset(root);
  const destination = path.join(root, 'website/public/dataset');
  const results = JSON.stringify([{ sample_id: 'fixture', stoi: .5 }]);
  await writeFile(path.join(destination, 'results.json'), results);
  const file = path.join(root, 'data/clean/instruction01.wav'), bytes = pcmWave(); bytes[bytes.length - 1] = 1; await writeFile(file, bytes);
  assert.equal((await prepareLocalDataset(root)).preserved, true);
  assert.equal(await readFile(path.join(destination, 'results.json'), 'utf8'), results);
});

test('완료 분석 없이 등록 입력을 모두 전달하고 변경된 원본은 기존 스냅샷을 보존하며 거부한다', async t => {
  const root = await fixture(t); await prepareLocalDataset(root);
  const destination = path.join(root, 'website/public/dataset');
  const catalog = JSON.parse(await readFile(path.join(destination, 'audio/catalog.json')));
  const files = catalog.files.map(file => ({...file, source:file.path}));
  const reference = pcmWave(), relative='data/reference/instruction01.wav';
  await mkdir(path.join(root,'data/reference'),{recursive:true});
  await writeFile(path.join(root,relative),reference);
  files.push({path:relative,source:relative,size:reference.length,sha256:createHash('sha256').update(reference).digest('hex')});
  await writeFile(path.join(root,'data/metadata/inputs.json'),JSON.stringify({version:1,expected_count:16,files}));
  await prepareLocalDataset(root);
  assert.equal(JSON.parse(await readFile(path.join(destination,'audio/catalog.json'))).files.length,16);
  const before=await readFile(path.join(destination,'audio/catalog.json'));
  await writeFile(path.join(root,relative),pcmWave(48000));
  await assert.rejects(prepareLocalDataset(root),/Registered input changed/);
  assert.deepEqual(await readFile(path.join(destination,'audio/catalog.json')),before);
});
