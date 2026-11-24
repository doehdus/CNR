"""Run fixed-coefficient C Butterworth filters; save WAVs, one record, two sources.

SciPy is used only as an independent validation reference, never for output WAVs.
"""
import argparse
import csv
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import uuid
import wave

import numpy as np
import scipy
from scipy.signal import butter, sosfilt, sosfreqz


def project_root():
    for parent in Path(__file__).resolve().parents:
        if (parent / 'code/config/workflow.json').is_file():
            return parent
    raise ValueError('Run inside a research workspace with code/config/workflow.json.')


ROOT = project_root()
CANDIDATES = {'bpf01': (1, 75, 7900, 4), 'bpf02': (2, 109, 6000, 16)}
NOISES = ('single', 'complex', 'changing')
SNRS = (0, 5, 10, 20)
STATEMENTS = tuple(kind + f'{i:02d}' for kind in ('instruction', 'warning') for i in range(1, 7))
COMPILE_ARGUMENTS = ['-std=c99', '-Wall', '-Werror']
OUTPUT_GAIN_DB = -1.7  # User-approved common gain, applied inside both C filters.


def digest(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def safe(root, relative):
    if not isinstance(relative, str) or not relative or any(c in relative for c in ':\\?#%\x00'):
        raise ValueError('A project-relative path is required.')
    if any(not part or part.startswith('.') for part in relative.split('/')):
        raise ValueError('Invalid project-relative path.')
    root = Path(root).resolve()
    path = root / relative
    if path.resolve() != path.absolute() or not path.resolve().is_relative_to(root) or not path.is_file():
        raise ValueError('Missing or unsafe input: ' + relative)
    return path


def prepare(candidate_id, root=ROOT):
    if candidate_id not in CANDIDATES:
        raise ValueError('Unknown candidate.')
    number, low, high, order = CANDIDATES[candidate_id]
    workflow = read(safe(root, 'code/config/workflow.json'))
    selected = workflow['candidates']['butterworth']
    expected = dict(type='butterworth_bandpass', sample_rate_hz=16000,
                    lower_hz=low, upper_hz=high, prototype_order=order, digital_order=2*order,
                    processing='causal_single_pass_df2_transposed_zero_state_per_wav', output_gain_db=OUTPUT_GAIN_DB)
    parameters = selected['parameters'][candidate_id]
    if candidate_id not in selected['ids'] or any(parameters.get(k) != v for k, v in expected.items()):
        raise ValueError('Candidate parameters differ from the user-selected fixed C filter.')
    # These coefficients are for validation only; the executable owns its constants.
    reference_sos = butter(order, [low, high], btype='bandpass', fs=16000, output='sos')
    return workflow, {'id': candidate_id, **parameters, 'sos_sections': order}, reference_sos


def load_inputs(root, workflow):
    registry_path = safe(root, workflow['input_registry'])
    metadata_path = safe(root, workflow['mixture_metadata'])
    registry = read(registry_path)
    if registry.get('expected_count') != 171 or len(registry.get('files', [])) != 171:
        raise ValueError('The complete 171-file input registry is required.')
    registered, public_paths, watched = {}, set(), {}
    for row in registry['files']:
        public = row['path']
        expected = 'data/mixtures/' + public[len('data/mixed/'):] if public.startswith('data/mixed/') else public
        if row['source'] != expected or expected in registered or public in public_paths:
            raise ValueError('Duplicate or mismatched registered source.')
        source = safe(root, expected)
        fingerprint = digest(source)
        if source.stat().st_size != row['size'] or fingerprint != row['sha256']:
            raise ValueError('Registered input changed: ' + expected)
        registered[expected] = row
        public_paths.add(public)
        watched[source] = fingerprint
    with metadata_path.open(encoding='utf-8-sig', newline='') as stream:
        mixtures = list(csv.DictReader(stream))
    expected_conditions = {(noise, snr, identity) for noise in NOISES for snr in SNRS for identity in STATEMENTS}
    seen = set()
    for item in mixtures:
        relative = item['file'].replace('\\', '/')
        identity = Path(relative).stem
        key = (item['noise'], int(item['snr_target_db']), identity)
        source_name = 'data/' + relative
        if (key not in expected_conditions or key in seen or
                relative != f'mixtures/{key[0]}/snr{key[1]:02d}/{identity}.wav' or
                source_name not in registered or registered[source_name]['sha256'] != item['sha256']):
            raise ValueError('Duplicate, missing or mismatched mixture condition.')
        seen.add(key)
    if len(mixtures) != 144 or seen != expected_conditions:
        raise ValueError('Exactly 144 unique mixture conditions are required.')
    return mixtures, registered, watched, registry_path, metadata_path


def pcm16(path):
    with wave.open(str(path), 'rb') as stream:
        if (stream.getnchannels(), stream.getsampwidth(), stream.getframerate(), stream.getcomptype()) != (1, 2, 16000, 'NONE'):
            raise ValueError('Expected 16kHz mono PCM16 WAV: ' + str(path))
        count = stream.getnframes()
        content = stream.readframes(count)
    if not count or len(content) != count*2:
        raise ValueError('Empty or truncated PCM16 input.')
    return np.frombuffer(content, dtype='<i2')


def verify_output(source, output, reference_sos):
    original, actual = pcm16(source), pcm16(output)
    reference = sosfilt(reference_sos, original.astype(np.float64) / 32768.0) * 10**(OUTPUT_GAIN_DB/20)
    scaled = reference * 32768.0
    expected = np.copysign(np.floor(np.abs(scaled) + .5), scaled)
    if not np.isfinite(reference).all() or np.any(expected < -32768) or np.any(expected > 32767):
        raise ValueError('Independent reference overflows; no automatic attenuation is allowed.')
    if len(actual) != len(original):
        raise ValueError('Output sample count differs from input.')
    differences = actual.astype(np.int64) - expected.astype(np.int64)
    maximum = int(np.max(np.abs(differences)))
    changed = int(np.count_nonzero(differences))
    if maximum:
        raise ValueError(f'C differs from the independent SciPy reference: {maximum} LSB, {changed} samples.')
    return dict(sample_count=len(actual), max_abs_error_lsb=maximum, differing_samples=changed)


def check_headroom(executable, sources):
    """Measure the whole batch before creating any output WAVs."""
    checks = []
    for source in sources:
        item = json.loads(subprocess.run([str(executable), '--input', str(source), '--measure-only'],
                                         capture_output=True, text=True, check=True).stdout)
        if not math.isfinite(item['output_peak']) or item['sample_count'] <= 0:
            raise ValueError('Invalid headroom measurement.')
        checks.append(item)
    report = dict(checked_conditions=len(checks),
                  overflow_conditions=sum(item['would_overflow_samples'] > 0 for item in checks),
                  overflow_samples=sum(item['would_overflow_samples'] for item in checks),
                  max_output_peak=max(item['output_peak'] for item in checks))
    if report['overflow_samples']:
        raise ValueError(f"PCM16 overflow in {report['overflow_conditions']} conditions, "
                         f"{report['overflow_samples']} samples; maximum peak {report['max_output_peak']:.9f} FS. "
                         'No WAVs were saved and no automatic gain was applied.')
    return report


def generate(candidate_id='bpf01', root=ROOT):
    root = Path(root).resolve()
    workflow, candidate, reference_sos = prepare(candidate_id, root)
    number = CANDIDATES[candidate_id][0]
    # A preserved runner can replay its own sibling C snapshot in this workspace.
    runner = Path(__file__).resolve()
    source = runner.parent / f'butterworth{number}.c' if runner.parent.name == 'code' else root / f'code/pre/butterworth{number}/butterworth{number}.c'
    source = safe(root, source.relative_to(root).as_posix())
    compiler = root / '.tools/tcc/tcc.exe'
    if compiler.resolve() != compiler.absolute() or not compiler.is_file():
        raise ValueError('The regular project-local TCC compiler is required.')
    config = safe(root, 'code/config/workflow.json')
    mixtures, registered, watched, registry_path, metadata_path = load_inputs(root, workflow)
    watched.update({p: digest(p) for p in (source, runner, compiler, config, registry_path, metadata_path)})
    cache = root / '.cache/noise_analysis'
    cache.mkdir(parents=True, exist_ok=True)
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ') + '-' + uuid.uuid4().hex[:8]
    target = root / f'experiment/pre/butterworth{number}result' / run_id
    executable = cache / f'butterworth{number}-{run_id}.exe'
    stage = Path(tempfile.mkdtemp(prefix=f'butterworth{number}-', dir=cache))
    rows = []
    try:
        subprocess.run([str(compiler), *COMPILE_ARGUMENTS, str(source), '-o', str(executable)], check=True)
        headroom = check_headroom(executable, [safe(root, 'data/' + item['file'].replace('\\', '/')) for item in mixtures])
        for item in mixtures:
            relative = 'data/' + item['file'].replace('\\', '/')
            input_file = safe(root, relative)
            noise, snr, identity = item['noise'], int(item['snr_target_db']), input_file.stem
            output = stage / noise / f'snr{snr:02d}' / (identity + '.wav')
            output.parent.mkdir(parents=True, exist_ok=True)
            measured = json.loads(subprocess.run([str(executable), '--input', str(input_file), '--output', str(output)],
                                                capture_output=True, text=True, check=True).stdout)
            expected_metadata = dict(filter_id=candidate_id, lower_hz=candidate['lower_hz'], upper_hz=candidate['upper_hz'],
                                     prototype_order=candidate['prototype_order'], sos_sections=candidate['sos_sections'],
                                     output_gain_db=OUTPUT_GAIN_DB, sample_rate_hz=16000, clipped_samples=0)
            if any(measured.get(k) != v for k, v in expected_metadata.items()) or any(
                    not isinstance(measured.get(k), (int, float)) or not math.isfinite(measured[k]) for k in ('input_peak', 'output_peak')):
                raise ValueError('C filter identity or output measurements differ.')
            verification = verify_output(input_file, output, reference_sos)
            if measured['sample_count'] != verification['sample_count'] or digest(input_file) != registered[relative]['sha256']:
                raise ValueError('Input changed or C sample count differs.')
            rows.append(dict(noise=noise, snr_db=snr, statement=identity, source=relative,
                             source_sha256=registered[relative]['sha256'], output=output.relative_to(stage).as_posix(),
                             output_sha256=digest(output), size=output.stat().st_size,
                             input_peak=measured['input_peak'], output_peak=measured['output_peak'],
                             clipped_samples=0, **verification))
        if any(digest(p) != value for p, value in watched.items()):
            raise ValueError('Input, code or configuration changed during processing.')
        snapshots = stage / 'code'
        snapshots.mkdir()
        code_records = {}
        for original in (source, runner):
            destination = snapshots / original.name
            shutil.copy2(original, destination)
            if digest(destination) != watched[original]:
                raise ValueError('Code snapshot changed.')
            code_records[destination.relative_to(stage).as_posix()] = dict(size=destination.stat().st_size, sha256=watched[original])
        _, response = sosfreqz(reference_sos, worN=[candidate['lower_hz'], candidate['upper_hz']], fs=16000)
        cutoff_db = (20*np.log10(np.abs(response))).tolist()
        if any(abs(value + 10*math.log10(2)) > 1e-8 for value in cutoff_db):
            raise ValueError('Independent cutoff response differs from half power.')
        result = dict(version=1, status='completed', run_id=run_id, candidate=candidate,
                      planned_count=144, actual_count=len(rows), clipped_samples=0,
                      inputs=dict(registry=workflow['input_registry'], registry_sha256=watched[registry_path],
                                  mixture_metadata=workflow['mixture_metadata'], mixture_metadata_sha256=watched[metadata_path],
                                  workflow_sha256=watched[config], checked_count=171, unchanged_after_processing=True),
                      selection_context=dict(parameter_source='user-provided-parameter-table',
                                             selection_evaluation_split=workflow.get('selection_evaluation_split'),
                                             relationship='The registered 12 statements and 144 mixture conditions were also used in candidate-selection analysis; independent evaluation separation remains undecided.'),
                      environment=dict(python_version=sys.version, numpy_version=np.__version__, scipy_version=scipy.__version__,
                                       compiler_path='.tools/tcc/tcc.exe', compiler_sha256=watched[compiler],
                                       executable_sha256=digest(executable), compile_arguments=COMPILE_ARGUMENTS,
                                       run_command=f'.venv/Scripts/python.exe code/pre/run_research_bpf.py --candidate {candidate_id}',
                                       coefficient_source='fixed double-precision SOS constants in the preserved C source'),
                      validation=dict(method='independent scipy.signal.butter + sosfilt; PCM16 round halves away from zero',
                                      headroom=headroom,
                                      checked_conditions=len(rows), max_abs_error_lsb=max(row['max_abs_error_lsb'] for row in rows),
                                      differing_samples=sum(row['differing_samples'] for row in rows),
                                      reference_cutoff_gain_db_relative_to_passband=cutoff_db,
                                      reference_cutoff_gain_db_absolute=[value+OUTPUT_GAIN_DB for value in cutoff_db]),
                      code=code_records, conditions=rows)
        with (stage / 'result.json').open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(result, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write('\n')
        if len(list(stage.rglob('*.wav'))) != 144 or len([p for p in stage.rglob('*') if p.is_file()]) != 147:
            raise ValueError('Unexpected completed file count.')
        if target.exists():
            raise FileExistsError('Completed run already exists.')
        target.parent.mkdir(parents=True, exist_ok=True)
        stage.rename(target)
        return dict(status='completed', candidate=candidate_id, run_id=run_id, actual_count=len(rows),
                    max_abs_error_lsb=result['validation']['max_abs_error_lsb'],
                    result=(target / 'result.json').relative_to(root).as_posix())
    finally:
        if stage.exists():
            if stage.resolve().parent != cache.resolve():
                raise ValueError('Staging cleanup escaped the project cache.')
            shutil.rmtree(stage)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', choices=tuple(CANDIDATES), default='bpf01')
    args = parser.parse_args()
    try:
        print(json.dumps(generate(args.candidate), ensure_ascii=False))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr.strip() if isinstance(error, subprocess.CalledProcessError) and error.stderr else str(error)
        print(json.dumps(dict(status='error', message=detail), ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
