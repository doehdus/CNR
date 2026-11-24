import { readLegacyFixture } from '../helpers/legacy-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizeListeningAssignment,listeningTrials,summarizeListening} from '../../shared/research/prefilter-listening-data.js';
const data=JSON.parse(readLegacyFixture('dataset/prefilter_listening/assignment.json'));
test('배정표는 모든 12문장을 포함한 30쌍이며 순서·Δ·음원 바꿔치기를 거부한다',()=>{
 normalizeListeningAssignment(data);const trials=listeningTrials(data.groups[0],[5,4,3,2,1,0]);assert.equal(trials.length,12);
 for(let i=0;i<12;i+=2){assert.equal(trials[i].mode,'baseline');assert.equal(trials[i+1].mode,'filtered');assert.equal(trials[i].statement,trials[i+1].statement);assert.equal(trials[i].noise,trials[i+1].noise);assert.equal(trials[i].snr,trials[i+1].snr);}
 for(const mutate of [d=>d.groups.pop(),d=>d.groups[0].conditions.pop(),d=>delete d.groups[0].conditions[0].delta.stoi,d=>d.groups[0].conditions[0].delta.estoi+=.01,d=>d.groups[0].conditions[0].input_path='data/clean/instruction01.wav']){const d=structuredClone(data);mutate(d);assert.throws(()=>normalizeListeningAssignment(d));}
 assert.throws(()=>listeningTrials(data.groups[0],[0,0,1,2,3,4]));
});
test('5개 그룹 동일 가중 평균이며 불완료 응답은 평균에 섞지 않는다',()=>{
 const people=[],responses=[];
 for(let g=1;g<=5;g++)for(let p=0;p<g;p++){const person={id:g+'-'+p,group_id:String(g)};people.push(person);for(let i=0;i<12;i++)responses.push({participant_id:person.id,group_id:person.group_id,mode:i%2?'filtered':'baseline',noise:i%2?4:2,naturalness:g,key_correct:4});}
 people.push({id:'partial',group_id:'1'});responses.push({participant_id:'partial',group_id:'1',mode:'baseline',noise:1,naturalness:1,key_correct:0});
 const s=summarizeListening(people,responses);assert.equal(s.completed,15);assert.equal(s.participants,16);assert.equal(s.overall.baseline.naturalness,3);assert.equal(s.overall.delta.noise,2);assert.equal(s.groups[0].baseline.key_rate,1);
});
