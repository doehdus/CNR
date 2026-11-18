import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCleanCollection, collectionMatches } from '../../shared/research/collection-data.js';
import { SAMPLE_INDEX } from '../../shared/research/dataset.js';

function fixture() {
  return { version: 1, recordings: ['instruction', 'warning'].flatMap(category => Array.from({ length: 6 }, (_, index) => {
    const id = category + String(index + 1).padStart(2, '0'), rate = index < 3 ? 16000 : 48000;
    return { id, category, speaker: index < 3 ? '유채원' : '김도연', text: 'fixture ' + id, path: 'data/clean/' + id + '.wav',
      sha256: 'a'.repeat(64), size: rate * 2 + 44, sample_rate_hz: rate, sample_count: rate, channels: 1, duration_seconds: 1 };
  })) };
}

test('새 원음 12개는 지시 6·경고 6, 화자별 지시 3·경고 3으로 연결하며 기존 평가 ID와 섞이지 않는다', () => {
  const { recordings } = normalizeCleanCollection(fixture());
  assert.equal(recordings.length, 12);
  for (const category of ['instruction', 'warning']) for (const speaker of ['유채원', '김도연']) {
    assert.equal(recordings.filter(row => row.category === category && row.speaker === speaker).length, 3);
  }
  assert.deepEqual([...new Set(recordings.map(row => row.sample_rate_hz))], [16000, 48000]);
  assert.ok(recordings.every(row => !SAMPLE_INDEX.has('clean_' + row.id)));
  assert.equal(SAMPLE_INDEX.get('clean_instruction_01').statement, 'instruction_01');
});

test('새 원음의 누락·중복·화자 바꿔치기와 외부 경로, 잘못된 녹음 정보를 거부한다', () => {
  for (const mutate of [
    data => data.recordings.pop(),
    data => { data.recordings[1] = data.recordings[0]; },
    data => { data.recordings[0].id = 'instruction_01'; },
    data => { data.recordings[0].speaker = '김도연'; },
    data => { data.recordings[0].path = '../private.wav'; },
    data => { data.recordings[0].path = 'data/noise/single.wav'; },
    data => { data.recordings[0].duration_seconds = 5; },
    data => { data.recordings[0].sha256 = 'invalid'; },
  ]) { const input = fixture(); mutate(input); assert.throws(() => normalizeCleanCollection(input), /실험 자료/); }
});

test('실제 배포된 파일 지문과 맞는 새 원음만 재생에 연결한다', () => {
  const recording = normalizeCleanCollection(fixture()).recordings[0];
  assert.equal(collectionMatches(recording, { [recording.path]: recording.sha256 }), true);
  assert.equal(collectionMatches(recording, { [recording.path]: 'b'.repeat(64) }), false);
  assert.equal(collectionMatches(recording, {}), false);
});
