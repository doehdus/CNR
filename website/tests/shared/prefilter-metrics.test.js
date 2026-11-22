import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizePrefilterMetrics,prefilterMetricInputsMatch,prefilterMetricBpfMatches } from '../../shared/research/prefilter-metrics-data.js';
const data=JSON.parse(await readFile(new URL('../../public/dataset/prefilter_analysis/results.json',import.meta.url)));
const bpf=JSON.parse(await readFile(new URL('../../public/dataset/prefilter_bpf/results.json',import.meta.url)));
test('144쌍 실제 지표는 원본·처리·Clean과 현재 BPF 회차에 모두 대응한다',()=>{
  normalizePrefilterMetrics(data);assert(prefilterMetricBpfMatches(data,bpf));
  const hashes=Object.fromEntries(data.conditions.flatMap(r=>['input','output','reference'].map(k=>[r[k+'_path'],r[k+'_sha256']])));
  assert(prefilterMetricInputsMatch(data,hashes));
  for(const k of ['input','output','reference'])assert.equal(prefilterMetricInputsMatch(data,{...hashes,[data.conditions[0][k+'_path']]:'0'.repeat(64)}),false);
  assert.equal(prefilterMetricBpfMatches(data,{...bpf,run_id:'20000101T000000Z-00000000'}),false);
});
test('조건 바꿔치기·허위 Δ/평균·다른 구간·누락을 거부하고 감소값을 보존한다',()=>{
  assert(data.conditions.some(r=>r.delta.stoi<0));
  for(const mutate of [d=>d.conditions.pop(),d=>{d.conditions[1]=d.conditions[0];},d=>{d.conditions[0].delta.stoi+=.01;},d=>{d.summaries[0].stoi.baseline+=.01;},d=>{d.conditions[0].reference_stop++;},d=>{d.conditions[0].baseline.scored_target_start++;},d=>{d.settings.clean_reference='filtered';}]) {
    const changed=structuredClone(data);mutate(changed);assert.throws(()=>normalizePrefilterMetrics(changed));
  }
});
