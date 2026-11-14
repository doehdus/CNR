import { normalizeBackup, normalizeRatings, ratingKey } from '../public/website/js/evaluation.js';
import { normalizeManifest, normalizeNoiseSources } from '../public/website/js/dataset.js';
import { normalizeMetrics, mergeMetrics } from '../public/website/js/metrics.js';
import manifest from '../public/data/metadata/dataset.json' with { type: 'json' };
import metrics from '../public/metrics/results/stoi_estoi.json' with { type: 'json' };
import { EMPTY_STUDY, loadStudy } from './study-store.ts';
import { gradeResponse, participantQuestions, sessionSamples, validateSession, SurveyError, type SurveySession, type SurveyParticipant, type SurveyResponse } from './survey-model.ts';

type SurveyBackup = { sessions: SurveySession[]; participants: SurveyParticipant[]; responses: SurveyResponse[] };
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

function validateSurveyBackup(input: any, manualRatings: any[]): SurveyBackup {
  if (!input || !['sessions', 'participants', 'responses'].every(key => Array.isArray(input[key]))) throw new SurveyError(400, 'QR 백업의 회차·참가자·원응답 배열이 필요합니다.');
  const sessions = input.sessions.map(validateSession) as SurveySession[];
  const sessionMap = new Map(sessions.map(row => [row.code, row]));
  if (sessionMap.size !== sessions.length) throw new SurveyError(400, '중복 회차가 있습니다.');
  const participants: SurveyParticipant[] = input.participants;
  const participantMap = new Map<string, SurveyParticipant>();
  const tokens = new Set<string>();
  for (const row of participants) {
    if (!row || typeof row !== 'object') throw new SurveyError(400, 'QR 참가자 항목을 확인하세요.');
    const tokenKey = row.session_code + ':' + row.token_hash;
    if (!sessionMap.has(row.session_code) || typeof row.id !== 'string' || !new RegExp('^' + row.session_code + '-[a-f0-9]{32}$').test(row.id) || !/^[a-f0-9]{64}$/.test(row.token_hash) || !Number.isFinite(Date.parse(row.joined_at)) || participantMap.has(row.id) || tokens.has(tokenKey)) throw new SurveyError(400, 'QR 참가자 정보를 확인하세요.');
    participantMap.set(row.id, row); tokens.add(tokenKey);
  }
  const responses: SurveyResponse[] = input.responses;
  const identifiers = new Set<string>(), keys = new Set(manualRatings.map(ratingKey));
  for (const row of responses) {
    if (!row || typeof row !== 'object') throw new SurveyError(400, 'QR 원응답 항목을 확인하세요.');
    const session = sessionMap.get(row.session_code), participant = participantMap.get(row.participant_id);
    if (!session || !participant || participant.session_code !== session.code || row.id !== participant.id + ':' + row.trial_index || identifiers.has(row.id) || !Number.isFinite(Date.parse(row.recorded_at))) throw new SurveyError(400, 'QR 원응답의 회차·참가자·문항을 확인하세요.');
    const saved = normalizeRatings([JSON.parse(row.rating)])[0];
    const answers = JSON.parse(row.answers);
    const expected = gradeResponse(session, participant.id, row.trial_index, { ...saved, answers }, row.recorded_at);
    if (row.deleted_at != null && (typeof row.deleted_at !== 'string' || !Number.isFinite(Date.parse(row.deleted_at)))) throw new SurveyError(400, 'QR 응답의 삭제 시각을 확인하세요.');
    if (row.sample_id !== sessionSamples(session)[row.trial_index]?.id || JSON.stringify(saved) !== JSON.stringify(expected) || !row.deleted_at && !session.deleted_at && keys.has(ratingKey(saved))) throw new SurveyError(400, 'QR 자동채점 값 또는 중복 응답을 확인하세요.');
    const questions = participantQuestions({ ...session, current_index: row.trial_index }, participant.id);
    const order = questions.map(question => ({ id: question.id, options: question.options.map(option => option.id) }));
    if (JSON.stringify(JSON.parse(row.choice_order)) !== JSON.stringify(order)) throw new SurveyError(400, '객관식 보기 순서 기록을 확인하세요.');
    identifiers.add(row.id); if (!row.deleted_at && !session.deleted_at) keys.add(ratingKey(saved));
  }
  return { sessions, participants, responses };
}

