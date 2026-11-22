"""Compare BPF candidates against completed C Noise/Mixture/Clean PSDs.

C computes responses, weighted powers and summaries. Python verifies source
hashes, prepares transport, records provenance and plots saved C results.
No WAV filtering, final cutoff selection or objective speech scoring occurs.
"""
import csv
from datetime import datetime, timezone
import hashlib
import itertools
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

from . import design_peaking_eq as common

ROOT = common.ROOT
CONFIG = ROOT / 'experiment/config/bpf_candidates.json'
CODE = Path(__file__).with_suffix('.c')
KINDS = {'raw_noise': 0, 'group_mean': 1, 'individual_mixture': 2}


def candidate_grid(config):
    if (config.get('version') != 1 or config.get('status') != 'exploratory_not_selected' or
            config.get('sample_rate_hz') != 16000 or config.get('selected_candidate_id') is not None or
            config.get('comparison_mode') != 'causal_single_pass_magnitude_response'):
        raise ValueError('Only an unselected, single-pass exploratory BPF grid is supported.')
    rows = []
    for low, high, order in itertools.product(config['lower_cutoffs_hz'], config['upper_cutoffs_hz'], config['prototype_orders']):
        if (type(low) is not int or type(high) is not int or not 0 < low < high < 8000 or
                type(order) is not int or not 1 <= order <= 16):
            raise ValueError('Invalid BPF cutoff or prototype order.')
        rows.append({'id': f'bpf_l{low}_h{high}_n{order}', 'lower_hz': low, 'upper_hz': high, 'prototype_order': order})
    if not rows or len(rows) > 1024 or len({r['id'] for r in rows}) != len(rows):
        raise ValueError('Candidate grid must be nonempty and unique.')
    return rows


def collect_cases(config):
    inputs, decoded = [], {}
    for record in config['design_evidence']:
        path = common.project_path(ROOT / record['path'])
        content = path.read_bytes()
        if hashlib.sha256(content).hexdigest() != record['sha256']:
            raise ValueError('Completed design evidence changed: ' + record['path'])
        inputs.append(dict(record))
        decoded[record['path']] = json.loads(content)
    analysis = decoded['experiment/outputs/peak_analysis/results.json']
    summary = decoded['experiment/outputs/mixture_summary/results.json']
    comparison = decoded['experiment/outputs/mixture_summary/peak_comparison.json']
    hashes = {x['path']: x['sha256'] for x in inputs}
    if (summary['source_analysis']['sha256'] != hashes['experiment/outputs/peak_analysis/results.json'] or
            comparison['source_analysis_sha256'] != hashes['experiment/outputs/peak_analysis/results.json'] or
            comparison['source_summary_sha256'] != hashes['experiment/outputs/mixture_summary/results.json'] or
            analysis['frequency_hz'] != summary['frequency_hz'] or len(analysis['conditions']) != 144):
        raise ValueError('Noise, Mixture and Clean evidence must use the same completed analysis.')
    frequency = analysis['frequency_hz']
    cases = []

    def case(name, kind, noise, snr, statement, period, mix, speech, added):
        if any(len(values) != len(frequency) for values in [mix, added] + ([speech] if speech is not None else [])):
            raise ValueError('PSD dimensions do not match the stored frequency grid.')
        cases.append({'id': name, 'kind': kind, 'noise': noise, 'snr': snr, 'statement': statement,
                      'period': period, 'has_speech': speech is not None,
                      'arrays': [mix, speech if speech is not None else [-160] * len(frequency), added]})

    for source in analysis['sources']:
        noise = source['noise']
        case(f'noise_{noise}_whole', 'raw_noise', noise, None, None, 'whole', source['psd_db'], None, source['psd_db'])
        if noise == 'changing':
            for period in ['before', 'after']:
                values = source[f'{period}_psd_db']
                case(f'noise_{noise}_{period}', 'raw_noise', noise, None, None, period, values, None, values)
    for group in summary['groups']:
        for period in ['whole'] + (['before', 'after'] if group['noise'] == 'changing' else []):
            key = 'mean_db' if period == 'whole' else period + '_db'
            signals = group['signals']
            case(f"group_{group['noise']}_snr{group['snr']:02d}_{period}", 'group_mean', group['noise'], group['snr'], None,
                 period, signals['mixture'][key], signals['speech'][key], signals['added_noise'][key])
    seen = set()
    base = ROOT / 'experiment/outputs/peak_analysis'
    for row in analysis['conditions']:
        name = f"{row['noise']}_snr{row['snr']:02d}_{row['statement']}"
        if name in seen: raise ValueError('Duplicate mixture condition.')
        seen.add(name)
        path = common.project_path(base / row['details'])
        content = path.read_bytes()
        sha = hashlib.sha256(content).hexdigest()
        if sha != analysis['artifacts'][row['details']]:
            raise ValueError('Individual C PSD/track evidence changed.')
        details = json.loads(content)
        if details['engine']['run_id'] != analysis['engine']['run_id']:
            raise ValueError('Individual analysis comes from a different run.')
        inputs.append({'path': path.relative_to(ROOT).as_posix(), 'sha256': sha})
        case(name, 'individual_mixture', row['noise'], row['snr'], row['statement'], 'whole',
             details['signal']['psd_db'], details['speech']['psd_db'], details['added_noise']['psd_db'])
    return frequency, cases, inputs


