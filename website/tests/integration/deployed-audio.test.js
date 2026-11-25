import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {prepareAudio} from '../../scripts/prepare-audio.mjs';
test('공개 스냅샷과 서버는 활성 원음·필터·SS 비교 WAV를 포함하고 과거 보관본은 제외한다',async()=>{
 const local=JSON.parse(await readFile(new URL('../../public/dataset/audio/catalog.json',import.meta.url),'utf8'));
 const published=await prepareAudio();
 const browser=JSON.parse(await readFile(new URL('../../.sites-runtime/public/dataset/audio/catalog.json',import.meta.url),'utf8'));
 const server=JSON.parse(await readFile(new URL('../../.sites-runtime/backend/audio-catalog.json',import.meta.url),'utf8'));
 let ss=null;
 try{ss=JSON.parse(await readFile(new URL('../../public/dataset/ss_fixed/results.json',import.meta.url),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 const ssPaths=new Set(ss?.conditions.flatMap(row=>Object.values(row.methods).map(method=>method.path))||[]);
 if(ss)assert.equal(ssPaths.size,864);
 const expected=315+ssPaths.size;
 assert(local.files.length>=expected&&local.files.length<=expected+144);assert.equal(published.files.length,expected);assert.deepEqual(browser,published);assert.deepEqual(server,published);
 const paths=(await readdir(new URL('../../.sites-runtime/public/dataset/audio/',import.meta.url),{recursive:true})).filter(p=>p.endsWith('.wav'));
 assert.equal(paths.length,expected);assert(!paths.some(p=>p.includes('comparison')));assert(!paths.some(p=>p.includes('prefilter_fixed')));
 const active=new Set(published.files.map(f=>f.path));const bpf=JSON.parse(await readFile(new URL('../../public/dataset/prefilter_bpf/results.json',import.meta.url),'utf8'));
 for(const path of ssPaths)assert(active.has(path));
 for(const r of bpf.conditions){assert(active.has(r.input_path));assert(active.has(r.output_path));assert(!active.has(r.comparison_input_path));}
});