function insertRows(db: D1Database, table: string, columns: string[], rows: any[]) {
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < rows.length; offset += 100) {
    // JSON batches keep bound parameters and statement count bounded for D1.
    const selection = columns.map(column => `json_extract(value, '$.${column}')`).join(', ');
    statements.push(db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) SELECT ${selection} FROM json_each(?)`)
      .bind(JSON.stringify(rows.slice(offset, offset + 100))));
  }
  return statements;
}

export async function backupRequest(request: Request, db: D1Database): Promise<Response> {
  try {
    if (request.method === 'GET') {
      const snapshot = await db.batch([
        db.prepare('SELECT * FROM study_state WHERE id = ?').bind('study'),
        db.prepare('SELECT * FROM survey_sessions ORDER BY code'),
        db.prepare('SELECT * FROM survey_participants ORDER BY id'),
        db.prepare('SELECT * FROM survey_responses ORDER BY id'),
      ]);
      const record = snapshot[0].results[0] as { payload: string; revision: number } | undefined;
      const study = normalizeBackup(record ? JSON.parse(record.payload) : structuredClone(EMPTY_STUDY));
      study.paths = { ...normalizeManifest(manifest), ...study.paths };
      study.noise_paths = { ...normalizeNoiseSources(manifest.noise_sources), ...study.noise_paths };
      study.metrics = mergeMetrics(study.metrics, normalizeMetrics(metrics));
      return json({ version: 2, study, survey: { sessions: snapshot[1].results, participants: snapshot[2].results, responses: snapshot[3].results }, revision: record?.revision || 0, exported_at: new Date().toISOString() });
    }
    if (request.method !== 'PUT') return json({ error: '지원하지 않는 요청입니다.' }, 405);
    const text = await request.text();
    if (new TextEncoder().encode(text).length > 10 * 1024 * 1024) return json({ error: '백업은 10 MiB 이내로 준비하세요.' }, 413);
    const input = JSON.parse(text), current = await loadStudy(db);
    if (!input || typeof input !== 'object') throw new SurveyError(400, '복원 요청 항목을 확인하세요.');
    if (!Number.isInteger(input.revision) || input.revision !== current.revision) throw new SurveyError(409, '자료가 변경되었습니다. 최신 화면에서 다시 복원하세요.');
    const backup = input.backup;
    const study = normalizeBackup(backup?.version === 2 ? backup.study : backup);
    const survey = backup?.version === 2 ? validateSurveyBackup(backup.survey, study.ratings) : null;
    if (!survey) {
      const existing = await db.prepare('SELECT r.rating FROM survey_responses r JOIN survey_sessions s ON s.code = r.session_code WHERE r.deleted_at IS NULL AND s.deleted_at IS NULL').all<{ rating: string }>();
      const keys = new Set(study.ratings.map(ratingKey));
      if (existing.results.some(row => keys.has(ratingKey(JSON.parse(row.rating))))) throw new SurveyError(400, '현재 QR 응답과 중복되는 수동 응답이 있습니다.');
    }
    const now = new Date().toISOString();
    // A stale revision violates the payload NOT NULL constraint, rolling back
    // the entire D1 batch before any QR records can be replaced.
    const statements = [db.prepare(`INSERT INTO study_state (id, revision, payload, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET payload = CASE WHEN study_state.revision = ? THEN excluded.payload ELSE NULL END,
      revision = excluded.revision, updated_at = excluded.updated_at`)
      .bind('study', current.revision + 1, JSON.stringify(study), now, current.revision)];
    if (survey) statements.push(
      db.prepare('DELETE FROM survey_responses'), db.prepare('DELETE FROM survey_participants'), db.prepare('DELETE FROM survey_sessions'),
      ...insertRows(db, 'survey_sessions', ['code', 'title', 'samples', 'questionnaire', 'control_hash', 'phase', 'current_index', 'revision', 'created_at', 'updated_at', 'deleted_at'], survey.sessions),
      ...insertRows(db, 'survey_participants', ['id', 'session_code', 'token_hash', 'joined_at'], survey.participants),
      ...insertRows(db, 'survey_responses', ['id', 'session_code', 'participant_id', 'sample_id', 'trial_index', 'answers', 'choice_order', 'rating', 'recorded_at', 'deleted_at'], survey.responses),
    );
    try { await db.batch(statements); }
    catch (error) {
      if ((await loadStudy(db)).revision !== current.revision) throw new SurveyError(409, '복원 중 자료가 변경되었습니다. 최신 화면에서 다시 시도하세요.');
      throw error;
    }
    return json({ restored: true, revision: current.revision + 1, legacy_backup: !survey });
  } catch (error) {
    if (error instanceof SurveyError) return json({ error: error.message }, error.status);
    if (error instanceof SyntaxError || error instanceof Error && /백업|응답|채점|평가|경로|음원|지표/.test(error.message)) return json({ error: error.message }, 400);
    console.error('Backup request failed', error instanceof Error ? error.message : 'Unknown error');
    return json({ error: '백업을 처리하지 못했습니다. 원본 파일을 보관하고 다시 시도하세요.' }, 503);
  }
}
