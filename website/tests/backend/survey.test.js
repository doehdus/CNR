import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { researchRequest } from '../../backend/api/research.ts';
import { QUESTIONNAIRE, newToken } from '../../backend/surveys/model.ts';
import { SAMPLE_INDEX } from '../../shared/research/dataset.js';
import { aggregateRatings } from '../../shared/research/evaluation.js';
import { correlationResults, pairedSamples } from '../../shared/research/correlation.js';
import { sqliteD1 } from '../helpers/sqlite-d1.mjs';

const ids = ['single_snr20_instruction_01_noisy', 'complex_snr05_instruction_02_ss_fixed', 'changing_snr00_warning_01_noisy'];
function fixture({ emptyState = false } = {}) {
  const storage = sqliteD1();
  // Test sessions use explicit fixture paths rather than the private deployment snapshot.
  if (!emptyState) storage.sqlite.prepare('INSERT INTO study_state (id, revision, payload, updated_at) VALUES (?, ?, ?, ?)').run(
    'study', 1, JSON.stringify({ version: 1, paths: Object.fromEntries(ids.map(id => [id, SAMPLE_INDEX.get(id).path])), noise_paths: {}, metrics: [], ratings: [] }), new Date().toISOString(),
  );
  const env = { DB: storage.DB, BUCKET: { async list() { return { objects: [], truncated: false }; } }, ASSETS: { async fetch() { return new Response('RIFFtestWAVEfixture'); } } };
  const catalog = { version: 1, files: ids.map(id => ({ path: SAMPLE_INDEX.get(id).path, sha256: 'a'.repeat(64), size: 20 })) };
  async function call(path, method = 'GET', body, token) {
    const response = await researchRequest(new Request('https://research.test' + path, {
      method, headers: token ? { Authorization: 'Bearer ' + token } : {},
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }), env, catalog);
    return { status: response.status, data: await response.json() };
  }
  async function create(sampleIds = ids) {
    const result = await call('/api/survey-sessions', 'POST', { title: 'QR listening test', sample_ids: sampleIds });
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
  }
  async function join(session, token = newToken()) {
    const path = '/api/survey-sessions/' + session.code;
    const result = await call(path + '/join', 'POST', { token }); assert.equal(result.status, 200);
    return { ...result.data, token, path };
  }
  async function action(session, action) {
    const path = '/api/survey-sessions/' + session.code;
    const view = await call(path, 'GET', undefined, session.control_token);
    const result = await call(path + '/control', 'POST', { action, revision: view.data.revision }, session.control_token);
    assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data;
  }
  async function answers(participant, correct = 3) {
    const view = await call(participant.path, 'GET', undefined, participant.token);
    assert.equal(view.status, 200);
    const sample = SAMPLE_INDEX.get(ids[view.data.current_index]);
    const questions = QUESTIONNAIRE.statements[sample.statement];
    const selected = Object.fromEntries(view.data.questions.map((question, index) => {
      const correctLabel = questions[index].options.find(option => option.id === questions[index].correct).label;
      return [question.id, index < correct ? question.options.find(option => option.label === correctLabel).id : 'unknown'];
    }));
    return { trial_index: view.data.current_index, answers: selected, noise: 7.5, naturalness: 10 };
  }
  return { ...storage, env, call, create, join, action, answers };
}

test('회차 생성 재전송은 동일한 진행 링크와 회차 하나를 보존한다', async () => {
  const f = fixture();
  try {
    const body = { title: 'Retry creation', sample_ids: ids, creation_token: newToken() };
    const results = await Promise.all(Array.from({ length: 8 }, () => f.call('/api/survey-sessions', 'POST', body)));
    assert.ok(results.every(result => result.status === 201));
    assert.equal(new Set(results.map(result => result.data.code)).size, 1);
    assert.equal((await f.call('/api/survey-sessions')).data.sessions.length, 1);
    assert.equal((await f.call('/api/survey-sessions', 'POST', { ...body, title: 'Changed request' })).status, 409);
  } finally { f.close(); }
});

