import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { prepareAudio } from '../../../website/scripts/prepare-audio.mjs';
import { normalizeMetrics, improvement } from '../../../website/shared/research/metrics.js';
import { metricMatchesInputs } from '../../../website/shared/research/study-tables.js';
import { catalogFiles } from '../../../website/tests/helpers/file-catalog.mjs';
import { loadProjectLayout, sourceAudioPath } from '../../../website/tests/helpers/research-layout.mjs';

test('실제 Python WAV 계산 결과가 홈페이지·파일 지문·개선량에 연결된다', async () => {
  const project = fileURLToPath(new URL('../../../', import.meta.url));
  const python = path.join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const base = await realpath(tmpdir()), root = await mkdtemp(path.join(base,'cnr-python-bridge-'));
  const code = `import json,sys
from pathlib import Path
import numpy as np
import soundfile as sf
from experiment.src.evaluation.calculate_metrics import calculate_dataset,write_results,resolve_audio_path
project,root=map(Path,sys.argv[1:3])
config=root/'experiment/config/paths.json'; config.parent.mkdir(parents=True)
config.write_text((project/'experiment/config/paths.json').read_text(encoding='utf-8'),encoding='utf-8')
manifest=json.loads((project/'experiment/data/metadata/dataset.json').read_text(encoding='utf-8'))
selected=[entry for entry in manifest['samples'] if entry['statement']=='instruction_01' and (entry['kind']=='clean' or (entry['noise']=='single' and entry['snr']==20 and entry['algorithm'] in ('noisy','ss_fixed')))]
rng=np.random.default_rng(27); clean=rng.normal(0,.1,24000)
for entry in selected:
    target=resolve_audio_path(entry['path'],root); target.parent.mkdir(parents=True,exist_ok=True)
    noise=0 if entry['kind']=='clean' else .05 if entry['kind']=='noisy' else .02
    sf.write(target,clean+rng.normal(0,noise,clean.size),16000,subtype='PCM_16')
manifest_path=root/'experiment/data/metadata/dataset.json'; manifest_path.parent.mkdir(parents=True,exist_ok=True)
manifest_path.write_text(json.dumps(manifest),encoding='utf-8')
ids=[entry['id'] for entry in selected if entry['kind']!='clean']
write_results(calculate_dataset(manifest_path,root=root,sample_ids=ids),root/'experiment/outputs')
sys.path.insert(0,str(project/'export'))
from export_results import export_results
export_results(root)
`;
  try {
    const run = spawnSync(python,['-c',code,project,root],{cwd:project,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(run.status,0,run.error?.message || run.stderr);
    const raw = JSON.parse(await readFile(path.join(root,'experiment/outputs/metrics.json'),'utf8'));
    const site = path.join(root, 'website');
    const websiteData = JSON.parse(await readFile(path.join(site, 'public/dataset/results.json'), 'utf8'));
    assert.deepEqual(websiteData, raw);
    const metrics = normalizeMetrics(websiteData); assert.equal(metrics.length,2);
    const paths = {};
    for (const row of metrics) { paths[row.reference_id]=row.reference_path; paths[row.sample_id]=row.compared_path; }
    const first = await catalogFiles(root);
    for (const row of metrics) assert.ok(metricMatchesInputs(row,paths,first.fingerprints));
    const baseline = metrics.find(row=>row.sample_id.endsWith('_noisy')), processed = metrics.find(row=>row.sample_id.endsWith('_ss_fixed'));
    assert.equal(improvement(processed,baseline,'stoi'),processed.stoi-baseline.stoi);
    const target = sourceAudioPath(root,processed.compared_path,await loadProjectLayout(root)), previous = await readFile(target);
    await writeFile(target,Buffer.concat([previous,Buffer.from([0])]));
    const changed = await catalogFiles(root);
    assert.equal(metricMatchesInputs(processed,paths,changed.fingerprints),false);
    assert.ok(metricMatchesInputs(baseline,paths,changed.fingerprints));
    assert.equal((await prepareAudio(site)).files.length,3);
  } finally {
    const checked = path.resolve(root);
    assert.equal(path.dirname(checked),base); assert.ok(path.basename(checked).startsWith('cnr-python-bridge-'));
    await rm(checked,{recursive:true,force:true});
  }
});
