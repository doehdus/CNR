"""Overlay already completed group PSD vectors. No averaging, FFT or scaling."""
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import tempfile
import uuid

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[2]
NOISES = ('single', 'complex', 'changing')
SNRS = (0, 5, 10, 20)
COLORS = ('#0072B2', '#D55E00', '#009E73', '#8D5AA5')
STYLES = ('-', '--', '-.', ':')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def comparison_limits(data):
    curves = [group['signals']['mixture']['mean_db'] for group in data['groups']]
    return (math.floor(min(map(min, curves)) / 10) * 10,
            math.ceil(max(map(max, curves)) / 10) * 10)


def comparison_figure(data, noise, limits):
    """Pass each saved Mixture mean vector directly to Matplotlib unchanged."""
    figure, axis = plt.subplots(figsize=(12, 6), dpi=160, layout='constrained')
    for snr, color, style in zip(SNRS, COLORS, STYLES):
        group = next(group for group in data['groups'] if group['noise'] == noise and group['snr'] == snr)
        axis.plot(data['frequency_hz'], group['signals']['mixture']['mean_db'],
                  label=f'SNR {snr} dB', color=color, linestyle=style, linewidth=1.5)
    axis.set(xlim=(0, 8000), ylim=limits, xlabel='Frequency (Hz)',
             ylabel='Normalized PSD (dB/Hz; Clean interval RMS = 1)',
             title=f'{noise.capitalize()} - Mixture mean PSD by SNR',
             xticks=range(0, 8001, 1000))
    axis.grid(alpha=.22)
    axis.legend(loc='upper right', title='Input SNR', fontsize=11, title_fontsize=11)
    axis.tick_params(labelsize=11)
    axis.xaxis.label.set_size(12); axis.yaxis.label.set_size(12); axis.title.set_size(16)
    return figure, axis


def generate(root=ROOT):
    output = Path(root).resolve() / 'analysis/results/mixture_summary'
    source = output / 'results.json'
    source_hash = digest(source)
    data = json.loads(source.read_text(encoding='utf-8'))
    keys = {(group['noise'], group['snr']) for group in data['groups']}
    if len(data['groups']) != 12 or keys != {(noise, snr) for noise in NOISES for snr in SNRS}:
        raise ValueError('Expected all twelve completed noise/SNR groups.')
    if data['frequency_hz'] != [i * 16000 / 2048 for i in range(1025)]:
        raise ValueError('Unexpected completed frequency grid.')
    for group in data['groups']:
        curve = group['signals']['mixture']['mean_db']
        if len(curve) != 1025 or not all(isinstance(value, (int, float)) and math.isfinite(value) for value in curve):
            raise ValueError('A completed finite Mixture mean PSD is required.')
    limits = comparison_limits(data)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    stage = Path(tempfile.mkdtemp(prefix='snr-comparison-', dir=Path(root) / '.cache/noise_analysis'))
    graphs, artifacts = {}, {}
    try:
        (stage / 'graphs').mkdir()
        for noise in NOISES:
            figure, axis = comparison_figure(data, noise, limits)
            for line, snr in zip(axis.lines, SNRS):
                expected = next(g for g in data['groups'] if g['noise'] == noise and g['snr'] == snr)['signals']['mixture']['mean_db']
                if line.get_ydata().tolist() != expected:
                    raise ValueError('A displayed PSD curve differs from its completed group.')
            target = stage / 'graphs' / f'{noise}_snr_comparison.png'
            figure.savefig(target, dpi=160, facecolor='white'); plt.close(figure)
            relative = f'runs/{run_id}/graphs/{target.name}'
            graphs[noise] = relative; artifacts[relative] = digest(target)
        if digest(source) != source_hash:
            raise ValueError('Completed summary changed while plotting.')
        manifest = {'version': 1, 'render_id': run_id, 'source_summary_sha256': source_hash,
                    'source_run_id': data['engine']['run_id'], 'renderer_sha256': digest(Path(__file__)),
                    'unit': data['method']['unit'], 'snrs': list(SNRS), 'x_range_hz': [0, 8000],
                    'y_range_db': list(limits), 'curves': 'stored_mixture_mean_db_unchanged',
                    'graphs': graphs, 'artifacts': artifacts}
        contents = (json.dumps(manifest, ensure_ascii=False, allow_nan=False, separators=(',', ':')) + '\n').encode('utf-8')
        (stage / 'manifest.json').write_bytes(contents)
        destination = output / 'runs' / run_id
        stage.rename(destination)
        target = output / 'snr_comparison.json'
        if target.exists():
            archive = output / ('snr-comparison-' + digest(target)[:12] + '.json')
            if not archive.exists(): shutil.copyfile(target, archive)
        temporary = output / ('snr-comparison-' + uuid.uuid4().hex + '.tmp')
        temporary.write_bytes(contents); temporary.replace(target)
        print(f'Created 3 SNR comparison plots; X=0..8000Hz, Y={limits}; original group results unchanged.')
        return manifest
    finally:
        if stage.exists() and stage.resolve().parent == (Path(root) / '.cache/noise_analysis').resolve():
            shutil.rmtree(stage)


if __name__ == '__main__':
    generate()