test('QR 하나를 삭제하면 링크와 해당 회차 응답 전체를 제외하고 다른 QR·수동 자료를 유지한다', async () => {
  const f = fixture(), restored = fixture({ emptyState: true });
  try {
    const session = await f.create([ids[0]]), other = await f.create([ids[0]]);
    const people = [await f.join(session), await f.join(session)], survivor = await f.join(other);
    await f.action(session, 'start'); await f.action(session, 'open');
    await f.action(other, 'start'); await f.action(other, 'open');
    const body = await f.answers(people[0], 0);
    for (const person of people) await f.call(person.path + '/responses', 'POST', await f.answers(person), person.token);
    await f.call(survivor.path + '/responses', 'POST', await f.answers(survivor), survivor.token);
    let data = (await f.call('/api/study')).data;
    const manual = { ...data.survey_ratings[0], listener_id: 'P-manual', sample_id: ids[1] };
    assert.equal((await f.call('/api/study', 'PUT', { revision: data.revision, state: { ...data.state, ratings: [manual] } })).status, 200);
    const list = (await f.call('/api/survey-sessions')).data;
    const target = list.sessions.find(row => row.code === session.code);
    assert.equal(target.sample_count, 1); assert.equal(target.participant_count, 2); assert.equal(target.response_count, 2);
    const result = await f.call(people[0].path, 'DELETE', { revision: list.revision });
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.deleted_code, session.code);
    assert.equal(result.data.state.ratings.length, 1); assert.equal(result.data.survey_ratings.length, 1);
    assert.equal(result.data.survey_ratings[0].survey_session_code, other.code);
    assert.equal((await f.call('/api/survey-sessions')).data.sessions.some(row => row.code === session.code), false);
    for (const [path, method, input, token] of [[people[0].path,'GET',undefined,undefined], [people[0].path+'/join','POST',{token:people[0].token},undefined], [people[0].path+'/responses','POST',body,people[0].token], [people[0].path+'/control','POST',{action:'open',revision:0},session.control_token]]) {
      assert.equal((await f.call(path, method, input, token)).status, 410);
    }
    assert.equal((await f.call('/api/survey-sessions','POST',{title:'QR listening test',sample_ids:[ids[0]],creation_token:session.control_token})).status,410);
    const backup = (await f.call('/api/backup')).data;
    assert.equal(backup.survey.responses.length, 3); assert.equal(backup.survey.participants.length, 3);
    assert.ok(backup.survey.sessions.find(row => row.code === session.code).deleted_at);
    assert.ok(backup.survey.responses.every(row => row.deleted_at === null));
    assert.equal((await restored.call('/api/backup','PUT',{revision:0,backup})).status,200);
    assert.equal((await restored.call('/api/study')).data.survey_ratings.length,1);
    assert.equal((await restored.call(people[0].path)).status,410);
    const legacy = structuredClone(backup); legacy.survey.sessions.forEach(row => { delete row.deleted_at; }); legacy.survey.responses.forEach(row => { delete row.deleted_at; });
    assert.equal((await restored.call('/api/backup','PUT',{revision:1,backup:legacy})).status,200);
    assert.equal((await restored.call('/api/study')).data.survey_ratings.length,3);
  } finally { f.close(); restored.close(); }
});

test('응답 없는 QR도 삭제할 수 있고 잘못된 요청·오래된 버전·외부 출처는 거부한다', async () => {
  const f = fixture();
  try {
    const session = await f.create([ids[0]]), path = '/api/survey-sessions/' + session.code;
    const list = (await f.call('/api/survey-sessions')).data;
    assert.equal((await f.call(path,'DELETE',{})).status,400);
    assert.equal((await f.call(path,'DELETE',{revision:list.revision-1})).status,409);
    const cross = await researchRequest(new Request('https://research.test'+path,{method:'DELETE',headers:{Origin:'https://other.test'},body:JSON.stringify({revision:list.revision})}),f.env);
    assert.equal(cross.status,403);
    assert.equal((await f.call('/api/survey-sessions')).data.sessions.length,1);
    assert.equal((await f.call('/api/listening-responses','DELETE',{revision:list.revision,responses:[]})).status,405);
    assert.equal((await f.call(path,'DELETE',{revision:list.revision})).status,200);
    assert.equal((await f.call(path)).status,410);
    assert.equal((await f.call('/api/survey-sessions')).data.sessions.length,0);
  } finally { f.close(); }
});

test('QR 삭제 중 새 응답이 저장되면 회차 삭제 전체를 취소한다', async () => {
  const f = fixture();
  try {
    const session = await f.create([ids[0]]), person = await f.join(session);
    await f.action(session,'start'); await f.action(session,'open');
    await f.call(person.path+'/responses','POST',await f.answers(person),person.token);
    const list = (await f.call('/api/survey-sessions')).data, batch = f.env.DB.batch;
    f.env.DB.batch = async statements => {
      if (statements.some(statement => statement.sql.includes('UPDATE survey_sessions SET deleted_at'))) f.sqlite.exec("UPDATE study_state SET revision = revision + 1 WHERE id = 'study'");
      return batch(statements);
    };
    assert.equal((await f.call(person.path,'DELETE',{revision:list.revision})).status,409);
    assert.equal((await f.call('/api/study')).data.survey_ratings.length,1);
    assert.equal(f.sqlite.prepare('SELECT deleted_at FROM survey_sessions').get().deleted_at,null);
    assert.equal((await f.call(person.path)).status,200);
  } finally { f.close(); }
});

