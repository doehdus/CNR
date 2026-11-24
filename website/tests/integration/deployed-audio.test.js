import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {prepareAudio} from '../../scripts/prepare-audio.mjs';
test('새 실험 스냅샷은 입력 171개와 준비 상태만 전달하고 이전 처리·평가를 포함하지 않는다',async()=>{
 const local=JSON.parse(await readFile(new URL('../../public/dataset/audio/catalog.json',import.meta.url),'utf8'));
 const published=await prepareAudio();
 const browser=JSON.parse(await readFile(new URL('../../.sites-runtime/public/dataset/audio/catalog.json',import.meta.url),'utf8'));
 const server=JSON.parse(await readFile(new URL('../../.sites-runtime/backend/audio-catalog.json',import.meta.url),'utf8'));
 assert.equal(local.files.length,171);assert.deepEqual(local,published);assert.deepEqual(browser,published);assert.deepEqual(server,published);
 const paths=(await readdir(new URL('../../.sites-runtime/public/dataset/audio/',import.meta.url),{recursive:true})).filter(p=>p.endsWith('.wav'));
 assert.equal(paths.length,171);assert(!paths.some(p=>p.startsWith('outputs')));
 const manifest=JSON.parse(await readFile(new URL('../../public/dataset/manifest.json',import.meta.url),'utf8'));
 assert.deepEqual(manifest.research,{id:'cnr-20261123',status:'preparing'});
 assert.deepEqual(JSON.parse(await readFile(new URL('../../public/dataset/results.json',import.meta.url),'utf8')),[]);
 assert.equal(JSON.parse(await readFile(new URL('../../.sites-runtime/backend/prefilter-listening.json',import.meta.url),'utf8')),null);
 const children=await readdir(new URL('../../public/dataset/',import.meta.url));
 for(const retired of ['peak_analysis','mixture_summary','noise_analysis','prefilter','prefilter_bpf','prefilter_analysis','prefilter_listening'])assert(!children.includes(retired));
});
