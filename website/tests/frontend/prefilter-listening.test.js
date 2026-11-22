import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPrefilterListening} from '../../.sites-runtime/public/website/js/prefilter-listening.js';
class Element{
 constructor(tag='div'){this.tagName=tag;this.children=[];this.listeners={};this.dataset={};this.attributes={};}
 append(...v){this.children.push(...v);}replaceChildren(...v){this.children=v;}setAttribute(k,v){this.attributes[k]=v;}
 addEventListener(k,f){(this.listeners[k]??=[]).push(f);}querySelector(){return new Element('svg');}
 async click(){for(const f of this.listeners.click||[])await f();}
}
const walk=e=>[e,...e.children.flatMap(walk)];
test('5개 참여 링크와 QR은 같은 그룹 주소이며 완료 평균·대기·그룹 선택이 정확하다',async t=>{
 const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
 let copied='',ready=false;
 for(const [name,value]of Object.entries({document:{querySelector:get,createElement:tag=>new Element(tag)},location:{href:'https://study.test/website/#prefilter-listening',hash:'#prefilter-listening'},navigator:{clipboard:{writeText:async text=>{copied=text;}}}})){
  const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});t.after(()=>old?Object.defineProperty(globalThis,name,old):delete globalThis[name]);
 }
 t.mock.method(globalThis,'setInterval',()=>0);
 t.mock.method(globalThis,'setTimeout',()=>0);
 t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({participants:ready?5:0,completed:ready?5:0,responses:ready?60:0,groups:Array.from({length:5},(_,i)=>({id:String(i+1),participants:ready?1:0,completed:ready?1:0,responses:ready?12:0,baseline:ready?{key_rate:.5,naturalness:3,noise:2}:null,filtered:ready?{key_rate:.75,naturalness:4,noise:3}:null,delta:ready?{key_rate:.25,naturalness:1,noise:1}:null})),overall:ready?{baseline:{key_rate:.5,naturalness:3,noise:2},filtered:{key_rate:.75,naturalness:4,noise:3},delta:{key_rate:.25,naturalness:1,noise:1}}:null})}));
 const app=createPrefilterListening();app.initialize();await app.load();const cards=get('#prefilter-listening-links').children;assert.equal(cards.length,5);
 for(let i=0;i<5;i++){const link=cards[i].children.find(e=>e.tagName==='a');assert.equal(link.href,'https://study.test/website/prefilter-survey.html?group='+(i+1));await cards[i].children.find(e=>e.tagName==='button').click();assert.equal(copied,link.href);assert(cards[i].children.some(e=>e.tagName==='details'));}
 assert(walk(get('#prefilter-listening-means')).some(e=>e.textContent==='—'));assert.match(get('#prefilter-listening-empty').textContent,/5개 그룹/);
 ready=true;await app.load();const texts=walk(get('#prefilter-listening-means')).map(e=>e.textContent);assert(texts.includes('50.00%'));assert(texts.includes('75.00%'));assert(texts.includes('+25.00%p'));assert(texts.includes('4.00점'));
 await get('#prefilter-listening-group').listeners.change[0]({target:{value:'2'}});assert.match(get('#prefilter-listening-empty').textContent,/완료한 참가자/);
});
test('새 메뉴 위치와 참여 화면은 확정된 문항·척도·개별 재생으로 연결된다',async()=>{
 const html=await readFile(new URL('../../src/collection/index.html',import.meta.url),'utf8');
 assert(html.indexOf('href="#prefilter-analysis"')<html.indexOf('href="#prefilter-listening"'));assert(html.indexOf('href="#prefilter-listening"')<html.indexOf('href="#demo"'));
 assert(html.indexOf('id="prefilter-analysis"')<html.indexOf('id="prefilter-listening"'));assert(html.indexOf('id="prefilter-listening"')<html.indexOf('id="demo"'));
 const survey=await readFile(new URL('../../src/listening-test/prefilter-survey.html',import.meta.url),'utf8');assert(survey.includes('<audio'));assert(survey.includes('총 12개'));assert(survey.includes('1~5점'));assert(!survey.includes('−1dB'));assert(!survey.includes('진행자가 재생'));
});
test('재생 기록 저장이 지연되어도 연속 다시 듣기 두 번을 모두 기록하고 제출을 잠근다',async t=>{
 const elements=new Map(),get=id=>{if(!elements.has(id)){const e=new Element();e.classList={toggle(){}};e.reset=()=>{};e.pause=()=>{};elements.set(id,e);}return elements.get(id);};
 const values=new Map();
 for(const [name,value]of Object.entries({document:{querySelector:get,createElement:tag=>new Element(tag)},location:{search:'?group=1'},window:{addEventListener(){}},localStorage:{getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)}})){
  const old=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,value});t.after(()=>old?Object.defineProperty(globalThis,name,old):delete globalThis[name]);
 }
 const base={group:'1',total:12,current_index:0,completed:false,play_count:0,audio_url:'/data/mixed/example.wav',questions:Array.from({length:4},(_,i)=>({id:'q'+i,prompt:'질문',options:[{id:'a',label:'보기'},{id:'unknown',label:'모르겠음'}]}))};
 let release,plays=0;const sent=[];
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.endsWith('/join'))return Response.json(base);
  if(url.endsWith('/play')){plays++;sent.push(JSON.parse(options.body));if(plays===1)await new Promise(resolve=>{release=resolve;});return Response.json({...base,play_count:plays});}
  throw Error('Unexpected request: '+url);
 });
 await import('../../.sites-runtime/public/website/js/prefilter-survey.js');
 await get('#prefilter-start').click();assert.equal(get('#prefilter-audio').src,base.audio_url);
 get('#prefilter-audio').listeners.ended[0]();get('#prefilter-audio').listeners.ended[0]();assert.equal(get('#prefilter-submit').disabled,true);
 release();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
 assert.equal(plays,2);assert.notEqual(sent[0].event_id,sent[1].event_id);assert.equal(get('#prefilter-submit').disabled,false);assert.match(get('#prefilter-play-status').textContent,/2회/);
});