test('새 회차·참가·진행도 백업 버전을 갱신하고 재접속은 버전을 바꾸지 않는다', async () => {
  const f = fixture();
  try {
    const session = await f.create();
    const before = (await f.call('/api/study')).data.revision;
    const backup = (await f.call('/api/backup')).data;
    const person = await f.join(session);
    assert.equal((await f.call('/api/study')).data.revision, before + 1);
    assert.equal((await f.call('/api/backup', 'PUT', { revision: before, backup })).status, 409);
    await f.join(session, person.token);
    assert.equal((await f.call('/api/study')).data.revision, before + 1);
    await f.action(session, 'start');
    assert.equal((await f.call('/api/study')).data.revision, before + 2);
    await f.create([ids[0]]);
    assert.equal((await f.call('/api/study')).data.revision, before + 3);
  } finally { f.close(); }
});

test('세 문장의 객관식 0~3점 자동채점, 정답표 비공개 응답, 보기 순서·재접속을 검증한다', async () => {
  const f = fixture();
  try {
    const session = await f.create();
    const people = await Promise.all(Array.from({ length: 4 }, () => f.join(session)));
    const repeated = await f.join(session, people[0].token);
    assert.equal(repeated.participant_id, people[0].participant_id);
    const anonymous = await f.call(people[0].path);
    assert.equal(anonymous.data.samples, undefined);
    assert.equal(anonymous.data.control_hash, undefined);
    assert.equal(anonymous.data.questions, undefined);
    await f.action(session, 'start');
    for (let index = 0; index < 3; index++) {
      await f.action(session, 'open');
      const first = await f.call(people[0].path, 'GET', undefined, people[0].token);
      const again = await f.call(people[0].path, 'GET', undefined, people[0].token);
      assert.deepEqual(first.data.questions, again.data.questions);
      assert.ok(first.data.questions.every(question => !('correct' in question) && question.options.length === 5));
      assert.equal(first.data.current_sample, undefined);
      assert.ok(!JSON.stringify(first.data).includes(ids[index]));
      const submitted = await Promise.all(people.map(async (person, correct) => {
        const body = await f.answers(person, correct);
        const result = await f.call(person.path + '/responses', 'POST', { ...body, key_correct: 999, listener_id: 'spoof' }, person.token);
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(result.data.key_correct, undefined);
        return body;
      }));
      const rows = (await f.call('/api/study')).data.survey_ratings.filter(row => row.sample_id === ids[index]);
      assert.deepEqual(rows.map(row => row.key_correct).sort(), [0, 1, 2, 3]);
      assert.ok(rows.every(row => row.key_total === 3 && row.grading_version === 'qr-mc-v1' && row.listener_id.startsWith('QR-')));
      assert.ok(rows.every(row => !('understanding' in row) && row.noise === 7.5 && row.naturalness === 10));
      const saved = await f.call(people[0].path, 'GET', undefined, people[0].token);
      assert.equal(saved.data.submitted_current, true); assert.equal(saved.data.questions, undefined);
      if (index < 2) await f.action(session, 'next'); else await f.action(session, 'close');
      assert.equal((await f.call(people[0].path + '/responses', 'POST', submitted[0], people[0].token)).status, 200);
    }
    const all = (await f.call('/api/study')).data;
    assert.equal(all.survey_ratings.length, 12);
    assert.equal(all.state.ratings.length, 0);
    assert.ok(aggregateRatings(all.survey_ratings).every(row => row.key_rate === .5));
  } finally { f.close(); }
});

