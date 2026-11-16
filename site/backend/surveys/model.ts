import { SAMPLE_INDEX } from '../../shared/research/dataset.js';
import { normalizeRatings } from '../../shared/research/evaluation.js';

export type Question = { id: string; prompt: string; options: { id: string; label: string }[]; correct: string };
export type Questionnaire = { version: string; statements: Record<string, Question[]> };
export type SurveySample = { id: string; path: string; sha256: string };
export type SurveySession = {
  code: string; title: string; samples: string; questionnaire: string; control_hash: string;
  phase: 'waiting' | 'listening' | 'answering' | 'closed'; current_index: number; revision: number;
  created_at: string; updated_at: string;
  deleted_at: string | null;
};
export type SurveyParticipant = { id: string; session_code: string; token_hash: string; joined_at: string };
export type SurveyResponse = {
  id: string; session_code: string; participant_id: string; sample_id: string; trial_index: number;
  answers: string; choice_order: string; rating: string; recorded_at: string;
  deleted_at: string | null;
};
export type SurveyRating = {
  listener_id: string; sample_id: string; noise: number; naturalness: number;
  key_response: string; grading_version: string; key_correct: number; key_total: number; recorded_at: string;
};

function question(id: string, prompt: string, labels: string[]): Question {
  return { id, prompt, correct: 'a', options: [...labels.map((label, index) => ({ id: String.fromCharCode(97 + index), label })), { id: 'unknown', label: '모르겠음' }] };
}

export const QUESTIONNAIRE: Questionnaire = {
  version: 'qr-mc-v1',
  statements: {
    instruction_01: [
      question('action', '지시한 작업은 무엇인가요?', ['장비 이동', '장비 정지', '자재 적재', '장비 점검']),
      question('direction', '이동 방향은 어디인가요?', ['뒤로', '앞으로', '왼쪽', '오른쪽']),
      question('distance', '이동 거리는 얼마인가요?', ['2미터', '1미터', '3미터', '4미터']),
    ],
    instruction_02: [
      question('object', '옮길 물건은 무엇인가요?', ['각재', '철근', '시멘트', '배관']),
      question('quantity', '수량은 몇 개인가요?', ['3개', '1개', '2개', '4개']),
      question('destination', '옮길 장소는 어디인가요?', ['오른쪽 적재장', '왼쪽 적재장', '장비 뒤', '출입구 앞']),
    ],
    warning_01: [
      question('action', '즉시 해야 할 행동은 무엇인가요?', ['정지', '전진', '후진', '회전']),
      question('location', '위험이 있는 위치는 어디인가요?', ['장비 뒤', '장비 앞', '왼쪽 적재장', '출입구 밖']),
      question('hazard', '무엇이 있다고 했나요?', ['사람', '차량', '자재', '구덩이']),
    ],
  },
};

export class SurveyError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export async function hashToken(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), value => value.toString(16).padStart(2, '0')).join('');
}

export const newToken = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');

export function sessionSamples(session: SurveySession): SurveySample[] { return JSON.parse(session.samples); }

export function questionsFor(session: SurveySession, trialIndex: number): Question[] {
  const sample = sessionSamples(session)[trialIndex];
  const statement = sample && SAMPLE_INDEX.get(sample.id)?.statement;
  const questionnaire: Questionnaire = JSON.parse(session.questionnaire);
  if (!statement || !questionnaire.statements[statement]) throw new SurveyError(400, '평가 음원과 질문을 확인하세요.');
  return questionnaire.statements[statement];
}

