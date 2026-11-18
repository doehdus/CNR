import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sqliteD1 } from '../helpers/sqlite-d1.mjs';
import { createHash } from 'node:crypto';
import { researchRequest } from '../../backend/api/research.ts';

function storage() {
  const { DB, close } = sqliteD1();
  const objects = new Map();
  const BUCKET = {
    async put(key, bytes, metadata) { objects.set(key, { bytes, ...metadata }); },
    async list() { return { truncated: false, objects: [...objects].map(([key, item]) => ({ key, customMetadata: item.customMetadata })) }; },
    async get(key, options) {
      const item = objects.get(key); if (!item) return null;
      const match = options.range?.get('Range')?.match(/^bytes=(\d+)-(\d+)$/), range = match ? { offset: Number(match[1]), length: Number(match[2]) - Number(match[1]) + 1 } : null;
      return { size: item.bytes.byteLength, httpEtag: '"test"', writeHttpMetadata(headers) { headers.set('Content-Type', 'audio/wav'); }, body: range ? item.bytes.slice(range.offset, range.offset + range.length) : item.bytes, range };
    },
  };
  return { DB, BUCKET, close };
}
const state = { version: 1, paths: {}, noise_paths: {}, metrics: [], ratings: [] };
const request = (path, method = 'GET', body, headers = {}) => new Request('https://research.test' + path, { method, headers: { ...headers }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });

test('지표 대응용 배포 음원 목록과 재생은 DB·R2 없이 가능하고 응답 저장은 DB를 요구한다', async () => {
  const file = { path: 'data/clean/instruction_01.wav', size: 20, sha256: 'a'.repeat(64) };
  const env = { ASSETS: { async fetch() { return new Response('RIFFtestWAVEfixture'); } } };
  const catalog = { version: 1, files: [file] };
  const response = await researchRequest(request('/api/files'), env, catalog);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { files: [file.path], fingerprints: { [file.path]: file.sha256 } });
  const audio = await researchRequest(request('/' + file.path), env, catalog);
  assert.equal(audio.status, 200);
  for (const route of ['/api/study', '/api/backup', '/api/survey-sessions']) {
    assert.equal((await researchRequest(request(route), env, catalog)).status, 503);
  }
});

test('DB는 새 세션에서 응답을 유지하고 오래된 버전의 덮어쓰기를 거부한다', async () => {
  const env = storage();
  try {
    const initial = await (await researchRequest(request('/api/study'), env)).json(); assert.equal(initial.revision, 0);
    const rating = { listener_id: 'P001', sample_id: 'single_snr20_instruction_01_additional', understanding: 0, noise: 5, naturalness: 10, grading_version: 'v1', key_correct: 2, key_total: 3 };
    const saved = await researchRequest(request('/api/study', 'PUT', { revision: 0, state: { ...state, ratings: [rating] } }), env); assert.equal(saved.status, 200);
    const fresh = await (await researchRequest(request('/api/study'), env)).json(); assert.equal(fresh.revision, 1); assert.equal('understanding' in fresh.state.ratings[0], false); assert.equal(fresh.state.ratings[0].noise, 5);
    const stale = await researchRequest(request('/api/study', 'PUT', { revision: 0, state }), env); assert.equal(stale.status, 409);
    assert.equal((await stale.json()).state.ratings.length, 1);
    const invalid = await researchRequest(request('/api/study', 'PUT', { revision: 1, state: { ...state, ratings: [{ ...rating, noise: 9 }] } }), env); assert.equal(invalid.status, 400);
    assert.equal((await (await researchRequest(request('/api/study'), env)).json()).revision, 1);
    assert.equal((await researchRequest(request('/api/study', 'PUT', { revision: 1, state }, { Origin: 'https://elsewhere.test' }), env)).status, 403);
  } finally { env.close(); }
});

