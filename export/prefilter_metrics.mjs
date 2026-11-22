// Verify completed paired scores; exports never run STOI or filter audio.
import { readFile,mkdir,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checked,sampleCount } from './prefilter.mjs';
import { normalizePrefilterMetrics,prefilterMetricBpfMatches } from '../website/shared/research/prefilter-metrics-data.js';
export async function loadPrefilterMetrics(root,bpf,bpfPointer) {
  let pointer;
  try { pointer=JSON.parse(await readFile(path.join(root,'experiment/outputs/prefilter_metrics.json'),'utf8')); }
  catch(error) { if(error.code==='ENOENT') return null; throw error; }
  const bytes=await checked(root,pointer.results,pointer.sha256),data=normalizePrefilterMetrics(JSON.parse(bytes));
  if(!prefilterMetricBpfMatches(data,bpf) || data.bpf_manifest_sha256!==bpfPointer.sha256 || data.bpf_manifest!==bpfPointer.manifest) throw Error('Completed metrics belong to different BPF audio.');
  await checked(root,'experiment/src/evaluation/calculate_metrics.py',data.engine.source_sha256);
  await checked(root,'experiment/src/evaluation/prefilter_metrics.py',data.engine.runner_sha256);
  await checked(root,'experiment/outputs/peak_analysis/results.json',data.reference_catalog_sha256);
  const refs=new Map();
  for(const r of data.conditions) {
    if(!refs.has(r.reference_path)) refs.set(r.reference_path,await checked(root,'experiment/data/reference/'+r.statement+'.wav',r.reference_sha256));
    const n=sampleCount(refs.get(r.reference_path));
    if(n!==r.baseline.alignment.reference_trim_start+r.baseline.alignment.samples+r.baseline.alignment.reference_trim_end ||
       n!==r.filtered.alignment.reference_trim_start+r.filtered.alignment.samples+r.filtered.alignment.reference_trim_end) throw Error('Clean reference length differs from scored source.');
  }
  const csv=await checked(root,path.posix.dirname(pointer.results)+'/comparison.csv',data.artifacts['comparison.csv']);
  return {data,csv,sha256:createHash('sha256').update(bytes).digest('hex')};
}
export async function deliverPrefilterMetrics(result,destination) {
  if(!result) return;
  const folder=path.join(destination,'prefilter_analysis'); await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'results.json'),JSON.stringify(result.data)+'\n');
  await writeFile(path.join(folder,'comparison.csv'),result.csv);
}
