"""Run the C Butterworth designer; preserve configuration, evidence and response."""
import csv
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import uuid
from .design_peaking_eq import ROOT, digest, read_json, write_json, project_path

CONFIG = ROOT / 'experiment/config/prefilter_bpf.json'
CODE = Path(__file__).with_suffix('.c')


def validate_settings(data):
    expected = dict(version=1, status='selected', filter_type='butterworth_bandpass', scope='fixed_common',
                    sample_rate_hz=16000, prototype_order=2, digital_order=4,
                    lower_hz=75, upper_hz=4000, passband_peak_gain_db=0,
                    processing='causal_single_pass_df2_transposed_zero_state_per_wav', planned_count=144)
    if any(type(data.get(k)) is not type(v) or data[k] != v for k, v in expected.items()):
        raise ValueError('Expected the selected 75–4000Hz single-pass fourth-order BPF and 144 conditions.')
    if data.get('comparison_gain_db') != -1 or data.get('comparison_gain_scope') != 'both_unfiltered_and_bpf_listening_copies':
        raise ValueError('The common -1dB listening headroom must apply to both sides.')
    if not data.get('evaluation_relationship') or not data.get('selection_evidence'):
        raise ValueError('Selection provenance and evaluation relationship are required.')
    return data


def verify_evidence(settings):
    for item in settings['selection_evidence']:
        if digest(project_path(ROOT / item['path'])) != item['sha256']:
            raise ValueError('BPF selection evidence changed: ' + item['path'])


def calculate(executable, settings, response):
    result = subprocess.run([str(executable), str(settings['sample_rate_hz']), str(settings['lower_hz']),
                             str(settings['upper_hz']), str(response)], capture_output=True, text=True, check=True)
    import json
    data = json.loads(result.stdout)
    if data.get('verification') != 'passed': raise ValueError('C design verification failed.')
    return data


def generate():
    settings = validate_settings(read_json(CONFIG)); verify_evidence(settings)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    directory = ROOT / 'experiment/outputs/bpf_design/runs' / run_id
    directory.mkdir(parents=True, exist_ok=False)
    cache = ROOT / '.cache/noise_analysis'; cache.mkdir(parents=True, exist_ok=True)
    executable = cache / ('design-bpf-' + uuid.uuid4().hex[:12] + '.exe')
    watched = {p: digest(p) for p in [CONFIG, CODE, Path(__file__)]}
    subprocess.run([str(ROOT / '.tools/tcc/tcc.exe'), '-std=c99', '-Wall', '-Werror', str(CODE), '-o', str(executable)], check=True)
    raw = calculate(executable, settings, directory / 'response.csv')
    write_json(directory / 'design.json', raw)
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    with (directory / 'response.csv').open() as stream: rows = sorted(csv.DictReader(stream), key=lambda r: float(r['frequency_hz']))
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.4))
    for ax in axes:
        ax.plot([float(r['frequency_hz']) for r in rows], [float(r['gain_db']) for r in rows], color='#27634f', linewidth=1.8)
        ax.axvspan(settings['lower_hz'], settings['upper_hz'], color='#27634f', alpha=.07)
        ax.axhline(-3.01029995664, color='#887057', linestyle='--', linewidth=.8)
        ax.scatter([75,4000], [-3.01029995664]*2, color='#887057', zorder=5)
        ax.set(xlabel='Frequency (Hz)', ylabel='Gain (dB)', ylim=(-60, 2)); ax.grid(alpha=.18)
    axes[0].set(xlim=(10,8000), xscale='log', title='Single-pass digital Butterworth BPF')
    axes[1].set(xlim=(0,8000), title='75–4,000 Hz · digital order 4 (prototype N=2)')
    fig.tight_layout(); fig.savefig(directory / 'response.png', dpi=160); plt.close(fig)
    if any(digest(p) != sha for p,sha in watched.items()): raise ValueError('Design inputs changed.')
    verify_evidence(settings)
    record = dict(version=1, status='completed', run_id=run_id, settings=settings,
                  config_sha256=watched[CONFIG], engine=dict(source_sha256=watched[CODE], runner_sha256=watched[Path(__file__)], executable_sha256=digest(executable)),
                  artifacts={name:digest(directory/name) for name in ['design.json','response.csv','response.png']})
    write_json(directory / 'manifest.json', record)
    return dict(run_id=run_id, manifest=str(directory / 'manifest.json'))


def selected_design():
    settings = validate_settings(read_json(CONFIG)); verify_evidence(settings)
    for path in sorted((ROOT / 'experiment/outputs/bpf_design/runs').glob('*/manifest.json'), reverse=True):
        record = read_json(path)
        if record['config_sha256'] != digest(CONFIG): continue
        if record['settings'] != settings or record['engine']['source_sha256'] != digest(CODE) or record['engine']['runner_sha256'] != digest(Path(__file__)):
            raise ValueError('BPF design code changed; verify the design again.')
        if any(digest(path.parent/name) != sha for name,sha in record['artifacts'].items()): raise ValueError('BPF design artifact changed.')
        return settings, path, record, read_json(path.parent/'design.json')
    raise ValueError('A verified BPF design matching the selected configuration is required.')


if __name__ == '__main__':
    import json
    print(json.dumps(generate(), ensure_ascii=False))
