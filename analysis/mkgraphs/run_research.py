"""Run the approved 24-figure analysis. C measures; Python verifies and serializes."""
import argparse
import csv
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

ROOT = Path(__file__).resolve().parents[2]
NOISES = ('single', 'complex', 'changing')
SNRS = (20, 10, 5, 0)
PROFILES = {'spectral': (2048, 1024), 'temporal': (512, 256)}
SETTINGS = {
    'version': 1, 'sample_rate_hz': 16000, 'window': 'hann_periodic', 'detrend': 'constant_per_frame',
    'profiles': {key: {'nperseg': n, 'hop': hop} for key, (n, hop) in PROFILES.items()},
    'primary_interval': 'registered_speech_start_end_including_internal_pauses',
    'frame_policy': 'global_zero_origin_grid_fully_inside_interval_no_padding',
    'normalization': 'same_reference_interval_rms_gain_for_all_components',
    'averaging': 'equal_recording_weight_linear_psd_before_db',
    'noise_information_source': 'mixture_only', 'initial_diagnostic': 'cumulative_complete_frames_before_common_registered_start',
    'candidate_selection': 'balanced_top_two_common_settings_pending_numeric_criteria',
    'planned_graphs': 24,
}


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def packed(value):
    return (json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def safe(root, relative, *, exists=True):
    root = Path(root).resolve()
    if not isinstance(relative, str) or not relative or any(c in relative for c in ':\\?#%\x00'):
        raise ValueError('A project-relative path is required.')
    if any(not part or part.startswith('.') for part in relative.split('/')):
        raise ValueError('Paths must remain inside the project.')
    for old, new in (('experiment/data/', 'data/'), ('experiment/mixtures/', 'data/mixtures/'), ('experiment/outputs/analysis/', 'analysis/results/signals/'), ('experiment/outputs/candidates/', 'analysis/results/candidates/'), ('experiment/outputs/graphs/', 'analysis/graphs/')):
        if relative.startswith(old):
            relative = new + relative[len(old):]
            break
    path = root / relative
    if path.resolve() != path.absolute() or not path.resolve().is_relative_to(root):
        raise ValueError('Symlinks and paths outside the project are unsupported.')
    if exists and not path.is_file():
        raise ValueError('Missing research input: ' + relative)
    return path


def prepare_inputs(root):
    workflow = read(safe(root, 'code/config/workflow.json'))
    if workflow.get('analysis_settings') != SETTINGS:
        raise ValueError('The workflow does not contain the approved analysis settings.')
    registry_path = safe(root, workflow['input_registry'])
    registry = read(registry_path)
    files = registry.get('files', [])
    if registry.get('version') != 1 or registry.get('expected_count') != 171 or len(files) != 171:
        raise ValueError('The registered 171 retained input files are required.')
    seen = set()
    for item in files:
        if item['path'] in seen:
            raise ValueError('Duplicate input identity.')
        seen.add(item['path'])
        expected = ('data/mixtures/' + item['path'][len('data/mixed/'):]) if item['path'].startswith('data/mixed/') else item['path']
        if item['source'] != expected:
            raise ValueError('Registered public/source paths differ.')
        path = safe(root, item['source'])
        if path.stat().st_size != item['size'] or digest(path) != item['sha256']:
            raise ValueError('Registered input changed: ' + item['source'])
    collection_path = safe(root, 'data/metadata/collection.json')
    recordings = read(collection_path)['recordings']
    ids = {row['id'] for row in recordings}
    if ids != {kind + f'{i:02d}' for kind in ('instruction', 'warning') for i in range(1, 7)} or len(recordings) != 12:
        raise ValueError('Expected twelve distinct registered statements.')
    metadata_path = safe(root, workflow['mixture_metadata'])
    with metadata_path.open(encoding='utf-8-sig', newline='') as stream:
        rows = list(csv.DictReader(stream))
    index, intervals = {}, {}
    for row in rows:
        relative = row['file']
        identity = Path(relative).stem
        key = (row['noise'], int(row['snr_target_db']), identity)
        if key in index or relative != f'mixtures/{key[0]}/snr{key[1]:02d}/{identity}.wav':
            raise ValueError('Duplicate or mismatched mixture metadata.')
        source = next((f for f in files if f['source'] == 'data/' + relative), None)
        if source is None or source['sha256'] != row['sha256']:
            raise ValueError('Mixture metadata fingerprint differs.')
        interval = tuple(round(float(row[field]) * 16000) for field in ('snr_interval_start_sec', 'snr_interval_end_sec'))
        if identity in intervals and intervals[identity] != interval:
            raise ValueError('A statement has inconsistent registered intervals.')
        intervals[identity] = interval
        index[key] = row
    if set(index) != {(noise, snr, identity) for noise in NOISES for snr in SNRS for identity in ids}:
        raise ValueError('All 144 distinct noise/SNR/statement conditions are required.')
    return workflow, files, recordings, index, intervals, [registry_path, collection_path, metadata_path]


def compile_profiles(root, cache, run_id):
    code = safe(root, 'analysis/mkgraphs/research_analysis.c')
    compiler = root / '.tools/tcc/tcc.exe'
    if compiler.resolve() != compiler.absolute():
        raise ValueError('Compiler must be a regular project-local file.')
    if not compiler.is_file():
        raise ValueError('The project-local TinyCC compiler is required.')
    watched = [code, *(root / 'analysis/mkgraphs' / name for name in ('analyze_signals.c', 'mixture_summary.h', 'peak_periods.h')), compiler]
    fingerprints = {p.relative_to(root).as_posix(): digest(p) for p in watched}
    executables, engines = {}, {}
    for profile, (n, hop) in PROFILES.items():
        executable = cache / f'research-{profile}-{run_id}.exe'
        flags = ['-std=c99', '-Wall', '-Werror', f'-DFFT_SIZE={n}', f'-DHOP={hop}']
        subprocess.run([str(compiler), *flags, str(code), '-o', str(executable)], check=True)
        executables[profile] = executable
        engines[profile] = {'nperseg': n, 'hop': hop, 'flags': flags, 'executable_sha256': digest(executable)}
    return executables, engines, fingerprints


def measure(executable, stage, relative, input_path, *, reference=None, interval=None, split=None, initial=None, spectrogram=False):
    temporary = stage / 'working.json'
    command = [str(executable), '--input', str(input_path), '--output', str(temporary), '--spectrogram', str(int(spectrogram))]
    if interval:
        command += ['--start', str(interval[0]), '--end', str(interval[1])]
    if reference:
        command += ['--reference', str(reference)]
    if split:
        command += ['--split', str(split)]
    if initial:
        command += ['--initial-limit', str(initial)]
    subprocess.run(command, check=True)
    content = temporary.read_bytes()
    result = json.loads(content)
    if result.get('tool_version') != 'cnr-research-analysis/1':
        raise ValueError('Unexpected C research measurement version.')
    target = stage / relative
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(gzip.compress(content, mtime=0))
    temporary.unlink()
    return result


def transport(stream, values):
    stream.write(' '.join(format(value, '.17g') for value in values) + '\n')


def aggregate(executable, stage, relative, members, profile):
    bins = PROFILES[profile][0] // 2 + 1
    source, target = stage / 'group.txt', stage / 'group.json'
    zeros = [0.] * bins
    with source.open('x', encoding='ascii', newline='\n') as stream:
        stream.write(f'CNR_RESEARCH_GROUP_1 {len(members)} {bins}\n')
        for speech, mixture in members:
            gain = speech['normalization_gain']
            if not isinstance(gain, (int, float)) or not math.isfinite(gain) or gain <= 0:
                raise ValueError('Registered Clean RMS must be positive.')
            stream.write(format(gain, '.17g') + '\n')
            for interval in ('primary', 'whole'):
                transport(stream, speech['signal'][interval]['psd'])
                transport(stream, mixture['added_noise'][interval]['psd'] if mixture else zeros)
                transport(stream, mixture['signal'][interval]['psd'] if mixture else speech['signal'][interval]['psd'])
            summary = mixture['frame_snr_summary'] if mixture else {'valid': 0, 'median_db': 0}
            prefixes = mixture['initial_estimates'] if mixture else []
            stream.write(f"{int(summary['valid'] > 0)} {summary['median_db'] or 0:.17g} {len(prefixes)}\n")
            for row in prefixes:
                stream.write(str(row['end_sample']) + ' ' + ' '.join(format(row[key] if row[key] is not None else float('nan'), '.17g') for key in ('power_bias_db', 'shape_tvd', 'speech_component_percent')) + '\n')
    subprocess.run([str(executable), '--group', str(source), '--output', str(target)], check=True)
    result = read(target)
    destination = stage / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(packed(result))
    source.unlink(); target.unlink()
    return result


def write_csv(path, fields, rows):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader(); writer.writerows(rows)


def generate(root=ROOT):
    root = Path(root).resolve()
    workflow, files, recordings, metadata, intervals, metadata_files = prepare_inputs(root)
    config_path = safe(root, 'code/config/workflow.json')
    from . import plot_research
    watched = [config_path, *metadata_files, Path(__file__), Path(plot_research.__file__)]
    watched_hashes = {p.relative_to(root).as_posix(): digest(p) for p in watched}
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    cache = root / '.cache/noise_analysis'; cache.mkdir(parents=True, exist_ok=True)
    executables, engines, source_hashes = compile_profiles(root, cache, run_id)
    stage = Path(tempfile.mkdtemp(prefix='research-stage-', dir=cache))
    output = safe(root, workflow['output_roots']['analysis'] + '/' + run_id, exists=False)
    if output.exists():
        raise ValueError('A research run cannot overwrite an existing directory.')
    clean, noise_data, mixtures, groups, speaker_groups = {}, {}, {}, {}, {}
    initial_limit = min(begin for begin, _ in intervals.values())
    try:
        for profile, executable in executables.items():
            for recording in recordings:
                identity = recording['id']
                clean[identity, profile] = measure(executable, stage, f'clean/{identity}/{profile}.json.gz',
                    root / f'data/reference/{identity}.wav', interval=intervals[identity], spectrogram=profile == 'temporal')
            for noise in NOISES:
                noise_data[noise, profile] = measure(executable, stage, f'noise/{noise}/{profile}.json.gz',
                    root / f'data/noise/{noise}.wav', split=40000 if noise == 'changing' else None, spectrogram=profile == 'temporal')
            for noise in NOISES:
                for snr in SNRS:
                    members = []
                    for recording in recordings:
                        identity = recording['id']
                        key = (noise, snr, identity)
                        measured = measure(executable, stage, f'mixture/{noise}/snr{snr:02d}/{identity}/{profile}.json.gz',
                            root / ('data/' + metadata[key]['file']), reference=root / f'data/reference/{identity}.wav',
                            interval=intervals[identity], initial=initial_limit if profile == 'temporal' else None)
                        if abs(measured['actual_snr_db'] - float(metadata[key]['snr_measured_db'])) > 1e-5:
                            raise ValueError('Stored actual SNR and paired C calculation differ.')
                        mixtures[*key, profile] = measured
                        members.append((clean[identity, profile], measured))
                    groups[noise, snr, profile] = aggregate(executable, stage, f'summary/{noise}_snr{snr:02d}_{profile}.json', members, profile)
                    print(f'{profile}: {noise}, {snr} dB / 12 statements completed', flush=True)
        speakers = list(dict.fromkeys(row['speaker'] for row in recordings))
        for index, speaker in enumerate(speakers, 1):
            members = [(clean[r['id'], 'spectral'], None) for r in recordings if r['speaker'] == speaker]
            speaker_groups[speaker] = aggregate(executables['spectral'], stage, f'summary/speaker{index}_spectral.json', members, 'spectral')
        condition_rows, estimation_rows, spectral_rows = [], [], []
        for noise in NOISES:
            for snr in SNRS:
                group = groups[noise, snr, 'spectral']
                for b in range(1025):
                    spectral_rows.append({'noise': noise, 'snr': snr, 'frequency_hz': b * 16000 / 2048,
                        **{kind + '_psd': group['signals'][kind]['primary']['psd'][b] for kind in ('speech', 'added_noise', 'mixture')},
                        'speech_noise_ratio_db': group['speech_noise_ratio_db'][b]})
                for recording in recordings:
                    identity = recording['id']; row = mixtures[noise, snr, identity, 'temporal']
                    condition_rows.append({'noise': noise, 'snr': snr, 'statement': identity, 'speaker': recording['speaker'],
                        'actual_snr_db': row['actual_snr_db'], 'reference_rms': row['reference_rms'],
                        'start_sample': row['start_sample'], 'end_sample': row['end_sample'],
                        'primary_short_frames': row['signal']['primary']['frame_count'],
                        **row['frame_snr_summary']})
                    for estimate in row['initial_estimates']:
                        estimation_rows.append({'noise': noise, 'snr': snr, 'statement': identity, **estimate})
        write_csv(stage / 'tables/conditions.csv', list(condition_rows[0]), condition_rows)
        write_csv(stage / 'tables/initial_estimates.csv', list(estimation_rows[0]), estimation_rows)
        write_csv(stage / 'tables/group_spectra.csv', list(spectral_rows[0]), spectral_rows)
        write_csv(stage / 'tables/inputs.csv', ['path', 'source', 'size', 'sha256'], [{key: item[key] for key in ('path', 'source', 'size', 'sha256')} for item in files])
        graphs = plot_research.render(root, stage, recordings, clean, noise_data, mixtures, groups, speaker_groups)
        if len(graphs) != 24 or len({g['id'] for g in graphs}) != 24:
            raise ValueError('The approved graph plan requires exactly 24 distinct figures.')
        for item in files:
            if digest(root / item['source']) != item['sha256']:
                raise ValueError('An input changed during research calculation.')
        for relative, expected in {**source_hashes, **watched_hashes}.items():
            if digest(root / relative) != expected:
                raise ValueError('Analysis code, configuration or metadata changed during calculation.')
        artifacts = {p.relative_to(stage).as_posix(): {'sha256': digest(p), 'size': p.stat().st_size} for p in sorted(stage.rglob('*')) if p.is_file()}
        for graph in graphs:
            graph.update(artifacts[graph['path']])
        planned = {'clean_recordings': 12, 'references': 12, 'noise_sources': 3, 'mixture_conditions': 144, 'noise_snr_groups': 12, 'graphs': 24, 'new_wavs': 0, 'stoi_estoi_values': 0}
        counts = {'clean_recordings': len(recordings), 'references': len([f for f in files if f['path'].startswith('data/reference/')]),
            'noise_sources': len(noise_data) // len(PROFILES), 'mixture_conditions': len(mixtures) // len(PROFILES),
            'noise_snr_groups': len(groups) // len(PROFILES), 'graphs': len(graphs),
            'new_wavs': len(list(stage.rglob('*.wav'))), 'stoi_estoi_values': 0}
        if counts != planned:
            raise ValueError('Actual analysis artifacts differ from the approved plan.')
        results = {'version': 1, 'study_id': workflow['id'], 'run_id': run_id, 'status': 'completed',
            'calculated_at': datetime.now(timezone.utc).isoformat(), 'method': SETTINGS,
            'initial_limit_sample': initial_limit, 'planned_counts': planned, 'actual_counts': counts,
            'recordings': recordings, 'inputs': files, 'graphs': graphs,
            'tables': {name: {'path': 'tables/' + name, **artifacts['tables/' + name]} for name in ('conditions.csv', 'initial_estimates.csv', 'group_spectra.csv', 'inputs.csv')},
            'notes': ['Added noise is mixture minus its paired reference, including quantization error.',
                'Initial estimates use mixture only; references validate errors and do not enter a processing algorithm.',
                'Power bias compares initial observed PSD with actual added-noise PSD in the registered interval.',
                'Shape error is total variation distance between unit-sum PSDs.',
                'Spectral power retention is not intelligibility. Candidate settings and ranking criteria remain unselected.',
                'All 144 conditions are analyzed. Selection/evaluation split remains pending; prior data use is preserved.']}
        (stage / 'results.json').write_bytes(packed(results))
        artifacts['results.json'] = {'sha256': digest(stage / 'results.json'), 'size': (stage / 'results.json').stat().st_size}
        manifest = {'version': 1, 'run_id': run_id, 'status': 'completed', 'engine': {'language': 'C', 'tool_version': 'cnr-research-analysis/1', 'profiles': engines, 'sources': source_hashes},
            'watched_inputs': watched_hashes, 'planned_counts': planned, 'actual_counts': counts, 'artifacts': artifacts}
        (stage / 'manifest.json').write_bytes(packed(manifest))
        output.parent.mkdir(parents=True, exist_ok=True)
        stage.rename(output)
        pointer = {'version': 1, 'run_id': run_id, 'manifest': (output / 'manifest.json').relative_to(root).as_posix(), 'sha256': digest(output / 'manifest.json')}
        latest = output.parent / 'latest.json'
        temporary = output.parent / ('latest-' + uuid.uuid4().hex + '.tmp')
        temporary.write_bytes(packed(pointer)); temporary.replace(latest)
        from .graph_output import write_graph_outputs
        write_graph_outputs(root)
        print(json.dumps({'run_id': run_id, **counts, 'directory': str(output)}, ensure_ascii=True), flush=True)
        return results
    finally:
        if stage.exists():
            if stage.resolve().parent != cache.resolve():
                raise ValueError('Unexpected research staging cleanup path.')
            shutil.rmtree(stage)


if __name__ == '__main__':
    argparse.ArgumentParser(description=__doc__).parse_args()
    generate()
