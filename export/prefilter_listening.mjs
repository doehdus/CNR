import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeListeningAssignment} from '../website/shared/research/prefilter-listening-data.js';
export async function loadListeningAssignment(root,metrics) {
  let bytes;try{bytes=await readFile(path.join(root,'experiment/config/prefilter_listening.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  const data=normalizeListeningAssignment(JSON.parse(bytes));
  if(!metrics||data.source.sha256!==metrics.sha256)throw Error('Listening selection needs its exact completed metric run.');
  for(const group of data.groups)for(const r of group.conditions){
    const original=metrics.data.conditions.find(s=>s.statement===r.statement&&s.noise===r.noise&&s.snr===r.snr);
    if(!original||['input_path','output_path','input_sha256','output_sha256'].some(k=>r[k]!==original[k]))throw Error('Listening audio does not match completed metrics.');
    for(const m of ['stoi','estoi'])for(const mode of ['baseline','filtered','delta'])if(r[mode][m]!==original[mode][m])throw Error('Listening selection scores changed.');
  }
  return {data,sha256:createHash('sha256').update(bytes).digest('hex')};
}
export async function deliverListeningAssignment(selection,destination){
  if(!selection)return;
  const folder=path.join(destination,'prefilter_listening');await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'assignment.json'),JSON.stringify(selection.data)+'\n');
}
