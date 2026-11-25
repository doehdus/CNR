import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {normalizeSSFixed,selectSSConditions} from '../../shared/research/ss-fixed-data.js';
const url=new URL('../../../experiment/outputs/ss_fixed/runs/20261125-alpha1-alpha5/results.json',import.meta.url);
const data=JSON.parse(await readFile(url,'utf8'));
test('SS catalog contains 288 matched triples and 576 completed SS outputs',()=>{
  assert.equal(normalizeSSFixed(data).conditions.length,288);
  const paths=data.conditions.flatMap(r=>Object.values(r.methods).map(m=>m.path));
  assert.equal(new Set(paths).size,864);
  for(const bpf of ['butterworth1','butterworth2'])for(const noise of ['single','complex','changing'])for(const snr of [0,5,10,20])assert.equal(selectSSConditions(data,{bpf,noise,snr}).length,12);
});
test('SS rejects incomplete grids, duplicate conditions and altered score summaries',()=>{
  const missing=structuredClone(data);missing.conditions.pop();assert.throws(()=>normalizeSSFixed(missing));
  const duplicate=structuredClone(data);duplicate.conditions[0]=duplicate.conditions[1];assert.throws(()=>normalizeSSFixed(duplicate));
  const score=structuredClone(data);score.conditions[0].methods.ss5.stoi+=.01;assert.throws(()=>normalizeSSFixed(score));
  const path=structuredClone(data);path.conditions[0].methods.ss1.path='../private.wav';assert.throws(()=>normalizeSSFixed(path));
});
test('SS menu, screen and hash route are linked without replacing existing evaluations',async()=>{
  const html=await readFile(new URL('../../src/collection/index.html',import.meta.url),'utf8');
  const source=await readFile(new URL('../../src/comparison/audio-comparison.js',import.meta.url),'utf8');
  assert.equal((html.match(/href="#ss-fixed"/g)||[]).length,1);assert.match(html,/id="ss-fixed"/);
  assert.match(source,/'ss-fixed': '고정형 SS 비교'/);assert.match(source,/page === 'ss-fixed'\) ssFixed.load/);
  assert.match(html,/id="prefilter-listening"/);assert.match(html,/id="listening-test"/);
});
