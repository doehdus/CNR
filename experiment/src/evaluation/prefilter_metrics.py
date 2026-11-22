"""Paired STOI/ESTOI for the registered 144 raw and Butterworth WAV conditions.

Use the existing metric engine and preserve independent run artifacts. The same
unfiltered Clean interval is scored on both sides after the existing fixed-delay
alignment. No waveform, gain, VAD or filter configuration is changed here.
"""
import csv
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import shutil
import tempfile
import uuid
from . import calculate_metrics as engine


def digest(path):
    return engine.hashlib.sha256(Path(path).read_bytes()).hexdigest()


def inside(root, relative):
    path = (root / relative).absolute()
    if path.resolve() != path or not path.is_relative_to(root):
        raise ValueError('Metric artifacts must stay inside the project without symlinks.')
    return path


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write(path, data):
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(data, stream, ensure_ascii=False, allow_nan=False, indent=2)
        stream.write('\n')


def paired_scores(clean, baseline, filtered, *, max_delay_seconds=engine.DEFAULT_MAX_DELAY_SECONDS):
    preparations = []
    for signal in (baseline, filtered):
        _, _, preparation = engine.prepare_signals(clean, signal, 16000, 16000,
                                                    max_delay_seconds=max_delay_seconds)
        preparations.append(preparation)
    start = max(p['reference_trim_start'] for p in preparations)
    stop = min(p['reference_trim_start'] + p['samples'] for p in preparations)
    if stop <= start: raise ValueError('The paired Clean intervals do not overlap.')
    scores = []
    for signal, prep in zip((baseline, filtered), preparations):
        first = start + prep['alignment_delay_samples']
        target = signal[first:first + stop - start]
        scores.append(dict(**engine.calculate_signals(clean[start:stop], target, 16000),
                           alignment=prep, scored_target_start=first))
    return dict(reference_start=start, reference_stop=stop, samples=stop-start,
                baseline=scores[0], filtered=scores[1],
                delta={key:scores[1][key]-scores[0][key] for key in ('stoi','estoi')})


def summarize(rows):
    summaries = []
    for snr in (None, 20, 10, 5, 0):
        selected = rows if snr is None else [r for r in rows if r['snr'] == snr]
        item = dict(snr=snr, count=len(selected))
        for metric in ('stoi', 'estoi'):
            item[metric] = {key:math.fsum(r[key][metric] for r in selected)/len(selected)
                            for key in ('baseline','filtered','delta')}
        summaries.append(item)
    return summaries


