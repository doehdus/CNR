import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeMetrics, improvement } from '../public/website/js/metrics.js';
import { metricMatchesInputs } from '../public/website/js/study-tables.js';
import { catalogFiles } from './helpers/file-catalog.mjs';

test('실제 Python WAV 계산 결과가 홈페이지·파일 지문·개선량에 연결된다', async () => {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const python = path.join(project, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const base = await realpath(tmpdir()), root = await mkdtemp(path.join(base,'cnr-python-bridge-'));
  const code = `import json,sys
from pathlib import Path
import numpy as np
import soundfile as sf
from metrics.calculate_metrics import calculate_dataset,write_results
project,root=map(Path,sys.argv[1:3])
manifest=json.loads((project/'data/metadata/dataset.json').read_text(encoding='utf-8'))
selected=[entry for entry in manifest['samples'] if entry['statement']=='instruction_01' and (entry['kind']=='clean' or (entry['noise']=='single' and entry['snr']==20 and entry['algorithm'] in ('noisy','ss_fixed')))]
rng=np.random.default_rng(27); clean=rng.normal(0,.1,24000)
for entry in selected:
    target=root/entry['path']; target.parent.mkdir(parents=True,exist_ok=True)
    noise=0 if entry['kind']=='clean' else .05 if entry['kind']=='noisy' else .02
    sf.write(target,clean+rng.normal(0,noise,clean.size),16000,subtype='PCM_16')
manifest_path=root/'dataset.json'; manifest_path.write_text(json.dumps(manifest),encoding='utf-8')
ids=[entry['id'] for entry in selected if entry['kind']!='clean']
write_results(calculate_dataset(manifest_path,root=root,sample_ids=ids),root/'metrics/results')
`;
  try {
    const run = spawnSync(python,['-c',code,project,root],{cwd:project,encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(run.status,0,run.error?.message || run.stderr);
    const raw = JSON.parse(await readFile(path.join(root,'metrics/results/stoi_estoi.json'),'utf8'));
    const metrics = normalizeMetrics(raw); assert.equal(metrics.length,2);
    const paths = {};
    for (const row of metrics) { paths[row.reference_id]=row.reference_path; paths[row.sample_id]=row.compared_path; }
    const first = await catalogFiles(root);
    for (const row of metrics) assert.ok(metricMatchesInputs(row,paths,first.fingerprints));
    const baseline = metrics.find(row=>row.sample_id.endsWith('_noisy')), processed = metrics.find(row=>row.sample_id.endsWith('_ss_fixed'));
    assert.equal(improvement(processed,baseline,'stoi'),processed.stoi-baseline.stoi);
    const target = path.join(root,processed.compared_path), previous = await readFile(target);
    await writeFile(target,Buffer.concat([previous,Buffer.from([0])]));
    const changed = await catalogFiles(root);
    assert.equal(metricMatchesInputs(processed,paths,changed.fingerprints),false);
    assert.ok(metricMatchesInputs(baseline,paths,changed.fingerprints));
  } finally {
    const checked = path.resolve(root);
    assert.equal(path.dirname(checked),base); assert.ok(path.basename(checked).startsWith('cnr-python-bridge-'));
    await rm(checked,{recursive:true,force:true});
  }
});
