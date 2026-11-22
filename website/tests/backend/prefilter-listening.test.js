import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {researchRequest} from '../../backend/api/research.ts';
import {PREFILTER_QUESTIONS} from '../../backend/surveys/prefilter-questions.ts';
import {hashToken} from '../../backend/surveys/model.ts';
import {sqliteD1} from '../helpers/sqlite-d1.mjs';
const assignment=JSON.parse(readFileSync(new URL('../../public/dataset/prefilter_listening/assignment.json',import.meta.url)));
const catalog={version:1,files:assignment.groups.flatMap(g=>g.conditions.flatMap(r=>['input','output'].map(k=>({path:r[k+'_path'],sha256:r[k+'_sha256'],size:100}))))};
function fixture(){
 const store=sqliteD1(),env={DB:store.DB,ASSETS:{fetch:async()=>new Response('RIFFfixture')}};
 async function call(path,method='GET',body,token,files=catalog){
  const response=await researchRequest(new Request('https://study.test/api/prefilter-listening/'+path,{method,headers:token?{Authorization:'Bearer '+token}:{},...(body?{body:JSON.stringify(body)}:{})}),env,files);
  return {status:response.status,data:await response.json()};
 }
 async function join(group='1',token=crypto.randomUUID().replaceAll('-','')+crypto.randomUUID().replaceAll('-','')){
  const response=await call('groups/'+group+'/join','POST',{token});assert.equal(response.status,200,JSON.stringify(response.data));return {group,token,view:response.data};
 }
 async function payload(person,view=person.view){
  const p=store.sqlite.prepare('SELECT * FROM prefilter_listening_participants WHERE token_hash=?').get(await hashToken(person.token));
  const pair=JSON.parse(p.order_json)[Math.floor(view.current_index/2)],statement=assignment.groups[Number(person.group)-1].conditions[pair].statement;
  return {trial_index:view.current_index,answers:Object.fromEntries(view.questions.map((q,i)=>[q.id,q.options.find(o=>o.label===PREFILTER_QUESTIONS[statement][i].correct).id])),noise:4,naturalness:5};
 }
 async function answer(person){
  const base='groups/'+person.group,play=await call(base+'/play','POST',{trial_index:person.view.current_index,event_id:crypto.randomUUID().replaceAll('-','')},person.token);assert.equal(play.status,200,JSON.stringify(play.data));
  const body=await payload(person),result=await call(base+'/response','POST',body,person.token);assert.equal(result.status,200,JSON.stringify(result.data));person.view=result.data;return body;
 }
 return {...store,call,join,payload,answer};
}
test('5개 그룹의 12음원은 같은 조건의 무처리 다음 처리이며 새로고침에도 배정이 고정된다',async t=>{
 const f=fixture();t.after(f.close);
 for(let g=1;g<=5;g++){
  const person=await f.join(String(g)),paths=[];
  assert(!JSON.stringify(person.view).includes('"correct"'));
  for(let i=0;i<12;i++){assert.equal(person.view.current_index,i);paths.push(person.view.audio_url);const resumed=await f.call('groups/'+g+'/state','GET',undefined,person.token);assert.deepEqual(resumed.data,person.view);await f.answer(person);}
  assert(person.view.completed);
  const pairs=assignment.groups[g-1].conditions;
  for(let i=0;i<12;i+=2){const row=pairs.find(r=>'/'+r.input_path===paths[i]);assert(row);assert.equal(paths[i+1],'/'+row.output_path);}
 }
 const stats=await f.call('summary');assert.equal(stats.data.completed,5);assert.equal(stats.data.responses,60);assert.equal(stats.data.overall.baseline.key_rate,1);assert.equal(stats.data.overall.filtered.naturalness,5);assert.equal(stats.data.overall.delta.noise,0);
 assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM survey_responses').get().n,0);
});
test('미재생·잘못된 척도·다른 그룹·교차 출처는 거부하고 같은 제출 재시도는 중복을 만들지 않는다',async t=>{
 const f=fixture();t.after(f.close);const p=await f.join(),body=await f.payload(p);
 assert.equal((await f.call('groups/1/response','POST',body,p.token)).status,409);
 assert.equal((await f.call('groups/2/join','POST',{token:p.token})).status,409);
 assert.equal((await f.call('groups/1/response','POST',{...body,noise:7.5},p.token)).status,400);
 const saved=await f.answer(p);assert.equal((await f.call('groups/1/response','POST',saved,p.token)).status,200);
 assert.equal((await f.call('groups/1/response','POST',{...saved,noise:1},p.token)).status,409);
 const stats=await f.call('summary');assert.equal(stats.data.responses,1);assert.equal(stats.data.completed,0);assert.equal(stats.data.groups[0].baseline,null);assert.equal(stats.data.overall,null);
 const cross=await researchRequest(new Request('https://study.test/api/prefilter-listening/groups/1/join',{method:'POST',headers:{Origin:'https://other.test'},body:JSON.stringify({token:p.token})}),{DB:f.DB},catalog);assert.equal(cross.status,403);
 assert.equal((await f.call('groups/1/state')).status,401);
});
test('배정 파일 변경은 참여를 막고 진행 중인 응답은 완료 평균에서 제외한다',async t=>{
 const f=fixture();t.after(f.close);
 const bad=structuredClone(catalog);bad.files[0].sha256='0'.repeat(64);
 assert.equal((await f.call('groups/1/join','POST',{token:'b'.repeat(64)},undefined,bad)).status,503);
 const a=await f.join(),b=await f.join();for(let i=0;i<12;i++)await f.answer(a);await f.answer(b);
 const summary=(await f.call('summary')).data;assert.equal(summary.groups[0].participants,2);assert.equal(summary.groups[0].completed,1);assert.equal(summary.groups[0].responses,13);assert.equal(summary.groups[0].baseline.naturalness,5);assert.equal(summary.overall,null);
 assert(!JSON.stringify(summary).includes('token'));assert(!JSON.stringify(summary).includes('answers'));
});
