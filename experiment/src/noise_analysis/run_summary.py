"""Run C normalized 12-recording summaries; preserve all individual analysis."""
from datetime import datetime, timezone
import csv
import gzip
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from .run_analysis import ROOT, digest, payload, read_json
from .plot_summary import render_summary


def generate(root=ROOT):
    root = Path(root).resolve()
    base = root / 'experiment/outputs/peak_analysis'
    source_path = base / 'results.json'
    source_hash = digest(source_path)
    analysis = read_json(source_path)
    config_path = root / 'experiment/config/frequency_analysis.json'
    config = read_json(config_path)
    if (config['sample_rate_hz'], config['nperseg'], config['hop']) != (16000, 2048, 1024):
        raise ValueError('Expected the registered 16kHz / 2048 / 1024 analysis.')
    if digest(config_path) != analysis['engine']['config_sha256']:
        raise ValueError('Summary and reference analysis configuration must match.')
    executable = root / '.cache/noise_analysis/analyze_signals.exe'
    sources = [root / 'experiment/src/noise_analysis' / name for name in ('analyze_signals.c', 'mixture_summary.h')]
    if not executable.is_file() or any(p.stat().st_mtime_ns > executable.stat().st_mtime_ns for p in sources):
        raise ValueError('Compile the project C analyzer before generating summaries.')
    files = analysis['files']
    def verify_inputs():
        for file in files:
            path = root / file['source']
            if path.resolve() != path.absolute() or digest(path) != file['sha256'] or path.stat().st_size != file['size']:
                raise ValueError('Summary input changed: ' + file['source'])
    verify_inputs()
    conditions = analysis['conditions']
    ids = [recording['id'] for recording in analysis['recordings']]
    if len(ids) != 12 or len(set(ids)) != 12 or len(conditions) != 144 or len({(r['noise'], r['snr'], r['statement']) for r in conditions}) != 144:
        raise ValueError('Expected 144 unique conditions and 12 recordings.')
    metadata = list(csv.DictReader((root / 'experiment/outputs/mixture_preparation/tables/mixtures.csv').open(encoding='utf-8-sig')))
    if len(metadata) != 144 or len({row['file'] for row in metadata}) != 144:
        raise ValueError('Expected the registered 144 mixture intervals.')
    registered = {row['file']: row for row in metadata}
    metadata_path = root / 'experiment/outputs/mixture_preparation/tables/mixtures.csv'
    metadata_hash = digest(metadata_path)
    output = root / 'experiment/outputs/mixture_summary'
    output.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    engine = {'language': 'C', 'tool_version': 'cnr-mixture-summary/1', 'run_id': run_id,
              'source_sha256': digest(sources[0]), 'summary_source_sha256': digest(sources[1]),
              'config_sha256': digest(config_path), 'executable_sha256': digest(executable),
              'runner_sha256': digest(Path(__file__)), 'plotter_sha256': digest(Path(__file__).with_name('plot_summary.py')),
              'calculated_at': datetime.now(timezone.utc).isoformat()}
    stage = Path(tempfile.mkdtemp(prefix='summary-stage-', dir=root / '.cache/noise_analysis'))
    groups, artifacts = [], {}
    prefix = f'runs/{run_id}/'
    def artifact(path):
        relative = prefix + path.relative_to(stage).as_posix()
        artifacts[relative] = digest(path)
        return relative
    try:
        for source in analysis['sources']:
            for snr in (20, 10, 5, 0):
                noise = source['noise']
                group = [row for row in conditions if row['noise'] == noise and row['snr'] == snr]
                if len(group) != 12 or {r['statement'] for r in group} != set(ids):
                    raise ValueError('Incomplete summary group.')
                lines = []
                for identity in ids:
                    relative = f'mixtures/{noise}/snr{snr:02d}/{identity}.wav'
                    row = registered[relative]
                    if row['sha256'] != digest(root / 'experiment' / relative):
                        raise ValueError('Registered mixture changed.')
                    begin = round(float(row['snr_interval_start_sec']) * 16000)
                    end = round(float(row['snr_interval_end_sec']) * 16000)
                    condition = next(r for r in group if r['statement'] == identity)
                    if [begin, end] != [round(t * 16000) for t in condition['interval_sec']]:
                        raise ValueError('Registered and analyzed speech intervals differ.')
                    lines.append(f'{begin}\t{end}\t{identity}\t{root / "experiment" / relative}\t{root / "experiment/data/reference" / (identity + ".wav")}\n')
                manifest, anchors, target = stage / 'inputs.tsv', stage / 'anchors.csv', stage / 'working.json'
                manifest.write_text(''.join(lines), encoding='ascii')
                anchors.write_text(''.join(f"{p['id'][1:]},{p['frequency_hz']},{p['bandwidth_hz']},{p['low_hz']},{p['high_hz']}\n" for p in source['peaks']), encoding='ascii')
                command = [str(executable), '--summary-manifest', str(manifest), '--anchors', str(anchors), '--output', str(target),
                           '--prominence-db', str(config['prominence_db']), '--distance-bins', str(config['minimum_distance_bins']),
                           '--match-min-bins', str(config['matching_minimum_bins']), '--match-width-fraction', str(config['matching_width_fraction'])]
                if noise == 'changing': command += ['--split-sample', '40000']
                subprocess.run(command, check=True)
                raw = read_json(target)
                if len(raw['members']) != 12 or any(abs(row['actual_snr_db'] - snr) > .015 for row in raw['members']):
                    raise ValueError('Summary members or SNR do not match the registered group.')
                name = f'{noise}_snr{snr:02d}'
                raw_file = stage / 'raw' / (name + '.json.gz')
                raw_file.parent.mkdir(exist_ok=True)
                raw_file.write_bytes(gzip.compress(target.read_bytes(), mtime=0))
                graphs = {key: artifact(path) for key, path in render_summary(raw, stage / 'graphs', name).items()}
                # Full STFT matrices stay in the archived raw C output, outside delivery.
                compact = {**raw, 'signals': {key: {k: v for k, v in signal.items() if k != 'spectrogram_db'} for key, signal in raw['signals'].items()}}
                groups.append(dict(compact, noise=noise, snr=snr, graphs=graphs))
                target.unlink()
                print(f'Summary completed: {noise} {snr}dB ({len(groups)}/12)', flush=True)
        manifest.unlink(); anchors.unlink()
        verify_inputs()
        if digest(source_path) != source_hash or digest(metadata_path) != metadata_hash:
            raise ValueError('Source analysis or intervals changed while calculating.')
        if any(digest(path) != engine[key] for path, key in [(sources[0], 'source_sha256'), (sources[1], 'summary_source_sha256'), (executable, 'executable_sha256'), (config_path, 'config_sha256')]):
            raise ValueError('Summary code or settings changed while calculating.')
        result = {'version': 1, 'engine': engine, 'source_analysis': {'run_id': analysis['engine']['run_id'], 'sha256': source_hash},
                  'interval_metadata_sha256': metadata_hash, 'files': files, 'frequency_hz': analysis['frequency_hz'],
                  'method': {'normalization': 'clean_registered_interval_rms_1', 'internal_pauses': 'included',
                             'weighting': 'equal_per_recording_linear_power', 'temporal_origin': 'recording_start',
                             'missing_frames': 'exclude_and_count', 'unit': 'normalized dB/Hz', **config},
                  'groups': groups, 'artifacts': artifacts}
        (stage / 'manifest.json').write_bytes(payload({'engine': engine, 'source_analysis': result['source_analysis'], 'files': files, 'artifacts': artifacts}))
        destination = output / 'runs' / run_id
        destination.parent.mkdir(exist_ok=True)
        stage.rename(destination)
        target = output / 'results.json'
        if target.exists():
            archive = output / ('results-' + digest(target)[:12] + '.json')
            if not archive.exists(): shutil.copyfile(target, archive)
        temporary = output / ('results-' + uuid.uuid4().hex + '.tmp')
        temporary.write_bytes(payload(result)); temporary.replace(target)
        print(f'Published summary: 12 groups / 144 conditions; {run_id}', flush=True)
        return result
    finally:
        if stage.exists() and stage.resolve().parent == (root / '.cache/noise_analysis').resolve():
            shutil.rmtree(stage)


if __name__ == '__main__':
    generate()
