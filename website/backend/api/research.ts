// Public visitors can read audio and submit research records without signing in.
// Same-origin checks reject cross-site writes; revisions prevent stale updates.
import { SAMPLES, SAMPLE_INDEX, NOISE_SOURCES, localPath } from '../../shared/research/dataset.js';
import { normalizeBackup } from '../../shared/research/evaluation.js';
import audioCatalog from '../../.sites-runtime/backend/audio-catalog.json' with { type: 'json' };
import { loadStudy as load } from '../study/store.ts';
import { surveyRequest, surveyRatings, type AvailableAudio } from '../surveys/routes.ts';
import { backupRequest } from '../surveys/backup.ts';
import { prefilterListeningRequest } from '../surveys/prefilter.ts';

type AudioFile = { path: string; size: number; sha256: string };
type AudioCatalog = { version: number; files: AudioFile[] };

const MAX_STATE = 1_500_000;
const MAX_AUDIO = 30 * 1024 * 1024;
const security = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: security });

async function availableAudio(env: Cloudflare.Env, catalog: AudioCatalog): Promise<AvailableAudio> {
  const files: AvailableAudio = new Map();
  let cursor: string | undefined;
  if (env.BUCKET) {
    do {
      const options: R2ListOptions & { include: string[] } = { prefix: 'audio/', limit: 1000, cursor, include: ['customMetadata'] };
      const listing: R2Objects = await env.BUCKET.list(options);
      for (const item of listing.objects) if (item.customMetadata?.sha256) files.set(item.key.slice(6), { sha256: item.customMetadata.sha256, size: item.size });
      cursor = listing.truncated ? listing.cursor : undefined;
    } while (cursor);
  }
  if (env.ASSETS) for (const file of catalog.files) files.set(file.path, { sha256: file.sha256, size: file.size });
  return files;
}

function audioRange(header: string | null, size: number) {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  if (!Number.isSafeInteger(start) || start > end || (!match[1] && Number(match[2]) === 0)) return false;
  return { start, end };
}

async function packagedAudio(request: Request, assets: Fetcher, file: AudioFile) {
  const etag = '"' + file.sha256 + '"';
  const headers = new Headers({ ...security, 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'ETag': etag });
  const ifRange = request.headers.get('If-Range');
  const range = request.method === 'GET' && (!ifRange || ifRange === etag)
    ? audioRange(request.headers.get('Range'), file.size) : null;
  if (range === false) {
    headers.set('Content-Range', 'bytes */' + file.size);
    return new Response(null, { status: 416, headers });
  }
  const assetURL = new URL('/dataset/audio/' + file.path.split('/').map(encodeURIComponent).join('/'), request.url);
  const asset = await assets.fetch(new Request(assetURL, { method: request.method, headers: { 'Accept-Encoding': 'identity' } }));
  if (!asset.ok) return new Response('Deployed audio unavailable.', { status: asset.status, headers });
  if (range) {
    const bytes = await asset.arrayBuffer();
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return new Response(bytes.slice(range.start, range.end + 1), { status: 206, headers });
  }
  headers.set('Content-Length', String(file.size));
  return new Response(asset.body, { headers });
}