def write_transport(path, frequency, candidates, cases):
    with path.open('x', encoding='ascii', newline='\n') as stream:
        stream.write(f'CNR_BPF_COMPARE_1 16000 {len(frequency)} {len(candidates)} {len(cases)}\n')
        stream.write(' '.join(format(v, '.17g') for v in frequency) + '\n')
        for row in candidates:
            stream.write(f"{row['id']} {row['lower_hz']} {row['upper_hz']} {row['prototype_order']}\n")
        for row in cases:
            stream.write(f"{row['id']} {KINDS[row['kind']]} {int(row['has_speech'])}\n")
            for values in row['arrays']:
                stream.write(' '.join(format(v, '.17g') for v in values) + '\n')


def render(result, folder):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    candidates = result['candidates']
    selected = [row for row in candidates if row['prototype_order'] == 2]
    lows = sorted({row['lower_hz'] for row in selected})
    highs = sorted({row['upper_hz'] for row in selected})
    lookup = {(r['lower_hz'], r['upper_hz']): r for r in selected}
    fig, axes = plt.subplots(1, 2, figsize=(14, 7))
    try:
        for axis, metric, stat, title, color in [
                (axes[0], 'noise_reduction_db', 'mean', 'Mean noise reduction (dB)', 'Blues'),
                (axes[1], 'clean_retained_percent', 'min', 'Lowest Clean power retained (%)', 'YlGn')]:
            values = [[lookup[(low, high)][metric][stat] for high in highs] for low in lows]
            image = axis.imshow(values, origin='lower', aspect='auto', cmap=color)
            axis.set_xticks(range(len(highs)), highs, rotation=45)
            axis.set_yticks(range(len(lows)), lows)
            axis.set_xlabel('Upper cutoff (Hz)'); axis.set_ylabel('Lower cutoff (Hz)')
            axis.set_title(title)
            for y, row in enumerate(values):
                for x, value in enumerate(row): axis.text(x, y, f'{value:.1f}', ha='center', va='center', fontsize=9)
            fig.colorbar(image, ax=axis)
        fig.suptitle('Exploratory Butterworth BP | prototype N=2, total order=4 | 144 matched conditions')
        fig.text(.5, .01, 'Steady-state PSD estimates; Clean power is not speech information or intelligibility. No final candidate selected.', ha='center', fontsize=9)
        fig.tight_layout(rect=(0, .035, 1, .95)); fig.savefig(folder / 'cutoff_comparison.png', dpi=150)
    finally: plt.close(fig)
    for dimension, fixed, fixed_value, filename in [('lower_hz', 'upper_hz', 4000, 'lower_cutoff_comparison.png'),
                                                   ('upper_hz', 'lower_hz', 100, 'upper_cutoff_comparison.png')]:
        fig, axes = plt.subplots(2, 1, figsize=(11, 7), sharex=True)
        try:
            for order in sorted({r['prototype_order'] for r in candidates}):
                rows = sorted((r for r in candidates if r[fixed] == fixed_value and r['prototype_order'] == order), key=lambda r: r[dimension])
                x = [r[dimension] for r in rows]
                axes[0].plot(x, [r['noise_reduction_db']['mean'] for r in rows], marker='o', label=f'N={order}; total order={2 * order}')
                axes[1].plot(x, [r['clean_retained_percent']['min'] for r in rows], marker='o')
            axes[0].set_ylabel('Mean noise reduction (dB)'); axes[1].set_ylabel('Lowest Clean power retained (%)')
            axes[1].set_xlabel(dimension.replace('_', ' ') + ' (Hz)')
            axes[0].legend(ncols=2)
            for axis in axes: axis.grid(alpha=.2)
            fig.suptitle(f'Exploratory comparison slice | {fixed}={fixed_value} Hz (not selected)')
            fig.text(.5, .01, 'PSD estimates across 144 conditions; no audio filtering or speech quality conclusion.', ha='center', fontsize=9)
            fig.tight_layout(rect=(0, .035, 1, .95)); fig.savefig(folder / filename, dpi=150)
        finally: plt.close(fig)
    return ['cutoff_comparison.png', 'lower_cutoff_comparison.png', 'upper_cutoff_comparison.png']