def generate(root=engine.PROJECT_ROOT, *, sample_rate=16000, max_delay_seconds=engine.DEFAULT_MAX_DELAY_SECONDS):
    root = Path(root).resolve()
    if sample_rate != 16000: raise ValueError('Registered prefilter comparisons use 16kHz.')
    if not math.isfinite(max_delay_seconds) or max_delay_seconds < 0: raise ValueError('Invalid alignment search range.')
    pointer = inside(root,'experiment/outputs/bpf_results.json')
    selection = read(pointer)
    manifest_path = inside(root,selection['manifest'])
    if digest(manifest_path) != selection['sha256']: raise ValueError('BPF manifest fingerprint changed.')
    bpf = read(manifest_path)
    if bpf.get('status') != 'completed' or bpf.get('actual_count') != 144: raise ValueError('Completed 144-condition BPF results are required.')
    conditions = bpf['conditions']
    if len(conditions) != 144 or len({(r['noise'],r['snr'],r['statement']) for r in conditions}) != 144:
        raise ValueError('Duplicate or missing BPF conditions.')
    catalog_path = inside(root,'experiment/outputs/peak_analysis/results.json')
    catalog = read(catalog_path)
    registered = {r['path']:r['sha256'] for r in catalog['files']}
    config_path = inside(root,'experiment/config/prefilter_bpf.json')
    if digest(config_path) != bpf['config_sha256']: raise ValueError('BPF configuration changed.')
    watched = [pointer,manifest_path,catalog_path,config_path,Path(__file__),Path(engine.__file__)]
    fingerprints = {p:digest(p) for p in watched}
    reference_cache, rows, sources = {}, [], {}
    version = engine.tool_version()
    for condition in conditions:
        statement = condition['statement']; reference_path = 'data/reference/' + statement + '.wav'
        reference_file = inside(root,'experiment/data/reference/' + statement + '.wav')
        if statement not in reference_cache:
            reference_cache[statement] = engine._read_wav(reference_file)
        reference = reference_cache[statement]
        if registered.get(reference_path) != reference.sha256: raise ValueError('Registered Clean reference changed.')
        baseline_file = engine.resolve_audio_path(condition['input_path'],root)
        filtered_file = engine.resolve_audio_path(condition['output_path'],root)
        baseline, filtered = engine._read_wav(baseline_file), engine._read_wav(filtered_file)
        if (baseline.sha256 != condition['input_sha256'] or filtered.sha256 != condition['output_sha256'] or
                registered.get(condition['input_path']) != baseline.sha256):
            raise ValueError('Raw/BPF WAV fingerprints changed.')
        for audio in (reference,baseline,filtered):
            if audio.sample_rate != 16000 or audio.signal.size != condition['sample_count']:
                raise ValueError('Expected paired 16kHz WAVs with unchanged sample counts.')
        sources.update({reference_file:reference.sha256,baseline_file:baseline.sha256,filtered_file:filtered.sha256})
        scores = paired_scores(reference.signal,baseline.signal,filtered.signal,max_delay_seconds=max_delay_seconds)
        rows.append(dict(noise=condition['noise'],snr=condition['snr'],statement=statement,speaker=condition['speaker'],
                         reference_path=reference_path,reference_sha256=reference.sha256,
                         input_path=condition['input_path'],input_sha256=baseline.sha256,
                         output_path=condition['output_path'],output_sha256=filtered.sha256,**scores))
    if any(digest(p) != sha for p,sha in {**fingerprints,**sources}.items()):
        raise ValueError('Metric input, source code or evidence changed during calculation.')
    run_id = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ-') + uuid.uuid4().hex[:8]
    cache = inside(root,'.cache'); cache.mkdir(exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix='prefilter-metrics-',dir=cache)).absolute()
    output = inside(root,'experiment/outputs/prefilter_metrics/runs/' + run_id)
    try:
        fields = ['noise','snr','statement','speaker','reference_path','input_path','output_path','reference_start','reference_stop','samples',
                  'baseline_stoi','filtered_stoi','delta_stoi','baseline_estoi','filtered_estoi','delta_estoi',
                  'baseline_delay_samples','filtered_delay_samples','reference_sha256','input_sha256','output_sha256']
        with (stage/'comparison.csv').open('x',encoding='utf-8-sig',newline='') as stream:
            writer = csv.DictWriter(stream,fieldnames=fields); writer.writeheader()
            for row in rows:
                flat = {key:row[key] for key in fields if key in row}
                for metric in ('stoi','estoi'):
                    for mode in ('baseline','filtered','delta'): flat[mode+'_'+metric] = row[mode][metric]
                for mode in ('baseline','filtered'): flat[mode+'_delay_samples'] = row[mode]['alignment']['alignment_delay_samples']
                writer.writerow(flat)
        data = dict(version=1,status='completed',run_id=run_id,calculated_at=datetime.now(timezone.utc).isoformat(),
                    planned_count=144,actual_count=len(rows),scored_audio_count=2*len(rows),score_value_count=4*len(rows),
                    reference_count=len(reference_cache),tool_version=version,bpf_run_id=bpf['run_id'],
                    bpf_manifest=selection['manifest'],bpf_manifest_sha256=selection['sha256'],
                    reference_catalog_sha256=fingerprints[catalog_path],recordings=bpf['recordings'],
                    settings=dict(sample_rate_hz=16000,max_delay_seconds=max_delay_seconds,
                                  alignment='absolute_cross_correlation_then_common_clean_interval',
                                  clean_reference='unfiltered_registered_reference',baseline='original_mixture_no_extra_gain',
                                  filtered='stored_butterworth_wav_including_minus_1db_headroom',
                                  score_definition='raw_stoi_estoi_not_accuracy_or_percent'),
                    engine=dict(source_sha256=fingerprints[Path(engine.__file__)],runner_sha256=fingerprints[Path(__file__)]),
                    evaluation_relationship=bpf['evaluation_relationship'],conditions=rows,summaries=summarize(rows),
                    artifacts={'comparison.csv':digest(stage/'comparison.csv')})
        write(stage/'results.json',data)
        output.parent.mkdir(parents=True,exist_ok=True); stage.rename(output)
        target = inside(root,'experiment/outputs/prefilter_metrics.json')
        temporary = target.with_name('prefilter_metrics.'+uuid.uuid4().hex+'.tmp')
        try:
            write(temporary,dict(version=1,results=(output/'results.json').relative_to(root).as_posix(),sha256=digest(output/'results.json')))
            temporary.replace(target)
        finally: temporary.unlink(missing_ok=True)
        return dict(status='ok',run_id=run_id,paired_conditions=len(rows),scored_audio_count=2*len(rows),score_value_count=4*len(rows),results=str(output/'results.json'),summaries=data['summaries'])
    finally:
        if stage.exists():
            if stage.resolve()!=stage or stage.parent!=cache: raise ValueError('Unsafe metric stage path.')
            shutil.rmtree(stage)
