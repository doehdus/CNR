import { SAMPLE_INDEX, normalizeManifest } from '../../shared/research/dataset.js';
import manifest from '../../.sites-runtime/backend/dataset.json' with { type: 'json' };
import { loadStudy, initializeStudy, advanceStudyIfChanged } from '../study/store.ts';
import {
  QUESTIONNAIRE, SurveyError, newToken, hashToken, sessionSamples, participantQuestions, gradeResponse,
  type SurveySession, type SurveyParticipant, type SurveyResponse, type SurveySample,
} from './model.ts';

export type AvailableAudio = Map<string, { sha256: string; size: number }>;
const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
const authorization = (request: Request) => request.headers.get('Authorization')?.replace(/^Bearer /, '') || '';

async function inputJSON(request: Request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).length > 65536) throw new SurveyError(413, '요청 내용이 너무 큽니다.');
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SurveyError(400, '요청 항목을 확인하세요.');
  return value;
}

async function findSession(db: D1Database, code: string) {
  const session = await db.prepare('SELECT * FROM survey_sessions WHERE code = ?').bind(code).first<SurveySession>();
  if (!session) throw new SurveyError(404, '평가 회차를 찾지 못했습니다. QR 주소를 확인하세요.');
  if (session.deleted_at) throw new SurveyError(410, '삭제된 QR입니다. 진행자에게 새 QR을 요청하세요.');
  return session;
}

async function findParticipant(db: D1Database, code: string, token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new SurveyError(401, '참가 정보가 필요합니다. 다시 접속하세요.');
  const participant = await db.prepare('SELECT * FROM survey_participants WHERE session_code = ? AND token_hash = ?')
    .bind(code, await hashToken(token)).first<SurveyParticipant>();
  if (!participant) throw new SurveyError(401, '이 회차의 참가 정보를 확인하세요.');
  return participant;
}

async function requireControl(request: Request, session: SurveySession) {
  if (await hashToken(authorization(request)) !== session.control_hash) throw new SurveyError(403, '진행자 링크로 접속하세요.');
}