export async function researchRequest(request: Request, env: Cloudflare.Env, catalog: AudioCatalog = audioCatalog, listeningAssignment?: unknown): Promise<Response | null> {
  const url = new URL(request.url), pathname = url.pathname;
  const api = pathname.startsWith('/api/');
  const audioPath = /^\/(data\/(clean|noise|mixed)|outputs)\//.test(pathname);
  if (!api && !audioPath) return null;
  try {
    const needsDatabase = pathname === '/api/study' || pathname === '/api/backup' || pathname.startsWith('/api/survey-sessions') || pathname.startsWith('/api/prefilter-listening') || pathname === '/api/audio';
    if (needsDatabase && !env.DB) return json({ error: '청음 응답 저장소가 준비되지 않았습니다.' }, 503);
    if (pathname === '/api/audio' && !env.BUCKET) return json({ error: '음원 업로드 저장소가 준비되지 않았습니다.' }, 503);
    if (!['GET', 'HEAD'].includes(request.method)) {
      if ((request.headers.get('Origin') && request.headers.get('Origin') !== url.origin) || request.headers.get('Sec-Fetch-Site') === 'cross-site') return json({ error: '같은 사이트에서 요청하세요.' }, 403);
    }
    if (pathname.startsWith('/api/prefilter-listening')) return await prefilterListeningRequest(request, env.DB!, () => availableAudio(env, catalog), listeningAssignment);
    if (pathname.startsWith('/api/survey-sessions')) return await surveyRequest(request, env.DB!, () => availableAudio(env, catalog));
    if (pathname === '/api/backup') return await backupRequest(request, env.DB!);
    if (pathname === '/api/study' && request.method === 'GET') return json({ ...(await load(env.DB!)), survey_ratings: await surveyRatings(env.DB!) });
    if (pathname === '/api/study' && request.method === 'PUT') {
      const text = await request.text();
      if (new TextEncoder().encode(text).length > MAX_STATE) return json({ error: '응답 자료가 너무 큽니다. JSON으로 백업하고 자료를 분리하세요.' }, 413);
      const input = JSON.parse(text);
      if (!Number.isInteger(input.revision) || input.revision < 0) return json({ error: '저장 버전을 확인하세요.' }, 400);
      const state = normalizeBackup(input.state), now = new Date().toISOString();
      const qrKeys = new Set((await surveyRatings(env.DB!)).map(row => JSON.stringify([row.listener_id, row.sample_id])));
      if (state.ratings.some(row => qrKeys.has(JSON.stringify([row.listener_id, row.sample_id])))) return json({ error: '이미 저장된 QR 응답과 중복됩니다.' }, 400);
      const result = input.revision === 0
        ? await env.DB!.prepare('INSERT INTO study_state (id, revision, payload, updated_at) VALUES (?, 1, ?, ?) ON CONFLICT(id) DO NOTHING').bind('study', JSON.stringify(state), now).run()
        : await env.DB!.prepare('UPDATE study_state SET revision = revision + 1, payload = ?, updated_at = ? WHERE id = ? AND revision = ?').bind(JSON.stringify(state), now, 'study', input.revision).run();
      if (result.meta.changes !== 1) return json({ error: '다른 화면에서 자료가 변경되었습니다. 최신 결과를 확인하고 다시 저장하세요.', ...(await load(env.DB!)), survey_ratings: await surveyRatings(env.DB!) }, 409);
      return json({ state, revision: input.revision + 1, updated_at: now });
    }
    if (pathname === '/api/files' && request.method === 'GET') {
      const files = new Set<string>(), fingerprints: Record<string, string> = {};
      let cursor: string | undefined;
      if (env.BUCKET) {
        do {
          const options: R2ListOptions & { include: string[] } = { prefix: 'audio/', limit: 1000, cursor, include: ['customMetadata'] };
          const listing: R2Objects = await env.BUCKET.list(options);
          for (const item of listing.objects) {
            const path = item.key.slice(6); files.add(path);
            if (item.customMetadata?.sha256) fingerprints[path] = item.customMetadata.sha256;
          }
          cursor = listing.truncated ? listing.cursor : undefined;
        } while (cursor);
      }
      if (env.ASSETS) for (const file of catalog.files) {
        files.add(file.path); fingerprints[file.path] = file.sha256;
      }
      return json({ files: [...files].sort(), fingerprints });
    }
    if (pathname === '/api/audio' && request.method === 'PUT') {
      const id = url.searchParams.get('sample_id') || '';
      const sample = SAMPLE_INDEX.get(id) || NOISE_SOURCES.find(source => source.id === id);
      if (!sample) return json({ error: '음원 ID를 확인하세요.' }, 400);
      if (Number(request.headers.get('Content-Length')) > MAX_AUDIO) return json({ error: 'WAV는 30 MB 이하로 업로드하세요.' }, 413);
      const bytes = await request.arrayBuffer(), header = new TextDecoder('ascii').decode(bytes.slice(0, 12));
      if (bytes.byteLength > MAX_AUDIO || header.slice(0, 4) !== 'RIFF' || header.slice(8, 12) !== 'WAVE') return json({ error: '30 MB 이하 RIFF/WAVE 파일이 필요합니다.' }, 400);
      const { state } = await load(env.DB!);
      const paths = (sample.kind === 'noise' ? state.noise_paths : state.paths) as Record<string, string>;
      const path = localPath(paths[id] || sample.path);
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const sha256 = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
      await env.BUCKET!.put('audio/' + path, bytes, { httpMetadata: { contentType: 'audio/wav' }, customMetadata: { sample_id: id, sha256 } });
      return json({ sample_id: id, path, sha256 });
    }
    if (pathname === '/api/health' && request.method === 'GET') {
      const current = await load(env.DB!);
      return json({ status: 'ready', storage: 'D1 + R2', revision: current.revision, responses: current.state.ratings.length + (await surveyRatings(env.DB!)).length, sample_slots: SAMPLES.length });
    }
    if (audioPath && ['GET', 'HEAD'].includes(request.method)) {
      const path = localPath(decodeURIComponent(pathname.slice(1)));
      const file = catalog.files.find(file => file.path === path);
      if (file && env.ASSETS) return await packagedAudio(request, env.ASSETS, file);
      if (!env.BUCKET) return new Response('Audio storage unavailable.', { status: 503 });
      const key = 'audio/' + path;
      const object = request.method === 'HEAD' ? await env.BUCKET.head(key) : await env.BUCKET.get(key, { range: request.headers });
      if (!object) return new Response('Audio not available.', { status: 404, headers: security });
      const headers = new Headers(security); object.writeHttpMetadata(headers);
      headers.set('Accept-Ranges', 'bytes'); headers.set('ETag', object.httpEtag);
      let status = 200;
      if ('range' in object && object.range && 'offset' in object.range && 'length' in object.range && object.range.offset !== undefined && object.range.length !== undefined) {
        const { offset, length } = object.range; status = 206;
        headers.set('Content-Range', 'bytes ' + offset + '-' + (offset + length - 1) + '/' + object.size);
        headers.set('Content-Length', String(length));
      } else headers.set('Content-Length', String(object.size));
      return new Response('body' in object ? object.body as ReadableStream : null, { status, headers });
    }
    return json({ error: '지원하지 않는 요청입니다.' }, 405);
  } catch (error) {
    console.error('Research request failed:', error instanceof Error ? error.message : 'Unknown error');
    return json({ error: api && ['PUT', 'POST'].includes(request.method) ? error instanceof Error ? error.message : '입력값을 확인하세요.' : '저장소를 읽지 못했습니다. 잠시 후 다시 시도하세요.' }, api && ['PUT', 'POST'].includes(request.method) ? 400 : 503);
  }
}