export function participantQuestions(session: SurveySession, participantId: string) {
  return questionsFor(session, session.current_index).map(question => {
    // This seed keeps each participant's option order stable after reconnecting.
    let seed = 2166136261;
    for (const char of participantId + ':' + session.current_index + ':' + question.id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
    const options = question.options.filter(option => option.id !== 'unknown').map(option => {
      let identifier = 2166136261;
      for (const char of participantId + ':' + session.current_index + ':' + question.id + ':' + option.id) identifier = Math.imul(identifier ^ char.charCodeAt(0), 16777619) >>> 0;
      return { id: 'choice-' + identifier.toString(16), label: option.label };
    });
    for (let index = options.length - 1; index > 0; index--) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      const other = (seed >>> 0) % (index + 1);
      [options[index], options[other]] = [options[other], options[index]];
    }
    options.push({ id: 'unknown', label: '모르겠음' });
    return { id: question.id, prompt: question.prompt, options };
  });
}

export function gradeResponse(session: SurveySession, participantId: string, trialIndex: number, input: any, recordedAt: string) {
  if (!Number.isInteger(trialIndex) || trialIndex < 0 || trialIndex >= sessionSamples(session).length) throw new SurveyError(400, '음원 번호를 확인하세요.');
  const questions = questionsFor(session, trialIndex);
  const presented = participantQuestions({ ...session, current_index: trialIndex }, participantId);
  if (!input.answers || typeof input.answers !== 'object' || Array.isArray(input.answers) || Object.keys(input.answers).length !== questions.length) throw new SurveyError(400, '핵심정보 3문항에 모두 응답하세요.');
  const selected = questions.map((question, index) => {
    const option = presented[index].options.find(option => option.id === input.answers[question.id]);
    if (!option) throw new SurveyError(400, '각 질문의 보기 중 하나를 선택하세요.');
    return { question: question.prompt, answer: option.label };
  });
  const sample = sessionSamples(session)[trialIndex];
  const questionnaire: Questionnaire = JSON.parse(session.questionnaire);
  return normalizeRatings([{
    listener_id: 'QR-' + participantId, sample_id: sample.id,
    noise: input.noise, naturalness: input.naturalness,
    key_response: JSON.stringify(selected), grading_version: questionnaire.version,
    key_correct: questions.filter((question, index) => selected[index].answer === question.options.find(option => option.id === question.correct)?.label).length,
    key_total: questions.length, recorded_at: recordedAt,
  }])[0] as SurveyRating;
}

export function validateSession(row: any): SurveySession {
  if (row?.deleted_at != null && (typeof row.deleted_at !== 'string' || !Number.isFinite(Date.parse(row.deleted_at)) || row.phase !== 'closed')) throw new SurveyError(400, 'QR 회차의 삭제 기록을 확인하세요.');
  if (!row || !/^[a-f0-9]{12}$/.test(row.code) || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 100 || !/^[a-f0-9]{64}$/.test(row.control_hash)) throw new SurveyError(400, '회차 백업의 식별 정보를 확인하세요.');
  const samples: SurveySample[] = JSON.parse(row.samples);
  if (!Array.isArray(samples) || samples.length < 1 || samples.length > 180 || new Set(samples.map(sample => sample.id)).size !== samples.length) throw new SurveyError(400, '회차의 음원 목록을 확인하세요.');
  for (const sample of samples) {
    const known = SAMPLE_INDEX.get(sample.id);
    if (!known || known.kind === 'clean' || !/^(data\/mixed|outputs)\/[a-zA-Z0-9_./-]+\.wav$/.test(sample.path) || sample.path.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(sample.sha256)) throw new SurveyError(400, '회차 음원의 경로와 지문을 확인하세요.');
  }
  if (JSON.stringify(JSON.parse(row.questionnaire)) !== JSON.stringify(QUESTIONNAIRE)) throw new SurveyError(400, '지원되는 qr-mc-v1 질문표가 필요합니다.');
  if (!['waiting', 'listening', 'answering', 'closed'].includes(row.phase) || !Number.isInteger(row.current_index) || row.current_index < 0 || row.current_index >= samples.length || !Number.isInteger(row.revision) || row.revision < 0 || !Number.isFinite(Date.parse(row.created_at)) || !Number.isFinite(Date.parse(row.updated_at))) throw new SurveyError(400, '회차의 진행 상태를 확인하세요.');
  return row;
}
