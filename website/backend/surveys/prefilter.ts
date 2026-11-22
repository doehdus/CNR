import snapshot from '../../.sites-runtime/backend/prefilter-listening.json' with {type:'json'};
import {LISTENING_STUDY,listeningTrials,normalizeListeningAssignment} from '../../shared/research/prefilter-listening-data.js';
import {PREFILTER_QUESTIONS,PREFILTER_QUESTION_VERSION} from './prefilter-questions.ts';
import {hashToken,SurveyError} from './model.ts';
import type {AvailableAudio} from './routes.ts';

type Participant={id:string;study_id:string;group_id:string;token_hash:string;order_json:string;joined_at:string};
type ResponseRow={payload:string;trial_index:number;recorded_at:string};
const json=(data:unknown,status=200)=>Response.json(data,{status,headers:{'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
const ddl=[
 'CREATE TABLE IF NOT EXISTS prefilter_listening_studies (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, snapshot TEXT NOT NULL, created_at TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS prefilter_listening_participants (id TEXT PRIMARY KEY, study_id TEXT NOT NULL REFERENCES prefilter_listening_studies(id), group_id TEXT NOT NULL, token_hash TEXT NOT NULL, order_json TEXT NOT NULL, joined_at TEXT NOT NULL, UNIQUE(study_id, token_hash))',
 'CREATE TABLE IF NOT EXISTS prefilter_listening_plays (id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES prefilter_listening_participants(id), trial_index INTEGER NOT NULL, recorded_at TEXT NOT NULL)',
 'CREATE TABLE IF NOT EXISTS prefilter_listening_responses (id TEXT PRIMARY KEY, participant_id TEXT NOT NULL REFERENCES prefilter_listening_participants(id), trial_index INTEGER NOT NULL, pair_index INTEGER NOT NULL, mode TEXT NOT NULL, payload TEXT NOT NULL, choice_order TEXT NOT NULL, noise INTEGER NOT NULL, naturalness INTEGER NOT NULL, key_correct INTEGER NOT NULL, recorded_at TEXT NOT NULL, UNIQUE(participant_id, trial_index))',
 'CREATE INDEX IF NOT EXISTS prefilter_listening_plays_trial ON prefilter_listening_plays(participant_id,trial_index)',
 'CREATE INDEX IF NOT EXISTS prefilter_listening_participants_group ON prefilter_listening_participants(study_id,group_id)',
];
async function setup(db:D1Database) {
 if(!snapshot)throw new SurveyError(503,'확정된 청음평가 음원 배정표가 없습니다.');
 const assignment=normalizeListeningAssignment(snapshot);
 const content=JSON.stringify({assignment,question_version:PREFILTER_QUESTION_VERSION,questions:PREFILTER_QUESTIONS,scale:'likert-1-5-v1'});
 const fingerprint=await hashToken(content);
 await db.batch([...ddl.map(sql=>db.prepare(sql)),db.prepare('INSERT OR IGNORE INTO prefilter_listening_studies (id,fingerprint,snapshot,created_at) VALUES (?,?,?,?)').bind(LISTENING_STUDY,fingerprint,content,new Date().toISOString())]);
 const frozen=await db.prepare('SELECT fingerprint FROM prefilter_listening_studies WHERE id=?').bind(LISTENING_STUDY).first<{fingerprint:string}>();
 if(frozen?.fingerprint!==fingerprint)throw new SurveyError(503,'평가 자료 버전이 달라 접속을 보류했습니다. 진행자에게 문의해 주세요.');
 return assignment;
}
async function input(request:Request):Promise<any> {
 const text=await request.text();if(new TextEncoder().encode(text).length>12000)throw new SurveyError(413,'응답이 너무 큽니다.');
 try{return JSON.parse(text);}catch{throw new SurveyError(400,'응답 형식을 확인하세요.');}
}
function token(value:unknown):string {if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))throw new SurveyError(401,'참가 정보가 없습니다. 참여 링크에서 다시 접속해 주세요.');return value;}
async function participant(request:Request,db:D1Database,group:string,provided?:string) {
 const hash=await hashToken(token(provided||request.headers.get('Authorization')?.replace(/^Bearer /,'')));
 const person=await db.prepare('SELECT * FROM prefilter_listening_participants WHERE study_id=? AND token_hash=?').bind(LISTENING_STUDY,hash).first<Participant>();
 if(!person)throw new SurveyError(401,'참여 시작을 눌러 주세요.');
 if(person.group_id!==group)throw new SurveyError(409,`이미 그룹 ${person.group_id} 평가에 참여 중입니다. 해당 그룹 링크로 접속해 주세요.`);
 return person;
}
function hash(value:string) {let n=2166136261;for(const c of value)n=Math.imul(n^c.charCodeAt(0),16777619)>>>0;return n;}
export function prefilterQuestions(person:Participant,trialIndex:number,statement:string) {
 return PREFILTER_QUESTIONS[statement].map((q,index)=>{
  const seed=person.id+':'+trialIndex+':'+index;
  const options=q.options.map((label,i)=>({id:'choice-'+hash(seed+':'+i).toString(16),label})).sort((a,b)=>hash(seed+a.id)-hash(seed+b.id));
  return {id:'q'+index,prompt:q.prompt,options:[...options,{id:'unknown',label:'모르겠음'}]};
 });
}
async function view(db:D1Database,assignment:any,person:Participant) {
 const group=assignment.groups[Number(person.group_id)-1],trials=listeningTrials(group,JSON.parse(person.order_json));
 const count=await db.prepare('SELECT COUNT(*) AS n FROM prefilter_listening_responses WHERE participant_id=?').bind(person.id).first<{n:number}>();
 const index=count?.n||0;
 if(index===12)return {study_id:LISTENING_STUDY,group:person.group_id,total:12,current_index:12,completed:true};
 const trial=trials[index];
 const plays=await db.prepare('SELECT COUNT(*) AS n FROM prefilter_listening_plays WHERE participant_id=? AND trial_index=?').bind(person.id,index).first<{n:number}>();
 return {study_id:LISTENING_STUDY,group:person.group_id,total:12,current_index:index,completed:false,play_count:plays?.n||0,
  audio_url:'/'+(trial.mode==='baseline'?trial.input_path:trial.output_path),questions:prefilterQuestions(person,index,trial.statement)};
}
async function summary(db:D1Database) {
 const results=await db.batch([
  db.prepare(`WITH c AS (SELECT p.id,p.group_id,COUNT(r.id) AS n FROM prefilter_listening_participants p LEFT JOIN prefilter_listening_responses r ON r.participant_id=p.id WHERE p.study_id=? GROUP BY p.id,p.group_id)
   SELECT group_id,COUNT(*) AS participants,SUM(CASE WHEN n=12 THEN 1 ELSE 0 END) AS completed,SUM(n) AS responses FROM c GROUP BY group_id`).bind(LISTENING_STUDY),
  db.prepare(`SELECT p.group_id,r.mode,AVG(r.noise) AS noise,AVG(r.naturalness) AS naturalness,AVG(r.key_correct)/4.0 AS key_rate FROM prefilter_listening_responses r JOIN prefilter_listening_participants p ON p.id=r.participant_id
   WHERE p.study_id=? AND (SELECT COUNT(*) FROM prefilter_listening_responses done WHERE done.participant_id=p.id)=12 GROUP BY p.group_id,r.mode`).bind(LISTENING_STUDY),
 ]);
 const groups=Array.from({length:5},(_,i)=>{
  const id=String(i+1),counts=results[0].results.find((r:any)=>r.group_id===id) as any;
  const means=(mode:string)=>{const r=results[1].results.find((r:any)=>r.group_id===id&&r.mode===mode) as any;return r?{noise:r.noise,naturalness:r.naturalness,key_rate:r.key_rate}:null;};
  const baseline=means('baseline'),filtered=means('filtered');
  return {id,participants:counts?.participants||0,completed:counts?.completed||0,responses:counts?.responses||0,baseline,filtered,
   delta:baseline&&filtered?{noise:filtered.noise-baseline.noise,naturalness:filtered.naturalness-baseline.naturalness,key_rate:filtered.key_rate-baseline.key_rate}:null};
 });
 const ready=groups.filter(g=>g.completed>0);
 const overall=ready.length===5?Object.fromEntries(['baseline','filtered','delta'].map(mode=>[mode,Object.fromEntries(['noise','naturalness','key_rate'].map(k=>[k,groups.reduce((s,g)=>s+(g as any)[mode][k],0)/5]))])):null;
 return {study_id:LISTENING_STUDY,groups,overall,ready_groups:ready.length,participants:groups.reduce((s,g)=>s+g.participants,0),completed:groups.reduce((s,g)=>s+g.completed,0),responses:groups.reduce((s,g)=>s+g.responses,0)};
}
export async function prefilterListeningRequest(request:Request,db:D1Database,available:()=>Promise<AvailableAudio>):Promise<Response> {
 try {
  const assignment=await setup(db),url=new URL(request.url),path=url.pathname;
  if(path==='/api/prefilter-listening/summary'&&request.method==='GET')return json(await summary(db));
  const match=path.match(/^\/api\/prefilter-listening\/groups\/([1-5])\/(join|state|play|response)$/);
  if(!match)throw new SurveyError(404,'그룹 참여 링크를 확인하세요.');
  const [,group,action]=match;
  if(action==='join'&&request.method==='POST') {
   const body=await input(request),hash=await hashToken(token(body.token));
   const files=await available();for(const row of assignment.groups[Number(group)-1].conditions)for(const kind of ['input','output'])if(files.get(row[kind+'_path'])?.sha256!==row[kind+'_sha256'])throw new SurveyError(503,'배정된 음원이 변경되어 평가 시작을 보류했습니다.');
   const order=[0,1,2,3,4,5];for(let i=5;i>0;i--){const j=crypto.getRandomValues(new Uint32Array(1))[0]%(i+1);[order[i],order[j]]=[order[j],order[i]];}
   await db.prepare('INSERT OR IGNORE INTO prefilter_listening_participants (id,study_id,group_id,token_hash,order_json,joined_at) VALUES (?,?,?,?,?,?)').bind(crypto.randomUUID(),LISTENING_STUDY,group,hash,JSON.stringify(order),new Date().toISOString()).run();
   const joined=await participant(request,db,group,body.token);
   return json(await view(db,assignment,joined));
  }
  const person=await participant(request,db,group);
  if(action==='state'&&request.method==='GET')return json(await view(db,assignment,person));
  if(request.method!=='POST')throw new SurveyError(405,'지원하지 않는 요청입니다.');
  const body=await input(request),index=body.trial_index;
  if(!Number.isInteger(index)||index<0||index>11)throw new SurveyError(400,'음원 번호를 확인하세요.');
  const current=await view(db,assignment,person);
  if(action==='play') {
   if(index!==current.current_index||typeof body.event_id!=='string'||!/^[a-f0-9]{32}$/.test(body.event_id))throw new SurveyError(409,'현재 음원에서 다시 재생해 주세요.');
   const id=person.id+':'+index+':'+body.event_id;
   await db.prepare('INSERT OR IGNORE INTO prefilter_listening_plays (id,participant_id,trial_index,recorded_at) VALUES (?,?,?,?)').bind(id,person.id,index,new Date().toISOString()).run();
   return json(await view(db,assignment,person));
  }
  if(action!=='response')throw new SurveyError(405,'지원하지 않는 요청입니다.');
  const trial=listeningTrials(assignment.groups[Number(group)-1],JSON.parse(person.order_json))[index];
  const questions=prefilterQuestions(person,index,trial.statement);
  if(!body.answers||Object.keys(body.answers).length!==4||!['noise','naturalness'].every(k=>Number.isInteger(body[k])&&body[k]>=1&&body[k]<=5))throw new SurveyError(400,'핵심정보 4문항과 두 평가 항목에 모두 응답해 주세요.');
  let correct=0;const answers:Record<string,string>={};
  questions.forEach((q,i)=>{const selected=q.options.find(o=>o.id===body.answers[q.id]);if(!selected)throw new SurveyError(400,'각 문항의 보기 중 하나를 선택해 주세요.');answers[q.id]=selected.id;if(selected.label===PREFILTER_QUESTIONS[trial.statement][i].correct)correct++;});
  const payload=JSON.stringify({answers,noise:body.noise,naturalness:body.naturalness,questionnaire:PREFILTER_QUESTION_VERSION,scale:'likert-1-5-v1'});
  const existing=await db.prepare('SELECT payload,trial_index,recorded_at FROM prefilter_listening_responses WHERE participant_id=? AND trial_index=?').bind(person.id,index).first<ResponseRow>();
  if(existing){if(existing.payload!==payload)throw new SurveyError(409,'이미 저장된 응답입니다.');return json(await view(db,assignment,person));}
  if(current.current_index!==index||!('play_count' in current)||!current.play_count)throw new SurveyError(409,'현재 음원을 끝까지 재생한 뒤 응답해 주세요.');
  await db.prepare(`INSERT INTO prefilter_listening_responses (id,participant_id,trial_index,pair_index,mode,payload,choice_order,noise,naturalness,key_correct,recorded_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE (SELECT COUNT(*) FROM prefilter_listening_responses WHERE participant_id=?)=? ON CONFLICT(participant_id,trial_index) DO NOTHING`)
   .bind(crypto.randomUUID(),person.id,index,trial.pair,trial.mode,payload,JSON.stringify(questions),body.noise,body.naturalness,correct,new Date().toISOString(),person.id,index).run();
  const stored=await db.prepare('SELECT payload FROM prefilter_listening_responses WHERE participant_id=? AND trial_index=?').bind(person.id,index).first<{payload:string}>();
  if(stored?.payload!==payload)throw new SurveyError(409,'응답 상태가 바뀌었습니다. 새로고침 후 확인해 주세요.');
  return json(await view(db,assignment,person));
 }catch(error){if(error instanceof SurveyError)return json({error:error.message},error.status);console.error('Prefilter listening:',error instanceof Error?error.message:'Unknown error');return json({error:'청음평가 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'},503);}
}
