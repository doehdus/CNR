// Deliver completed C BPF audio and response; no DSP runs during export or build.
import { readFile, realpath, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { checked, sampleCount } from './prefilter.mjs';
import { normalizeBpfPrefilter } from '../website/shared/research/prefilter-bpf-data.js';
import { loadPrefilterMetrics,deliverPrefilterMetrics } from './prefilter_metrics.mjs';
import { loadListeningAssignment,deliverListeningAssignment } from './prefilter_listening.mjs';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function loadBpfPrefilter(root) {
  root = await realpath(root);
  let pointer;
  try { pointer = JSON.parse(await readFile(path.join(root,'experiment/outputs/bpf_results.json'))); }
  catch(error) { if(error.code === 'ENOENT') return null; throw error; }
  const bytes = await checked(root,pointer.manifest,pointer.sha256), data = normalizeBpfPrefilter(JSON.parse(bytes));
  const config = await checked(root,'experiment/config/prefilter_bpf.json',data.config_sha256);
  if (JSON.stringify(JSON.parse(config)) !== JSON.stringify(data.settings)) throw Error('BPF audio configuration changed.');
  const designBytes = await checked(root,data.design_manifest,data.design_manifest_sha256), design = JSON.parse(designBytes);
  if (design.config_sha256 !== data.config_sha256) throw Error('BPF design configuration mismatch.');
  const artifacts = [];
  for(const [name,sha] of Object.entries(design.artifacts)) {
    const bytes = await checked(root,path.posix.dirname(data.design_manifest)+'/'+name,sha);
    artifacts.push({name,sha256:sha,bytes});
  }
  const files = [];
  for(const r of data.conditions) for(const [logical,sha,physical] of [
    [r.input_path,r.input_sha256,'experiment/mixtures/'+r.input_path.slice('data/mixed/'.length)],
    [r.comparison_input_path,r.comparison_input_sha256,'experiment/outputs/enhanced/'+r.comparison_input_path.slice('outputs/'.length)],
    [r.output_path,r.output_sha256,'experiment/outputs/enhanced/'+r.output_path.slice('outputs/'.length)]
  ]) {
    let bytes;
    try { bytes = await checked(root,physical,sha); }
    catch (error) { if (logical === r.comparison_input_path && error.code === 'ENOENT') continue; throw error; }
    if(sampleCount(bytes) !== r.sample_count || logical === r.output_path && bytes.length !== r.size) throw Error('BPF paired audio length mismatch.');
    files.push({path:logical,sha256:sha,size:bytes.length,bytes});
  }
  const metrics=await loadPrefilterMetrics(root,data,pointer);
  const listening=await loadListeningAssignment(root,metrics);
  return {data,files,artifacts,metrics,listening,sha256:digest(bytes)};
}
export async function deliverBpfPrefilter(result,destination) {
  for(const file of result.files) {
    const target=path.join(destination,'audio',file.path); await mkdir(path.dirname(target),{recursive:true}); await writeFile(target,file.bytes);
  }
  const folder=path.join(destination,'prefilter_bpf'); await mkdir(folder,{recursive:true});
  for(const a of result.artifacts) await writeFile(path.join(folder,a.name),a.bytes);
  await writeFile(path.join(folder,'results.json'),JSON.stringify({...result.data,artifacts:Object.fromEntries(result.artifacts.map(a=>[a.name,a.sha256]))})+'\n');
  await deliverPrefilterMetrics(result.metrics,destination);
  await deliverListeningAssignment(result.listening,destination);
}
if(process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args=process.argv.slice(2),result=await loadBpfPrefilter(args[args.indexOf('--root')+1]);
  if(result) await deliverBpfPrefilter(result,args[args.indexOf('--destination')+1]);
  console.log(JSON.stringify({count:result?.data.actual_count||0,files:result?.files.map(({bytes:_bytes,...f})=>f)||[]}));
}
