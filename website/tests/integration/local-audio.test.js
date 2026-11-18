import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { prepareAudio } from '../../scripts/prepare-audio.mjs';

async function snapshot(t) {
  const base = await realpath(tmpdir());
  const root = await mkdtemp(path.join(base, 'cnr-snapshot-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith('cnr-snapshot-test-'));
    await rm(root, { recursive: true, force: true });
  });
  const audio = path.join(root, 'public/dataset/audio');
  const relative = 'data/clean/instruction_01.wav';
  const bytes = Buffer.from('RIFFtestWAVEaudio');
  await mkdir(path.dirname(path.join(audio, relative)), { recursive: true });
  await writeFile(path.join(audio, relative), bytes);
  const catalog = { version: 1, files: [{ path: relative, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }] };
  await writeFile(path.join(audio, 'catalog.json'), JSON.stringify(catalog));
  return { root, audio, relative, catalog };
}

test('웹 빌드는 실험 원본 없이 내보낸 음원 스냅샷만 검증한다', async t => {
  const { root, catalog, audio, relative } = await snapshot(t);
  assert.deepEqual(await prepareAudio(root), catalog);
  assert.equal(await readFile(path.join(audio, relative), 'utf8'), 'RIFFtestWAVEaudio');
  await mkdir(path.join(root, 'experiment/data/noise_train'), { recursive: true });
  await writeFile(path.join(root, 'experiment/data/noise_train/private.wav'), 'private');
  assert.deepEqual(await prepareAudio(root), catalog);
});

test('내보낸 WAV 교체·삭제·경로 변조는 빌드 전에 검출한다', async t => {
  const { root, audio, relative, catalog } = await snapshot(t);
  await writeFile(path.join(audio, relative), 'RIFFtestWAVEother');
  await assert.rejects(prepareAudio(root), /변경/);
  await rm(path.join(audio, relative));
  await assert.rejects(prepareAudio(root), { code: 'ENOENT' });
  await writeFile(path.join(audio, 'catalog.json'), JSON.stringify({ ...catalog, files: [{ ...catalog.files[0], path: '../outside.wav' }] }));
  await assert.rejects(prepareAudio(root), /상대 경로/);
});

test('연구 자료가 없는 소스 복제본은 빈 음원 목록으로 코드 검사를 지원한다', async t => {
  const { root, audio } = await snapshot(t);
  await rm(path.join(audio, 'catalog.json'));
  assert.deepEqual(await prepareAudio(root), { version: 1, files: [] });
});