test('40명 동시 접수와 중복 재전송이 한 응답씩 저장되고 기존 자료 버전을 갱신한다', async () => {
  const f = fixture();
  try {
    const session = await f.create([ids[0]]);
    const people = await Promise.all(Array.from({ length: 40 }, () => f.join(session)));
    assert.equal(new Set(people.map(person => person.participant_id)).size, 40);
    await f.action(session, 'start'); await f.action(session, 'open');
    const before = (await f.call('/api/study')).data;
    const bodies = await Promise.all(people.map(person => f.answers(person)));
    const results = await Promise.all(people.flatMap((person, index) => [1, 2].map(() => f.call(person.path + '/responses', 'POST', bodies[index], person.token))));
    assert.ok(results.every(result => result.status === 200), JSON.stringify(results.filter(result => result.status !== 200)));
    const after = (await f.call('/api/study')).data;
    assert.equal(after.survey_ratings.length, 40); assert.equal(after.revision, before.revision + 40);
    const view = (await f.call(people[0].path, 'GET', undefined, session.control_token)).data;
    assert.equal(view.participants, 40); assert.equal(view.submitted, 40);
    const stale = await f.call('/api/study', 'PUT', { revision: before.revision, state: before.state });
    assert.equal(stale.status, 409); assert.equal(stale.data.survey_ratings.length, 40);
  } finally { f.close(); }
});

test('진행자 인증·진행 버전·마감된 문항·누락 답변을 검증하며 다른 음원에 응답을 붙이지 않는다', async () => {
  const f = fixture();
  try {
    const session = await f.create(); const person = await f.join(session);
    assert.equal((await f.call(person.path + '/control', 'POST', { action: 'start', revision: 0 }, person.token)).status, 403);
    assert.equal((await f.call(person.path, 'GET', undefined, newToken())).status, 401);
    await f.action(session, 'start'); await f.action(session, 'open');
    const body = await f.answers(person);
    assert.equal((await f.call(person.path + '/responses', 'POST', { ...body, answers: {} }, person.token)).status, 400);
    assert.equal((await f.call(person.path + '/responses', 'POST', { ...body, noise: null }, person.token)).status, 400);
    assert.equal((await f.call(person.path + '/control', 'POST', { action: 'next', revision: 0 }, session.control_token)).status, 409);
    await f.action(session, 'next');
    assert.equal((await f.call(person.path + '/responses', 'POST', body, person.token)).status, 409);
    assert.equal((await f.call('/api/study')).data.survey_ratings.length, 0);
    await f.action(session, 'close');
    assert.equal((await f.call(person.path + '/join', 'POST', { token: newToken() })).status, 409);
  } finally { f.close(); }
});

test('문항이 바뀌는 순간의 제출은 원래 문항에만 조건부 저장한다', async () => {
  const f = fixture();
  try {
    const session = await f.create(); const person = await f.join(session);
    await f.action(session, 'start'); await f.action(session, 'open'); const body = await f.answers(person);
    const batch = f.env.DB.batch;
    f.env.DB.batch = async statements => {
      if (statements.some(statement => statement.sql.includes('INSERT INTO survey_responses'))) f.sqlite.prepare("UPDATE survey_sessions SET current_index = 1, phase = 'listening', revision = revision + 1 WHERE code = ?").run(session.code);
      return batch(statements);
    };
    assert.equal((await f.call(person.path + '/responses', 'POST', body, person.token)).status, 409);
    assert.equal((await f.call('/api/study')).data.survey_ratings.length, 0);
  } finally { f.close(); }
});

test('QR 원자료를 포함한 v2 백업 복원과 v1 호환·무결성·중복 방지를 검증한다', async () => {
  const f = fixture(), restored = fixture({ emptyState: true });
  try {
    const session = await f.create([ids[0]]); const person = await f.join(session);
    await f.action(session, 'start'); await f.action(session, 'open');
    const body = await f.answers(person, 2);
    await f.call(person.path + '/responses', 'POST', body, person.token);
    const backup = (await f.call('/api/backup')).data;
    assert.equal(backup.version, 2); assert.equal(backup.survey.responses.length, 1);
    backup.survey.responses[0].rating = JSON.stringify({ ...JSON.parse(backup.survey.responses[0].rating), understanding: 7.5 });
    assert.equal((await restored.call('/api/backup', 'PUT', { revision: 0, backup })).status, 200);
    const data = (await restored.call('/api/study')).data;
    assert.equal(data.survey_ratings[0].key_correct, 2);
    assert.equal('understanding' in data.survey_ratings[0], false);
    assert.equal('understanding' in JSON.parse((await restored.call('/api/backup')).data.survey.responses[0].rating), false);
    assert.equal((await restored.call(person.path, 'GET', undefined, person.token)).data.submitted_current, true);
    const broken = structuredClone(backup);
    const row = JSON.parse(broken.survey.responses[0].rating); row.key_correct = 3;
    broken.survey.responses[0].rating = JSON.stringify(row);
    assert.equal((await restored.call('/api/backup', 'PUT', { revision: data.revision, backup: broken })).status, 400);
    assert.equal((await restored.call('/api/study')).data.survey_ratings[0].key_correct, 2);
    // Invalid external records must fail before replacing the saved QR response.
    for (const mutate of [
      value => { value.survey.sessions[0] = null; },
      value => { value.survey.participants[0].joined_at = 123; },
      value => { value.survey.responses[0].answers = []; },
    ]) {
      const malformed = structuredClone(backup);
      mutate(malformed);
      assert.equal((await restored.call('/api/backup', 'PUT', { revision: data.revision, backup: malformed })).status, 400);
      const unchanged = (await restored.call('/api/study')).data;
      assert.equal(unchanged.revision, data.revision);
      assert.equal(unchanged.survey_ratings[0].key_correct, 2);
    }
    assert.equal((await restored.call('/api/backup', 'PUT', { revision: data.revision, backup: backup.study })).status, 200);
    const preserved = (await restored.call('/api/study')).data;
    assert.equal(preserved.survey_ratings.length, 1);
    const duplicate = { ...preserved.state, ratings: preserved.survey_ratings };
    assert.equal((await restored.call('/api/study', 'PUT', { revision: preserved.revision, state: duplicate })).status, 400);
    const pair = pairedSamples([{ sample_id: ids[0], stoi: .8, estoi: .7 }], preserved.survey_ratings);
    assert.equal(pair[0].key_rate, 2 / 3); assert.equal(correlationResults(pair, 'key_rate').stoi.n, 1);
  } finally { f.close(); restored.close(); }
});

