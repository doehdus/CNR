import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPrefilterAnalysis } from '../../.sites-runtime/public/website/js/prefilter-analysis.js';
const data=JSON.parse(await readFile(new URL('../../public/dataset/prefilter_analysis/results.json',import.meta.url)));
const walk=e=>[e,...e.children.flatMap(walk)];
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.listeners={};this.attributes={};this.classList={toggle(){}};}
  append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(k,f){(this.listeners[k]??=[]).push(f);}click(){for(const f of this.listeners.click||[])f();}
}
test('STOI·ESTOI와 SNR 4단계가 12×3 표의 무처리·처리·Δ 및 36쌍 평균을 바꾼다',async t=>{
  const elements=new Map(),get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  let hashes=Object.fromEntries(data.conditions.flatMap(r=>['input','output','reference'].map(k=>[r[k+'_path'],r[k+'_sha256']])));
  for(const [name,value]of Object.entries({document:{querySelector:get,createElement:tag=>new Element(tag)},location:{href:'https://research.test/website/#prefilter-analysis'}})){
    const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});t.after(()=>old?Object.defineProperty(globalThis,name,old):delete globalThis[name]);
  }
  t.mock.method(globalThis,'fetch',async()=>({status:200,ok:true,json:async()=>structuredClone(data)}));
  const app=createPrefilterAnalysis({fingerprints:()=>hashes});app.initialize();await app.load();app.render();
  for(const metric of ['stoi','estoi'])for(const snr of [20,10,5,0]){
    get('#prefilter-metric-options').children.find(b=>b.dataset.metric===metric).click();
    get('#prefilter-analysis-snr-options').children.find(b=>b.dataset.snr===String(snr)).click();
    const table=get('#prefilter-analysis-matrix').children[0],body=table.children.find(e=>e.tagName==='tbody');assert.equal(body.children.length,12);
    const cells=walk(body).filter(e=>e.tagName==='td');assert.equal(cells.length,36);
    for(const cell of cells){
      const row=data.conditions.find(r=>r.noise===cell.dataset.noise&&r.statement===cell.dataset.statement&&r.snr===snr),pair=cell.children[0];
      assert.equal(pair.children[0].children[1].textContent,row.baseline[metric].toFixed(4));
      assert.equal(pair.children[1].children[1].textContent,row.filtered[metric].toFixed(4));
      const rounded=Number(row.delta[metric].toFixed(5));assert.equal(pair.children[2].textContent,'Δ '+(rounded>0?'+':'')+rounded.toFixed(5));
    }
    assert.equal(get('#prefilter-mean-baseline').textContent,data.summaries.find(s=>s.snr===snr)[metric].baseline.toFixed(4));
  }
  hashes={};app.render();assert.equal(get('#prefilter-analysis-content').hidden,true);assert.match(get('#prefilter-analysis-status').textContent,/표시를 보류/);
});
test('분석 메뉴와 화면은 사전필터링 바로 다음이며 재생표와 별도로 표시한다',async()=>{
  const html=await readFile(new URL('../../src/collection/index.html',import.meta.url),'utf8');
  assert(html.indexOf('href="#prefilter"')<html.indexOf('href="#prefilter-analysis"'));
  assert(html.indexOf('href="#prefilter-analysis"')<html.indexOf('href="#demo"'));
  assert(html.indexOf('id="prefilter"')<html.indexOf('id="prefilter-analysis"'));
  assert(html.indexOf('id="prefilter-analysis"')<html.indexOf('id="demo"'));
});
