import { researchPath } from '../research_paths.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadBpfPrefilter } from '../bpf.mjs';
import { loadFixedPrefilter, deliverFixedPrefilter } from '../prefilter.mjs';
const root=fileURLToPath(new URL('../../before1123/',import.meta.url));
test('완료 BPF 전달은 원본·공통 감쇠 기준음·필터음 144쌍과 응답 지문을 검증한다',async()=>{
  const result=await loadBpfPrefilter(root);
  assert.equal(result.data.actual_count,144); assert(result.files.length>=288&&result.files.length<=432); assert.equal(result.artifacts.length,3);
  for(const row of result.data.conditions) {
    for(const key of ['input','comparison_input','output']) {
      const file=result.files.find(f=>f.path===row[key+'_path']); if(key==='comparison_input'&&!file)continue;
      assert.equal(file.sha256,row[key+'_sha256']); assert.equal(file.bytes.readUInt32LE(40)/2,row.sample_count);
    }
  }
});
test('이전 EQ는 완료 원음을 건드리지 않고 웹에 이력만 전달할 수 있다',async()=>{
  const result=await loadFixedPrefilter(root,{metadataOnly:true}),temp=await mkdtemp(fileURLToPath(new URL('../../.cache/',import.meta.url))+'eq-archive-test-');
  try {
    await deliverFixedPrefilter(result,temp,{metadataOnly:true});
    const delivered=JSON.parse(await readFile(temp+'/prefilter/results.json','utf8'));
    assert.equal(delivered.archived,true); assert.equal(delivered.actual_count,144);
    await assert.rejects(stat(temp+'/audio'),{code:'ENOENT'});
    assert.equal(result.data.archived,undefined);
  } finally {
    const expected=fileURLToPath(new URL('../../.cache/',import.meta.url))+'eq-archive-test-'; if(!temp.startsWith(expected)) throw Error('Unexpected cache cleanup path');
    await rm(temp,{recursive:true,force:true});
  }
});