test('기존 이해도 삭제는 정오답·다른 점수·원응답을 보존하고 한 번만 버전을 갱신한다', async () => {
  const f = fixture();
  try {
    const session = await f.create([ids[0]]), person = await f.join(session);
    await f.action(session, 'start'); await f.action(session, 'open');
    const body = await f.answers(person, 2);
    assert.equal((await f.call(person.path + '/responses', 'POST', { ...body, naturalness: '' }, person.token)).status, 400);
    assert.equal((await f.call(person.path + '/responses', 'POST', body, person.token)).status, 200);
    const saved = f.sqlite.prepare('SELECT * FROM study_state').get();
    const state = JSON.parse(saved.payload);
    const manual = { listener_id: 'old-manual', sample_id: ids[1], understanding: 0, noise: 0, naturalness: 10, key_response: '원응답', grading_version: 'v1', key_correct: 0, key_total: 3, recorded_at: saved.updated_at };
    state.ratings = [manual];
    f.sqlite.prepare('UPDATE study_state SET payload = ?').run(JSON.stringify(state));
    const response = f.sqlite.prepare('SELECT * FROM survey_responses').get(), qr = JSON.parse(response.rating);
    f.sqlite.prepare('UPDATE survey_responses SET rating = ?').run(JSON.stringify({ ...qr, understanding: 7.5 }));
    const migration = readFileSync(new URL('../../backend/migrations/0004_remove_subjective_understanding.sql', import.meta.url), 'utf8');
    f.sqlite.exec(migration);
    const updated = f.sqlite.prepare('SELECT * FROM study_state').get();
    const expected = { ...manual };
    delete expected.understanding;
    assert.deepEqual(JSON.parse(updated.payload).ratings, [expected]);
    assert.deepEqual(JSON.parse(f.sqlite.prepare('SELECT rating FROM survey_responses').get().rating), qr);
    assert.equal(updated.revision, saved.revision + 1);
    f.sqlite.exec(migration);
    assert.equal(f.sqlite.prepare('SELECT revision FROM study_state').get().revision, updated.revision);
    assert.equal((await f.call(person.path + '/responses', 'POST', { ...body, understanding: 0 }, person.token)).status, 200);
  } finally { f.close(); }
});

test('백업 복원과 동시 제출의 버전 충돌은 QR 테이블 교체 전체를 취소한다', async () => {
  const f = fixture();
  try {
    const session = await f.create([ids[0]]); const person = await f.join(session);
    await f.action(session, 'start'); await f.action(session, 'open');
    await f.call(person.path + '/responses', 'POST', await f.answers(person), person.token);
    const backup = (await f.call('/api/backup')).data, revision = (await f.call('/api/study')).data.revision;
    const batch = f.env.DB.batch;
    f.env.DB.batch = async statements => {
      if (statements.some(statement => statement.sql === 'DELETE FROM survey_responses')) f.sqlite.exec("UPDATE study_state SET revision = revision + 1 WHERE id = 'study'");
      return batch(statements);
    };
    assert.equal((await f.call('/api/backup', 'PUT', { revision, backup })).status, 409);
    assert.equal((await f.call('/api/study')).data.survey_ratings.length, 1);
  } finally { f.close(); }
});
