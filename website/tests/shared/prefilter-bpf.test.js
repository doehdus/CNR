import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeBpfPrefilter, bpfPrefilterInputsMatch } from '../../shared/research/prefilter-bpf-data.js';
const data=JSON.parse(await readFile(new URL('../../public/dataset/prefilter_bpf/results.json',import.meta.url)));
test('BPF 144조건의 원본·공통 레벨 기준음·처리음 지문이 모두 대응한다',()=>{
  normalizeBpfPrefilter(data);
  const hashes=Object.fromEntries(data.conditions.flatMap(r=>[[r.input_path,r.input_sha256],[r.comparison_input_path,r.comparison_input_sha256],[r.output_path,r.output_sha256]]));
  assert(bpfPrefilterInputsMatch(data,hashes));
  const active=Object.fromEntries(data.conditions.flatMap(r=>[[r.input_path,r.input_sha256],[r.output_path,r.output_sha256]]));
  assert(bpfPrefilterInputsMatch(data,active));
  for(const key of ['input_path','comparison_input_path','output_path']) assert.equal(bpfPrefilterInputsMatch(data,{...hashes,[data.conditions[0][key]]:'0'.repeat(64)}),false);
});
test('BPF 대응·차수·공통 이득·설계 근거 누락이나 변조를 거부한다',()=>{
  for(const mutate of [d=>d.conditions.pop(),d=>{d.conditions[1]=d.conditions[0];},d=>{d.conditions[0].comparison_input_path=d.conditions[0].input_path;},d=>{d.settings.digital_order=2;},d=>{d.settings.comparison_gain_db=0;},d=>{d.selection_cases=[];},d=>{d.selection_summary=[];}]) {
    const changed=structuredClone(data); mutate(changed); assert.throws(()=>normalizeBpfPrefilter(changed));
  }
});