test('WAV 업로드 후 파일 목록·지문·부분 재생이 연결되며 잘못된 WAV를 거부한다', async () => {
  const env = storage();
  try {
    const id = 'single_snr20_instruction_01_ss_pattern_update';
    const bytes = 'RIFFtestWAVEaudio-fixture';
    assert.equal((await researchRequest(request('/api/audio?sample_id=' + id, 'PUT', bytes), env)).status, 200);
    const files = await (await researchRequest(request('/api/files'), env)).json();
    const path = 'outputs/ss_pattern_update/single/snr20/instruction_01.wav';
    assert.deepEqual(files.files, [path]); assert.match(files.fingerprints[path], /^[a-f0-9]{64}$/);
    const audio = await researchRequest(request('/' + path, 'GET', undefined, { Range: 'bytes=0-3' }), env);
    assert.equal(audio.status, 206); assert.equal(await audio.text(), 'RIFF'); assert.equal(audio.headers.get('Content-Range'), 'bytes 0-3/' + Buffer.byteLength(bytes));
    assert.equal((await researchRequest(request('/api/audio?sample_id=' + id, 'PUT', 'not a wave'), env)).status, 400);
    assert.equal((await researchRequest(request('/api/audio?sample_id=unknown', 'PUT', bytes), env)).status, 400);
  } finally { env.close(); }
});

test('로컬 배포 음원이 기존 업로드보다 우선하며 전체·HEAD·부분 재생을 지원한다', async () => {
  const env = storage();
  const bytes = Buffer.from('RIFFtestWAVEdeployed-audio');
  const path = 'data/clean/instruction_01.wav';
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const catalog = { version: 1, files: [{ path, size: bytes.length, sha256 }] };
  env.ASSETS = {
    async fetch(assetRequest) {
      assert.equal(new URL(assetRequest.url).pathname, '/dataset/audio/' + path);
      assert.equal(assetRequest.headers.get('Range'), null);
      return new Response(assetRequest.method === 'HEAD' ? null : bytes);
    },
  };
  const serve = (url, method = 'GET', headers = {}) => researchRequest(request(url, method, undefined, headers), env, catalog);
  try {
    await researchRequest(request('/api/audio?sample_id=clean_instruction_01', 'PUT', 'RIFFtestWAVEold-cloud-audio'), env, catalog);
    await researchRequest(request('/api/audio?sample_id=single_snr20_instruction_01_ss_fixed', 'PUT', 'RIFFtestWAVEcloud-output'), env, catalog);
    const files = await (await serve('/api/files')).json();
    assert.equal(files.files.length, 2);
    assert.equal(files.fingerprints[path], sha256);
    const complete = await serve('/' + path);
    assert.equal(complete.status, 200);
    assert.equal(await complete.text(), bytes.toString());
    assert.equal(complete.headers.get('Cache-Control'), 'no-store');
    const head = await serve('/' + path, 'HEAD');
    assert.equal(head.headers.get('Content-Length'), String(bytes.length));
    assert.equal(await head.text(), '');
    for (const [range, expected] of [['bytes=0-3', 'RIFF'], ['bytes=-5', 'audio'], ['bytes=12-', 'deployed-audio']]) {
      const response = await serve('/' + path, 'GET', { Range: range });
      assert.equal(response.status, 206);
      assert.equal(await response.text(), expected);
      assert.equal(response.headers.get('Content-Length'), String(expected.length));
    }
    const missingRange = await serve('/' + path, 'GET', { Range: 'bytes=999-1000' });
    assert.equal(missingRange.status, 416);
    assert.equal(missingRange.headers.get('Content-Range'), 'bytes */' + bytes.length);
    const oldVersion = await serve('/' + path, 'GET', { Range: 'bytes=0-3', 'If-Range': '"older-file"' });
    assert.equal(oldVersion.status, 200);
    assert.equal(await oldVersion.text(), bytes.toString());
    const cloud = await serve('/outputs/ss_fixed/single/snr20/instruction_01.wav');
    assert.equal(await cloud.text(), 'RIFFtestWAVEcloud-output');
  } finally { env.close(); }
});
