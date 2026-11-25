// Deliver only completed, fingerprint-verified SS research. No signal processing runs here.
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {checked, sampleCount} from './prefilter.mjs';
import {normalizeSSFixed, SS_METHODS} from '../website/shared/research/ss-fixed-data.js';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export async function loadSSFixed(root) {
  let pointer;
  try { pointer=JSON.parse(await readFile(path.join(root,'experiment/outputs/ss_fixed.json'),'utf8')); }
  catch(e) { if(e.code==='ENOENT') return null; throw e; }
  const bytes=await checked(root,pointer.results,pointer.sha256), data=normalizeSSFixed(JSON.parse(bytes));
  const files=[], artifacts=[], base=path.posix.dirname(pointer.results), refs=new Set();
  await checked(root,base+'/generate_and_evaluate.py',data.engine_source_sha256);
  for (const row of data.conditions) {
    for (const [source,sha] of [[row.reference_source,row.reference_sha256],[row.mixture_source,row.mixture_sha256]]) {
      if(!refs.has(source)) { await checked(root,source,sha); refs.add(source); }
    }
    let samples;
    for (const method of SS_METHODS) {
      const item=row.methods[method], audio=await checked(root,item.source,item.sha256), count=sampleCount(audio);
      if(audio.length!==item.size || samples!==undefined && samples!==count) throw Error('SS comparison WAV size or duration differs.');
      samples=count;
      files.push({path:item.path,sha256:item.sha256,size:item.size,bytes:audio});
    }
  }
  for (const [name,sha] of Object.entries(data.artifacts)) {
    if(!/^[a-z0-9_]+\.csv$/.test(name)) throw Error('Invalid SS artifact path.');
    artifacts.push({name,bytes:await checked(root,base+'/'+name,sha)});
  }
  return {data,files,artifacts,sha256:hash(bytes)};
}
export async function deliverSSFixed(result,destination) {
  if(!result) return;
  const folder=path.join(destination,'ss_fixed');await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'results.json'),JSON.stringify(result.data)+'\n');
  for(const file of result.artifacts) await writeFile(path.join(folder,file.name),file.bytes);
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2), root=path.resolve(args[args.indexOf('--root')+1]), destination=path.resolve(args[args.indexOf('--destination')+1]);
  const result=await loadSSFixed(root);await deliverSSFixed(result,destination);
  if(result)for(const file of result.files){const target=path.join(destination,'audio',file.path);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,file.bytes);}
  console.log(JSON.stringify(result?result.files.map(({bytes,...file})=>file):[]));
}
