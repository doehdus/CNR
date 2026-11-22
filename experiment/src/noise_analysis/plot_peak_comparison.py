"""Plot SNR overlays using completed peak counts, C trajectory aggregates and band ratios."""
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import uuid

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

from .plot_snr_comparison import ROOT, NOISES, SNRS, COLORS, STYLES, digest


def render_figures(summary, groups, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    values = [p for g in groups for p in g['peaks']]
    max_std = max(max(p['mean_std_hz'] or 0, p['noise_reference_std_hz'] or 0) for p in values)
    max_offset = max(max(abs(p['mean_offset_hz'] or 0), abs(p['noise_reference_offset_hz'] or 0)) for p in values)
    std_limits = (0, max(5, math.ceil(max_std / 5) * 5))
    offset_limit = max(5, math.ceil(max_offset / 5) * 5)
    ratio_limits = (min(0, math.floor(min(p['clean_to_noise_db'] for p in values) / 10) * 10), max(10, math.ceil(max(p['clean_to_noise_db'] for p in values) / 10) * 10))
    graphs = {}
    for noise in NOISES:
        periods = ('whole', 'before', 'after') if noise == 'changing' else ('whole',)
        titles = {'whole': 'Whole recording', 'before': 'Before 2.5 s', 'after': 'After 2.5 s'}
        for kind in ('peaks', 'tracking', 'clean'):
            rows_count = {'peaks': 1, 'tracking': 3, 'clean': 2}[kind]
            figure, axes = plt.subplots(rows_count, len(periods), figsize=(7 * len(periods) if len(periods) > 1 else 12, 3.4 * rows_count + 1), squeeze=False, layout='constrained')
            figure.suptitle(f'{noise.capitalize()} - ' + {'peaks': 'Peak Detection', 'tracking': 'Peak Tracking stability', 'clean': 'Clean speech overlap'}[kind], fontsize=17)
            for col, period in enumerate(periods):
                rows = [next(g for g in groups if (g['noise'], g['snr'], g['period']) == (noise, snr, period)) for snr in SNRS]
                x = list(range(len(rows[0]['peaks'])))
                labels = [f"{p['peak_id']}\n{p['frequency_hz']:.1f}" for p in rows[0]['peaks']]
                for r in range(rows_count):
                    axis = axes[r, col]
                    axis.set_xticks(x, labels); axis.grid(alpha=.2)
                    if r == rows_count - 1: axis.set_xlabel('Original Noise peak ID / frequency (Hz)')
                axes[0, col].set_title(titles[period])
                def line(axis, field, i, multiplier=1):
                    axis.plot(x, [p[field] * multiplier if p[field] is not None else None for p in rows[i]['peaks']],
                              color=COLORS[i], linestyle=STYLES[i], marker='o', markersize=4, label=f'SNR {SNRS[i]} dB')
                if kind == 'peaks':
                    for i in range(4): line(axes[0, col], 'mixture_count', i, 100 / 12)
                    axes[0, col].set(ylim=(0, 105), ylabel='Recordings with matching PSD peak (%)')
                elif kind == 'tracking':
                    for r, field, limits, label, reference in [
                        (0, 'mean_offset_hz', (-offset_limit, offset_limit), 'Mean frequency offset from Noise peak (Hz)', 'noise_reference_offset_hz'),
                        (1, 'mean_std_hz', std_limits, 'Mean per-recording frequency std (Hz)', 'noise_reference_std_hz'),
                        (2, 'mean_appearance_percent', (0, 105), 'Mean trajectory appearance (%)', 'noise_reference_appearance_percent')]:
                        for i in range(4): line(axes[r, col], field, i)
                        axes[r, col].plot(x, [p[reference] for p in rows[0]['peaks']], ':D', color='#333333', label='Original Noise reference', markersize=4)
                        axes[r, col].set(ylim=limits, ylabel=label)
                else:
                    counts = [[p['clean_count'] for p in row['peaks']] for row in rows]
                    if any(v != counts[0] for v in counts[1:]): raise ValueError('Clean references differ across SNRs.')
                    axes[0, col].plot(x, [v / 12 * 100 for v in counts[0]], '-o', color='#333333', label='Clean peaks (shared across SNRs)')
                    axes[0, col].set(ylim=(0, 105), ylabel='Clean recordings with matching PSD peak (%)')
                    axes[0, col].legend(fontsize=9)
                    for i in range(4): line(axes[1, col], 'clean_to_noise_db', i)
                    axes[1, col].axhline(0, color='#333333', linestyle=':', linewidth=1)
                    axes[1, col].set(ylim=ratio_limits, ylabel='Clean / actual noise band power (dB)')
                    axes[1, col].legend(ncol=2, fontsize=9)
                if kind != 'clean': axes[0, col].legend(ncol=2, fontsize=9)
            target = directory / f'{noise}_{kind}_comparison.png'
            figure.savefig(target, dpi=160, facecolor='white'); plt.close(figure)
            graphs[f'{noise}/{kind}'] = target
    return graphs, {'detection_percent': [0, 105], 'frequency_offset_hz': [-offset_limit, offset_limit],
                    'frequency_std_hz': list(std_limits), 'appearance_percent': [0, 105], 'clean_to_noise_db': list(ratio_limits)}


def generate(root=ROOT):
    root = Path(root).resolve()
    output = root / 'experiment/outputs/mixture_summary'
    summary_path = output / 'results.json'
    analysis_path = root / 'experiment/outputs/peak_analysis/results.json'
    source_hash, analysis_hash = digest(summary_path), digest(analysis_path)
    summary = json.loads(summary_path.read_text(encoding='utf-8'))
    analysis = json.loads(analysis_path.read_text(encoding='utf-8'))
    if summary['source_analysis']['sha256'] != analysis_hash or len(summary['groups']) != 12:
        raise ValueError('Completed summary and individual analysis must match.')
    code = root / 'experiment/src/noise_analysis/aggregate_peak_comparison.c'
    executable = root / '.cache/noise_analysis/aggregate_peak_comparison.exe'
    subprocess.run([str(root / '.tools/tcc/tcc.exe'), '-std=c99', '-Wall', '-Werror', str(code), '-o', str(executable)], check=True)
    period_executable = root / '.cache/noise_analysis/analyze_signals.exe'
    analyzer_code = root / 'experiment/src/noise_analysis/analyze_signals.c'
    period_code = analyzer_code.with_name('peak_periods.h')
    subprocess.run([str(root / '.tools/tcc/tcc.exe'), '-std=c99', '-Wall', '-Werror', str(analyzer_code), '-o', str(period_executable)], check=True)
    config = json.loads((root / 'experiment/config/frequency_analysis.json').read_text(encoding='utf-8'))
    if digest(root / 'experiment/config/frequency_analysis.json') != analysis['engine']['config_sha256']: raise ValueError('Analysis configuration changed.')
    def verify_inputs():
        for entry in summary['files']:
            if digest(root / entry['source']) != entry['sha256']: raise ValueError('Registered input changed.')
    verify_inputs()
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    stage = Path(tempfile.mkdtemp(prefix='peak-comparison-', dir=root / '.cache/noise_analysis'))
    detail_hashes, group_rows, member_rows, lines, period_hashes = {}, [], [], [], {}
    def detail(relative):
        path = analysis_path.parent / relative
        expected = analysis['artifacts'][relative]
        if digest(path) != expected: raise ValueError('Completed trajectory data changed.')
        detail_hashes[relative] = expected
        return json.loads(path.read_text(encoding='utf-8'))
    def period_records(source, group):
        manifest = stage / 'period-inputs.tsv'
        anchors = stage / 'period-anchors.csv'
        record_lines = [f'original\t1\t{root / "experiment/data/noise/changing.wav"}\t-\n']
        for member in group['members']:
            identity, gain = member['id'], member['normalization_gain']
            mixture = root / f'experiment/mixtures/changing/snr{group["snr"]:02d}/{identity}.wav'
            clean = root / f'experiment/data/reference/{identity}.wav'
            record_lines.extend([f'm_{identity}\t{gain:.17g}\t{mixture}\t-\n', f'c_{identity}\t{gain:.17g}\t{clean}\t-\n', f'n_{identity}\t{gain:.17g}\t{mixture}\t{clean}\n'])
        manifest.write_text(''.join(record_lines), encoding='ascii')
        anchors.write_text(''.join(f"{p['id'][1:]},{p['frequency_hz']},{p['bandwidth_hz']},{p['low_hz']},{p['high_hz']}\n" for p in source['peaks']), encoding='ascii')
        target = stage / 'raw' / f'changing_snr{group["snr"]:02d}_periods.json'
        target.parent.mkdir(exist_ok=True)
        command = [str(period_executable), '--peak-periods-manifest', str(manifest), '--anchors', str(anchors), '--output', str(target),
                   '--prominence-db', str(config['prominence_db']), '--distance-bins', str(config['minimum_distance_bins']),
                   '--match-min-bins', str(config['matching_minimum_bins']), '--match-width-fraction', str(config['matching_width_fraction'])]
        subprocess.run(command, check=True)
        relative = f'runs/{run_id}/raw/{target.name}'
        period_hashes[relative] = digest(target)
        records = json.loads(target.read_text(encoding='utf-8'))['records']
        return {row['id']: {p['period']: p for p in row['periods']} for row in records}, relative
    try:
        for noise in NOISES:
            source = next(s for s in analysis['sources'] if s['noise'] == noise)
            original = detail(source['details'])['signal']['tracking']
            original_tracks = {t['id']: t for t in original['tracks']}
            for snr in SNRS:
                group = next(g for g in summary['groups'] if g['noise'] == noise and g['snr'] == snr)
                rows = [c for c in analysis['conditions'] if c['noise'] == noise and c['snr'] == snr]
                if len(rows) != 12 or len({c['statement'] for c in rows}) != 12: raise ValueError('Incomplete condition group.')
                tracks, members = [], []
                for row in rows:
                    tracking = detail(row['details'])['signal']['tracking']
                    tracks.append({t['id']: t for t in tracking['tracks']})
                    members.append({'id': row['statement'], 'details': row['details'], 'track_ids': [o['mixture_track_id'] for o in row['observations']]})
                records, period_file = period_records(source, group) if noise == 'changing' else ({}, None)
                for period in (('whole', 'before', 'after') if noise == 'changing' else ('whole',)):
                    group_rows.append({'noise': noise, 'snr': snr, 'period': period})
                    if period == 'whole': member_rows.append(members)
                    else: member_rows.append([{'id': row['statement'], 'period_data': period_file,
                        'normalization_gain': next(m['normalization_gain'] for m in group['members'] if m['id'] == row['statement']),
                        'track_ids': [p['track_id'] for p in records['m_' + row['statement']][period]['peaks']]} for row in rows])
                    lines.append(f'{len(group_rows) - 1} {len(source["peaks"])}\n')
                    field = 'mean_db' if period == 'whole' else period + '_db'
                    for f, c, n in zip(summary['frequency_hz'], group['signals']['speech'][field], group['signals']['added_noise'][field]):
                        lines.append(f'{f:.17g} {c:.17g} {n:.17g}\n')
                    for p, peak in enumerate(source['peaks']):
                        reference = original_tracks.get(original['peak_track_ids'][p]) if period == 'whole' else records['original'][period]['peaks'][p]
                        reference_valid = reference is not None and (period == 'whole' or reference['track_id'] is not None)
                        reference_mean = reference['mean_hz'] if reference_valid else 0
                        reference_std = reference['std_hz'] if reference_valid else 0
                        reference_appearance = reference['appearance_percent'] if reference_valid else 0
                        counts = [group['signals'][k]['noise_comparison'][p]['matched_count'] for k in ('mixture', 'speech', 'added_noise')] if period == 'whole' else [-1, -1, -1]
                        lines.append(f"{p+1} {peak['frequency_hz']:.17g} {peak['low_hz']:.17g} {peak['high_hz']:.17g} {peak['bandwidth_hz']:.17g} {' '.join(map(str, counts))} {int(reference_valid)} {reference_mean:.17g} {reference_std:.17g} {reference_appearance:.17g}\n")
                        for row, mapping in zip(rows, tracks):
                            identity = row['statement']
                            track = mapping.get(row['observations'][p]['mixture_track_id']) if period == 'whole' else records['m_' + identity][period]['peaks'][p]
                            valid = track is not None and (period == 'whole' or track['track_id'] is not None)
                            flags = [-1, -1, -1] if period == 'whole' else [int(records[prefix + identity][period]['peaks'][p]['peak_detected']) for prefix in ('m_', 'c_', 'n_')]
                            mean, std, appearance = (track['mean_hz'], track['std_hz'], track['appearance_percent']) if valid else (0, 0, 0)
                            lines.append(f"{int(valid)} {mean:.17g} {std:.17g} {appearance:.17g} {' '.join(map(str, flags))}\n")
        numeric_input, numeric_output = stage / 'measurements.txt', stage / 'aggregate.json'
        numeric_input.write_text(''.join(lines), encoding='ascii')
        subprocess.run([str(executable), str(numeric_input), str(numeric_output)], check=True)
        calculated = json.loads(numeric_output.read_text(encoding='utf-8'))
        if len(calculated['groups']) != 20: raise ValueError('Expected 12 whole-record and 8 Changing segment aggregates.')
        groups = [dict(g, **identity, members=members) for g, identity, members in zip(calculated['groups'], group_rows, member_rows)]
        graph_files, axes = render_figures(summary, groups, stage / 'graphs')
        graphs, artifacts = {}, {}
        for key, path in graph_files.items():
            relative = f'runs/{run_id}/graphs/{path.name}'
            graphs[key] = relative; artifacts[relative] = digest(path)
        if digest(summary_path) != source_hash or digest(analysis_path) != analysis_hash:
            raise ValueError('Source results changed during aggregation.')
        for relative, expected in detail_hashes.items():
            if digest(analysis_path.parent / relative) != expected: raise ValueError('Trajectory inputs changed during aggregation.')
        verify_inputs()
        result = {'version': 1, 'render_id': run_id, 'source_summary_sha256': source_hash,
                  'source_analysis_sha256': analysis_hash, 'source_run_id': summary['engine']['run_id'],
                  'renderer_sha256': digest(Path(__file__)), 'aggregation_source_sha256': digest(code), 'aggregation_executable_sha256': digest(executable),
                  'period_analyzer_sha256': digest(analyzer_code), 'period_source_sha256': digest(period_code), 'period_executable_sha256': digest(period_executable),
                  'method': {'tracking': 'mean_of_per_recording_longest_matching_trajectory', 'std_missing': 'exclude_and_report_count', 'frequency_missing': 'exclude_and_report_count',
                             'appearance_missing': 'zero_among_12', 'clean_ratio': 'ratio_of_band_powers_from_stored_normalized_mean_psd',
                             'matching': 'original_analysis_rules', 'psd_averaging': 'none', 'changing_split_sec': 2.5,
                             'segment_frames': 'restart_at_exact_segment_start_full_windows_only_no_boundary_crossing'},
                  'snrs': list(SNRS), 'axes': axes, 'groups': groups, 'detail_hashes': detail_hashes, 'period_hashes': period_hashes, 'graphs': graphs, 'artifacts': artifacts}
        contents = (json.dumps(result, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')
        (stage / 'manifest.json').write_bytes(contents)
        stage.rename(output / 'runs' / run_id)
        target = output / 'peak_comparison.json'
        if target.exists():
            backup = output / ('peak-comparison-' + digest(target)[:12] + '.json')
            if not backup.exists(): shutil.copyfile(target, backup)
        temporary = output / ('peak-comparison-' + uuid.uuid4().hex + '.tmp')
        temporary.write_bytes(contents); temporary.replace(target)
        print(f'Created 9 peak / stability / Clean comparison figures; {run_id}', flush=True)
        return result
    finally:
        if stage.exists() and stage.resolve().parent == (root / '.cache/noise_analysis').resolve(): shutil.rmtree(stage)


if __name__ == '__main__':
    generate()
