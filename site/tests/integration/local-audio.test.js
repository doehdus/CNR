import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareAudio } from '../../scripts/prepare-audio.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cnr-audio-test-'));
  const site = path.join(root, 'site');
  await mkdir(path.join(site, 'public'), { recursive: true });
  await writeFile(path.join(root, 'PROJECT_CONTEXT.md'), 'CNR test workspace');
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('cnr-audio-test-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, site };
}

test('배포 준비는 로컬 WAV의 추가·같은 크기 교체·삭제와 지문을 반영한다', async t => {
  const { root, site } = await workspace(t);
  const clean = 'data/clean/instruction_01.wav';
  const processed = 'outputs/ss_fixed/single/snr20/instruction_01.wav';
  for (const relative of [clean, processed]) {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), 'RIFFtestWAVEfirst');
  }
  const first = await prepareAudio(site);
  assert.deepEqual(first.files.map(file => file.path), [clean, processed]);
  assert.equal(first.files[0].sha256, createHash('sha256').update('RIFFtestWAVEfirst').digest('hex'));
  assert.equal(await readFile(path.join(site, 'public/research-audio', clean), 'utf8'), 'RIFFtestWAVEfirst');

  await writeFile(path.join(root, clean), 'RIFFtestWAVEother');
  await rm(path.join(root, processed));
  const second = await prepareAudio(site);
  assert.deepEqual(second.files.map(file => file.path), [clean]);
  assert.notEqual(second.files[0].sha256, first.files[0].sha256);
  await assert.rejects(readFile(path.join(site, 'public/research-audio', processed)), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(root, clean), 'utf8'), 'RIFFtestWAVEother');

  await writeFile(path.join(root, processed), 'invalid wave');
  await assert.rejects(prepareAudio(site), /RIFF\/WAVE/);
  const saved = JSON.parse(await readFile(path.join(site, 'public/research-audio/catalog.json'), 'utf8'));
  assert.deepEqual(saved, second);
});

test('원본 폴더가 없는 서버 빌드는 배포 소스의 음원 스냅샷을 유지한다', async t => {
  const { root, site } = await workspace(t);
  await mkdir(path.join(root, 'data/clean'), { recursive: true });
  await writeFile(path.join(root, 'data/clean/instruction_01.wav'), 'RIFFtestWAVEaudio');
  const snapshot = await prepareAudio(site);
  await rm(path.join(root, 'PROJECT_CONTEXT.md'));
  await rm(path.join(root, 'data/clean/instruction_01.wav'));
  assert.deepEqual(await prepareAudio(site), snapshot);
  assert.equal(await readFile(path.join(site, 'public/research-audio/data/clean/instruction_01.wav'), 'utf8'), 'RIFFtestWAVEaudio');
});