async function sessionView(request: Request, db: D1Database, session: SurveySession) {
  const token = authorization(request);
  const isControl = Boolean(token) && await hashToken(token) === session.control_hash;
  const participant = !isControl && token ? await findParticipant(db, session.code, token) : null;
  const samples = sessionSamples(session);
  const counts = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM survey_participants WHERE session_code = ?) AS participants,
    (SELECT COUNT(*) FROM survey_responses WHERE session_code = ? AND trial_index = ? AND deleted_at IS NULL) AS submitted`)
    .bind(session.code, session.code, session.current_index).first<{ participants: number; submitted: number }>();
  const response = participant ? await db.prepare('SELECT id FROM survey_responses WHERE participant_id = ? AND trial_index = ?')
    .bind(participant.id, session.current_index).first() : null;
  return {
    code: session.code, title: session.title, phase: session.phase, current_index: session.current_index,
    total: samples.length, revision: session.revision, ...counts,
    ...(isControl ? { samples, current_sample: samples[session.current_index], grading_version: QUESTIONNAIRE.version } : {}),
    ...(participant ? {
      participant_id: participant.id, listener_id: 'QR-' + participant.id,
      participant_label: 'P-' + participant.id.slice(-8).toUpperCase(), submitted_current: Boolean(response),
      ...(session.phase === 'answering' && !response ? { questions: participantQuestions(session, participant.id) } : {}),
    } : {}),
  };
}

async function createSession(request: Request, db: D1Database, available: () => Promise<AvailableAudio>) {
  const input = await inputJSON(request);
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title || title.length > 100 || !Array.isArray(input.sample_ids) || input.sample_ids.length < 1 || input.sample_ids.length > 180 || new Set(input.sample_ids).size !== input.sample_ids.length) throw new SurveyError(400, '회차 이름과 중복 없는 평가 음원을 선택하세요.');
  const controlToken = input.creation_token ?? newToken();
  if (!/^[a-f0-9]{64}$/.test(controlToken)) throw new SurveyError(400, '회차 생성 요청을 확인하세요.');
  const code = (await hashToken('session:' + controlToken)).slice(0, 12), controlHash = await hashToken(controlToken);
  const acknowledge = (existing: SurveySession) => {
    if (existing.deleted_at) throw new SurveyError(410, '삭제한 QR 회차입니다. 새 회차를 만들어 주세요.');
    if (existing.control_hash !== controlHash || existing.title !== title || JSON.stringify(sessionSamples(existing).map(sample => sample.id)) !== JSON.stringify(input.sample_ids)) throw new SurveyError(409, '이 생성 요청의 회차가 이미 등록되었습니다. 회차 목록을 확인하세요.');
    return json({ code, control_token: controlToken, participant_url: new URL('/website/survey.html?session=' + code, request.url).href }, 201);
  };
  const existing = await db.prepare('SELECT * FROM survey_sessions WHERE code = ?').bind(code).first<SurveySession>();
  if (existing) return acknowledge(existing);
  const files = await available(), { state } = await loadStudy(db);
  const paths: Record<string, string> = { ...normalizeManifest(manifest), ...state.paths };
  const samples: SurveySample[] = input.sample_ids.map((id: string) => {
    const sample = SAMPLE_INDEX.get(id), path = paths[id];
    const file = files.get(path);
    if (!sample || sample.kind === 'clean' || !file) throw new SurveyError(400, '연결된 무처리·처리 음원만 선택할 수 있습니다.');
    return { id, path, sha256: file.sha256 };
  });
  const now = new Date().toISOString();
  await db.batch([
    initializeStudy(db, now),
    db.prepare('INSERT INTO survey_sessions (code, title, samples, questionnaire, control_hash, phase, current_index, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?) ON CONFLICT(code) DO NOTHING')
      .bind(code, title, JSON.stringify(samples), JSON.stringify(QUESTIONNAIRE), controlHash, 'waiting', now, now),
    advanceStudyIfChanged(db, now),
  ]);
  return acknowledge(await findSession(db, code));
}

async function joinSession(request: Request, db: D1Database, session: SurveySession) {
  const input = await inputJSON(request);
  if (!/^[a-f0-9]{64}$/.test(input.token)) throw new SurveyError(400, '참가 토큰을 확인하세요.');
  const hash = await hashToken(input.token), id = session.code + '-' + crypto.randomUUID().replaceAll('-', '');
  const now = new Date().toISOString();
  await db.batch([db.prepare(`INSERT INTO survey_participants (id, session_code, token_hash, joined_at)
    SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM survey_sessions WHERE code = ? AND phase != 'closed' AND deleted_at IS NULL)
    ON CONFLICT(session_code, token_hash) DO NOTHING`)
    .bind(id, session.code, hash, now, session.code), advanceStudyIfChanged(db, now)]);
  const participant = await db.prepare('SELECT * FROM survey_participants WHERE session_code = ? AND token_hash = ?')
    .bind(session.code, hash).first<SurveyParticipant>();
  if (!participant) throw new SurveyError(409, '종료된 회차입니다. 새 회차의 QR을 확인하세요.');
  return json({ participant_id: participant.id, participant_label: 'P-' + participant.id.slice(-8).toUpperCase() });
}

async function controlSession(request: Request, db: D1Database, session: SurveySession) {
  await requireControl(request, session);
  const input = await inputJSON(request);
  if (input.revision !== session.revision) throw new SurveyError(409, '진행 상태가 바뀌었습니다. 최신 화면을 확인하세요.');
  let phase = session.phase, index = session.current_index;
  switch (input.action) {
    case 'start':
      if (phase !== 'waiting') throw new SurveyError(409, '대기 중인 회차에서 시작하세요.');
      phase = 'listening'; break;
    case 'open':
      if (phase !== 'listening') throw new SurveyError(409, '음원을 재생한 뒤 응답을 여세요.');
      phase = 'answering'; break;
    case 'next':
      if (!['listening', 'answering'].includes(phase) || index + 1 >= sessionSamples(session).length) throw new SurveyError(409, '다음 음원이 없습니다. 회차를 종료하세요.');
      index++; phase = 'listening'; break;
    case 'close': phase = 'closed'; break;
    default: throw new SurveyError(400, '진행 동작을 확인하세요.');
  }
  const now = new Date().toISOString();
  const [result] = await db.batch([
    db.prepare('UPDATE survey_sessions SET phase = ?, current_index = ?, revision = revision + 1, updated_at = ? WHERE code = ? AND revision = ? AND deleted_at IS NULL')
      .bind(phase, index, now, session.code, session.revision),
    advanceStudyIfChanged(db, now),
  ]);
  if (result.meta.changes !== 1) throw new SurveyError(409, '다른 진행 화면에서 상태가 변경되었습니다.');
  return json(await sessionView(request, db, await findSession(db, session.code)));
}

async function submitResponse(request: Request, db: D1Database, session: SurveySession) {
  const participant = await findParticipant(db, session.code, authorization(request)), input = await inputJSON(request);
  const trialIndex = input.trial_index, now = new Date().toISOString();
  const rating = gradeResponse(session, participant.id, trialIndex, input, now);
  const questions = participantQuestions({ ...session, current_index: trialIndex }, participant.id);
  const answers = JSON.stringify(Object.fromEntries(questions.map(question => [question.id, input.answers[question.id]])));
  const findExisting = () => db.prepare('SELECT * FROM survey_responses WHERE participant_id = ? AND trial_index = ?').bind(participant.id, trialIndex).first<SurveyResponse>();
  const acknowledge = (existing: SurveyResponse) => {
    const saved = JSON.parse(existing.rating);
    if (existing.answers !== answers || (['noise', 'naturalness'] as const).some(key => saved[key] !== rating[key])) throw new SurveyError(409, '이미 접수한 음원입니다. 제출 결과를 확인하세요.');
    return json({ accepted: true, trial_index: trialIndex, recorded_at: existing.recorded_at });
  };
  const existing = await findExisting();
  if (existing) return acknowledge(existing);
  if (session.phase !== 'answering' || session.current_index !== trialIndex) throw new SurveyError(409, '이 음원의 응답 시간이 종료되었습니다. 현재 음원 번호를 확인하세요.');
  const sample = sessionSamples(session)[trialIndex];
  await db.batch([
    initializeStudy(db, now),
    db.prepare(`INSERT INTO survey_responses (id, session_code, participant_id, sample_id, trial_index, answers, choice_order, rating, recorded_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
      (SELECT 1 FROM survey_sessions WHERE code = ? AND phase = 'answering' AND current_index = ? AND revision = ? AND deleted_at IS NULL)
      ON CONFLICT(participant_id, sample_id) DO NOTHING`)
      .bind(participant.id + ':' + trialIndex, session.code, participant.id, sample.id, trialIndex, answers,
        JSON.stringify(questions.map(question => ({ id: question.id, options: question.options.map(option => option.id) }))), JSON.stringify(rating), now,
        session.code, trialIndex, session.revision),
    advanceStudyIfChanged(db, now),
  ]);
  const saved = await findExisting();
  if (!saved) throw new SurveyError(409, '진행 상태가 바뀌어 접수하지 못했습니다. 현재 음원 번호를 확인하세요.');
  return acknowledge(saved);
}

export async function surveyRatings(db: D1Database) {
  const result = await db.prepare(`SELECT r.id, r.session_code, r.rating FROM survey_responses r JOIN survey_sessions s ON s.code = r.session_code
    WHERE r.deleted_at IS NULL AND s.deleted_at IS NULL ORDER BY r.recorded_at, r.id`).all<{ id: string; session_code: string; rating: string }>();
  return result.results.map(row => ({ ...JSON.parse(row.rating), survey_response_id: row.id, survey_session_code: row.session_code }));
}

async function listSessions(db: D1Database) {
  const snapshot = await db.batch([
    db.prepare('SELECT revision FROM study_state WHERE id = ?').bind('study'),
    db.prepare(`SELECT s.code, s.title, s.phase, s.created_at, json_array_length(s.samples) AS sample_count,
      (SELECT COUNT(*) FROM survey_participants p WHERE p.session_code = s.code) AS participant_count,
      (SELECT COUNT(*) FROM survey_responses r WHERE r.session_code = s.code AND r.deleted_at IS NULL) AS response_count
      FROM survey_sessions s WHERE s.deleted_at IS NULL ORDER BY s.created_at DESC`),
  ]);
  return { sessions: snapshot[1].results, revision: (snapshot[0].results[0] as { revision: number } | undefined)?.revision || 0 };
}

async function deleteSession(request: Request, db: D1Database, session: SurveySession) {
  const input = await inputJSON(request), current = await loadStudy(db);
  if (!Number.isInteger(input.revision)) throw new SurveyError(400, '삭제할 QR 목록을 다시 확인하세요.');
  if (input.revision !== current.revision) throw new SurveyError(409, '회차 자료가 변경되었습니다. 최신 QR 목록에서 다시 선택하세요.');
  const now = new Date().toISOString();
  try {
    await db.batch([
      db.prepare(`UPDATE study_state SET payload = CASE WHEN revision = ? THEN payload ELSE NULL END,
        revision = revision + 1, updated_at = ? WHERE id = ?`).bind(input.revision, now, 'study'),
      db.prepare("UPDATE survey_sessions SET deleted_at = ?, phase = 'closed', revision = revision + 1, updated_at = ? WHERE code = ? AND deleted_at IS NULL").bind(now, now, session.code),
    ]);
  } catch (error) {
    if ((await loadStudy(db)).revision !== current.revision) throw new SurveyError(409, '삭제 중 자료가 변경되었습니다. 최신 QR 목록을 확인하세요.');
    throw error;
  }
  return json({ deleted_code: session.code, ...(await loadStudy(db)), survey_ratings: await surveyRatings(db) });
}

export async function surveyRequest(request: Request, db: D1Database, available: () => Promise<AvailableAudio>): Promise<Response> {
  try {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/api/survey-sessions') {
      if (request.method === 'POST') return await createSession(request, db, available);
      if (request.method === 'GET') {
        return json(await listSessions(db));
      }
    }
    const match = pathname.match(/^\/api\/survey-sessions\/([a-f0-9]{12})(?:\/(join|control|responses))?$/);
    if (!match) throw new SurveyError(404, '평가 회차 주소를 확인하세요.');
    const session = await findSession(db, match[1]);
    if (!match[2] && request.method === 'GET') return json(await sessionView(request, db, session));
    if (!match[2] && request.method === 'DELETE') return await deleteSession(request, db, session);
    if (request.method === 'POST') {
      if (match[2] === 'join') return await joinSession(request, db, session);
      if (match[2] === 'control') return await controlSession(request, db, session);
      if (match[2] === 'responses') return await submitResponse(request, db, session);
    }
    throw new SurveyError(405, '지원하지 않는 요청입니다.');
  } catch (error) {
    if (error instanceof SurveyError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError || error instanceof Error && /선택|응답|신호|채점|평가|음원/.test(error.message)) return json({ error: error.message }, 400);
    console.error('Survey request failed', error instanceof Error ? error.message : 'Unknown error');
    return json({ error: '질문지 저장소를 확인하지 못했습니다. 잠시 후 다시 시도하세요.' }, 503);
  }
}
