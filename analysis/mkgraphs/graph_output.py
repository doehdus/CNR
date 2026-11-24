"""Place completed PNGs in the project's existing outputs/graphs hierarchy."""
import json
import re
from pathlib import Path
import shutil
import tempfile
import uuid

from .run_research import ROOT, digest, packed, read, safe

FOLDERS = {
    ('clean', 'waveform'): '01_음성_파형_RMS_스펙트로그램',
    ('clean', 'spectrum'): '02_화자별_음성_PSD_누적전력',
    ('noise', 'source'): '03_소음_PSD_누적전력_스펙트로그램',
    ('noise', 'change'): '04_변화소음_전후_PSD_비교',
    ('mixture', 'mean_psd'): '05_합성음_SNR별_평균_PSD',
    ('mixture', 'overlap'): '06_음성대소음_주파수별_전력비',
    ('mixture', 'time_snr'): '07_합성음_단시간_SNR_중앙값_비교',
    ('estimation', 'initial_noise'): '08_초기_소음추정_오차',
}


def write_graph_outputs(root=ROOT):
    root = Path(root).resolve()
    pointer = read(safe(root, 'analysis/results/signals/latest.json'))
    if not re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{8}', pointer['run_id']) or pointer['manifest'] != f"analysis/results/signals/{pointer['run_id']}/manifest.json":
        raise ValueError('Invalid completed analysis pointer.')
    manifest_path = safe(root, pointer['manifest'])
    if digest(manifest_path) != pointer['sha256']:
        raise ValueError('Completed analysis manifest changed.')
    run = manifest_path.parent
    manifest = read(manifest_path)
    result_record = manifest['artifacts']['results.json']
    if digest(run / 'results.json') != result_record['sha256']:
        raise ValueError('Completed analysis results changed.')
    result = read(run / 'results.json')
    if result['run_id'] != pointer['run_id'] or len(result['graphs']) != 24:
        raise ValueError('The completed 24-graph analysis is required.')
    records, sources, seen = [], [], set()
    for graph in result['graphs']:
        identity = graph['id']
        if not identity or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_' for c in identity) or identity in seen:
            raise ValueError('Invalid or duplicate graph identity.')
        seen.add(identity)
        category = (graph['kind'], graph.get('role'))
        if graph['path'] != f'graphs/{identity}.png' or category not in FOLDERS:
            raise ValueError('Unexpected completed graph path or category.')
        source = safe(run, graph['path'])
        recorded = manifest['artifacts'][graph['path']]
        if source.stat().st_size != graph['size'] or digest(source) != graph['sha256'] or recorded['sha256'] != graph['sha256']:
            raise ValueError('Completed graph fingerprint differs.')
        relative = f"analysis/graphs/{FOLDERS[category]}/{pointer['run_id']}/{identity}.png"
        target = safe(root, relative, exists=False)
        if target.exists() and (target.stat().st_size != graph['size'] or digest(target) != graph['sha256']):
            raise ValueError('An existing graph would be overwritten: ' + relative)
        records.append({'id': identity, 'kind': graph['kind'], 'role': graph['role'], 'path': relative,
                        'sha256': graph['sha256'], 'size': graph['size']})
        sources.append(source)
    cache = root / '.cache/noise_analysis'; cache.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='graph-output-', dir=cache))
    try:
        for source, record in zip(sources, records):
            target = safe(root, record['path'], exists=False)
            if target.exists():
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            temporary = stage / target.name
            shutil.copy2(source, temporary)
            if digest(temporary) != record['sha256']:
                raise ValueError('Graph copy verification failed.')
            temporary.rename(target)
        index = {'version': 2, 'run_id': pointer['run_id'], 'source_manifest': pointer['manifest'],
                 'source_manifest_sha256': pointer['sha256'], 'writer_sha256': digest(Path(__file__)),
                 'graph_count': len(records), 'graphs': records}
        graph_root = safe(root, 'analysis/graphs', exists=False)
        graph_root.mkdir(parents=True, exist_ok=True)
        temporary = graph_root / ('latest-' + uuid.uuid4().hex + '.tmp')
        temporary.write_bytes(packed(index)); temporary.replace(graph_root / 'latest.json')
        return index
    finally:
        if stage.exists():
            if stage.resolve().parent != cache.resolve():
                raise ValueError('Graph staging cleanup escaped the cache.')
            shutil.rmtree(stage)


if __name__ == '__main__':
    print(json.dumps(write_graph_outputs(), ensure_ascii=True))
