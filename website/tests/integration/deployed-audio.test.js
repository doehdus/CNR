import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {prepareAudio} from '../../scripts/prepare-audio.mjs';
test('로컬 보관본의 유무와 관계없이 공개 스냅샷과 서버에는 사용 중인 315 WAV만 포함한다',async()=>{
 const local=JSON.parse(await readFile(new URL('../../public/dataset/audio/catalog.json',import.meta.url),'utf8'));
 const published=await prepareAudio();
 const browser=JSON.parse(await readFile(new URL('../../.sites-runtime/public/dataset/audio/catalog.json',import.meta.url),'utf8'));
 const server=JSON.parse(await readFile(new URL('../../.sites-runtime/backend/audio-catalog.json',import.meta.url),'utf8'));
 assert(local.files.length>=315&&local.files.length<=459);assert.equal(published.files.length,315);assert.deepEqual(browser,published);assert.deepEqual(server,published);
 const paths=(await readdir(new URL('../../.sites-runtime/public/dataset/audio/',import.meta.url),{recursive:true})).filter(p=>p.endsWith('.wav'));
 assert.equal(paths.length,315);assert(!paths.some(p=>p.includes('comparison')));assert(!paths.some(p=>p.includes('prefilter_fixed')));
 const active=new Set(published.files.map(f=>f.path));const bpf=JSON.parse(await readFile(new URL('../../public/dataset/prefilter_bpf/results.json',import.meta.url),'utf8'));
 for(const r of bpf.conditions){assert(active.has(r.input_path));assert(active.has(r.output_path));assert(!active.has(r.comparison_input_path));}
});