def generate():
    config_bytes = CONFIG.read_bytes()
    config = json.loads(config_bytes)
    candidates = candidate_grid(config)
    frequency, cases, inputs = collect_cases(config)
    cache = common.project_path(ROOT / '.cache/noise_analysis')
    cache.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='bpf-comparison-', dir=cache)).absolute()
    executable = cache / f'compare_bpf-{uuid.uuid4().hex[:12]}.exe'
    code_hash, runner_hash = common.digest(CODE), common.digest(Path(__file__))
    compiler = ROOT / '.tools/tcc/tcc.exe'
    compiler_hash = common.digest(compiler)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    output = common.project_path(ROOT / 'experiment/outputs/bpf_candidates/runs' / run_id)
    try:
        transport = stage / 'input.txt'
        write_transport(transport, frequency, candidates, cases)
        transport_hash = common.digest(transport)
        subprocess.run([str(compiler), '-std=c99', '-Wall', '-Werror', str(CODE), '-o', str(executable)], check=True)
        subprocess.run([str(executable), str(transport), str(stage / 'cases.csv'), str(stage / 'responses.csv'), str(stage / 'results.json')], check=True)
        result = common.read_json(stage / 'results.json')
        if (result['tool_version'] != 'cnr-bpf-comparison/1' or result['candidate_count'] != len(candidates) or
                result['case_count'] != len(cases) or any(r['individual_count'] != 144 for r in result['candidates'])):
            raise ValueError('Incomplete C candidate comparison.')
        graphs = render(result, stage)
        for item in inputs:
            if common.digest(ROOT / item['path']) != item['sha256']: raise ValueError('Design evidence changed during comparison.')
        if (hashlib.sha256(CONFIG.read_bytes()).hexdigest() != hashlib.sha256(config_bytes).hexdigest() or
                common.digest(CODE) != code_hash or common.digest(Path(__file__)) != runner_hash or common.digest(compiler) != compiler_hash):
            raise ValueError('Candidate configuration or code changed during comparison.')
        manifest = {'version': 1, 'status': 'candidate_comparison_only', 'run_id': run_id,
                    'calculated_at': datetime.now(timezone.utc).isoformat(), 'config': config,
                    'config_sha256': hashlib.sha256(config_bytes).hexdigest(),
                    'engine': {'language': 'C', 'source_sha256': code_hash, 'runner_sha256': runner_hash,
                               'compiler_sha256': compiler_hash, 'executable_sha256': common.digest(executable),
                               'transport_sha256': transport_hash}, 'inputs': inputs,
                    'cases': [{k: v for k, v in c.items() if k != 'arrays'} for c in cases],
                    'actual_counts': {'candidates': len(candidates), 'cases': len(cases), 'individual_mixtures': 144,
                                      'graphs': len(graphs), 'filtered_wavs': 0, 'intelligibility_scores': 0},
                    'limitations': ['PSD-weighted steady-state estimates do not include startup or boundary transients.',
                                    'Clean power retention is not phonetic information retention or measured intelligibility.',
                                    'Whole-interval SNR change differs from the registered active-interval input SNR label.',
                                    'Candidates were compared on design material, not an independent final evaluation set.'],
                    'artifacts': {name: common.digest(stage / name) for name in ['results.json', 'cases.csv', 'responses.csv', *graphs]}}
        common.write_json(stage / 'manifest.json', manifest)
        transport.unlink()  # Source C PSD files and their hashes preserve the numerical input.
        output.parent.mkdir(parents=True, exist_ok=True)
        if output.exists(): raise FileExistsError('Completed candidate runs are preserved.')
        stage.rename(output)
        return {'run_id': run_id, 'manifest': str(output / 'manifest.json'), 'actual_counts': manifest['actual_counts']}
    finally:
        if stage.exists():
            if stage.resolve() != stage or stage.parent != cache: raise ValueError('Unsafe cache cleanup path.')
            shutil.rmtree(stage)


if __name__ == '__main__': print(json.dumps(generate(), ensure_ascii=False))
