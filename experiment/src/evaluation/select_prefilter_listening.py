"""Select existing paired WAVs for five fixed listening groups; never render audio."""
import argparse
from collections import Counter
import csv
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy.optimize import Bounds, LinearConstraint, milp
from scipy.sparse import lil_matrix
from .calculate_metrics import resolve_audio_path

ROOT = Path(__file__).resolve().parents[3]
GROUP_STATEMENTS = [
    ['instruction01', 'instruction02', 'instruction04', 'warning02', 'warning04', 'warning05'],
    ['instruction02', 'instruction03', 'instruction05', 'warning03', 'warning05', 'warning06'],
    ['instruction03', 'instruction04', 'instruction06', 'warning01', 'warning02', 'warning06'],
    ['instruction01', 'instruction05', 'instruction06', 'warning01', 'warning03', 'warning04'],
    ['instruction01', 'instruction02', 'instruction06', 'warning03', 'warning04', 'warning05'],
]
SNRS = [0, 5, 10, 20]
NOISES = ['single', 'complex', 'changing']
SNR_COUNTS = [[2, 2, 1, 1], [1, 1, 2, 2], [2, 1, 2, 1], [1, 2, 1, 2], [2, 2, 1, 1]]


def read(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def direction(row):
    a, b = row['delta']['stoi'], row['delta']['estoi']
    return 'both_increase' if a > 0 and b > 0 else 'both_decrease' if a < 0 and b < 0 else 'mixed'


def verify(selection):
    source = ROOT / selection['source']['path']
    if digest(source) != selection['source']['sha256']:
        raise ValueError('The recorded completed metric source changed.')
    data = read(source)
    index = {(r['statement'], r['noise'], r['snr']): r for r in data['conditions']}
    selected = []
    if [g['id'] for g in selection['groups']] != ['1', '2', '3', '4', '5']:
        raise ValueError('Exactly five distinct fixed groups are required.')
    for g, group in enumerate(selection['groups']):
        rows = group['conditions']
        if len(rows) != 6 or [r['statement'] for r in rows] != GROUP_STATEMENTS[g]:
            raise ValueError('Each group must contain its six distinct registered sentences.')
        if Counter(r['noise'] for r in rows) != Counter(dict.fromkeys(NOISES, 2)):
            raise ValueError('Each noise type must occur twice per group.')
        if [sum(r['snr'] == snr for r in rows) for snr in SNRS] != SNR_COUNTS[g]:
            raise ValueError('Group SNR allocation changed.')
        if Counter(r['speaker'] for r in rows) != Counter({'유채원': 3, '김도연': 3}):
            raise ValueError('Both speakers must have three conditions per group.')
        for row in rows:
            original = index[(row['statement'], row['noise'], row['snr'])]
            for k in ['speaker', 'input_path', 'input_sha256', 'output_path', 'output_sha256', 'delta']:
                if row[k] != original[k]: raise ValueError('A selected condition or metric was replaced: ' + k)
            for mode in ['baseline', 'filtered']:
                if row[mode] != {m: original[mode][m] for m in ['stoi', 'estoi']}:
                    raise ValueError('A selected STOI/ESTOI score changed.')
            for kind in ['input', 'output']:
                if digest(resolve_audio_path(row[kind+'_path'])) != row[kind+'_sha256']:
                    raise ValueError('A registered selected WAV changed.')
            if direction(row) != row['direction']: raise ValueError('Direction changed.')
        selected.extend(rows)
    if len({(r['statement'], r['noise'], r['snr']) for r in selected}) != 30:
        raise ValueError('The 30 source conditions must be unique.')
    if sorted(Counter(r['statement'] for r in selected).values()) != [2]*6+[3]*6:
        raise ValueError('The 12 sentences must each occur two or three times.')
    if Counter(r['direction'] for r in selected) != Counter(selection['selection']['direction_counts']):
        raise ValueError('Direction proportions changed.')
    if [sum(r['change_magnitude_quartile'] == q for r in selected) for q in range(1, 5)] != [8,7,7,8]:
        raise ValueError('Change magnitude coverage changed.')
    for mode in ['baseline', 'filtered', 'delta']:
        for metric in ['stoi', 'estoi']:
            actual = float(np.mean([r[mode][metric] for r in selected]))
            if not np.isclose(actual, selection['selected_summary'][mode][metric], atol=1e-12, rtol=0):
                raise ValueError('Selected mean changed.')
    return {'groups': 5, 'paired_conditions': 30, 'verified_wavs': 60, 'covered_statements': 12}


def write_csv(selection, path):
    if not path.resolve().is_relative_to(ROOT/'experiment/outputs'):
        raise ValueError('Selection CSV must stay in experiment/outputs.')
    path.parent.mkdir(parents=True, exist_ok=True)
    fields = ['group', 'pair', 'statement', 'speaker', 'text', 'noise', 'snr',
              'baseline_stoi', 'filtered_stoi', 'delta_stoi', 'baseline_estoi', 'filtered_estoi', 'delta_estoi',
              'direction', 'change_magnitude_quartile', 'input_path', 'output_path', 'input_sha256', 'output_sha256']
    with path.open('x', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for group in selection['groups']:
            for pair, row in enumerate(group['conditions'], 1):
                item = {k: row[k] for k in fields if k in row}
                item.update(group=group['id'], pair=pair)
                for metric in ['stoi', 'estoi']:
                    for mode in ['baseline', 'filtered', 'delta']:
                        item[mode+'_'+metric] = row[mode][metric]
                writer.writerow(item)


def select():
    pointer = read(ROOT / 'experiment/outputs/prefilter_metrics.json')
    source = ROOT / pointer['results']
    if digest(source) != pointer['sha256']:
        raise ValueError('Metric source fingerprint changed.')
    data = read(source)
    rows = data['conditions']
    if len(rows) != 144 or len({(r['statement'], r['noise'], r['snr']) for r in rows}) != 144:
        raise ValueError('Expected all 144 unique paired scores.')
    by_key = {(r['statement'], r['noise'], r['snr']): i for i, r in enumerate(rows)}
    scale = {m: float(np.std([r['delta'][m] for r in rows])) for m in ['stoi', 'estoi']}
    magnitudes = [float(np.hypot(*(r['delta'][m] / scale[m] for m in ['stoi', 'estoi']))) for r in rows]
    ranked = sorted(range(144), key=lambda i: (magnitudes[i], rows[i]['statement'], rows[i]['noise'], rows[i]['snr']))
    quartile = {i: rank // 36 for rank, i in enumerate(ranked)}
    variables = [(g, by_key[(s, n, r)]) for g, statements in enumerate(GROUP_STATEMENTS)
                 for s in statements for n in NOISES for r in SNRS]
    nv = len(variables)
    constraints, lower, upper = [], [], []

    def add(predicate, lo, hi):
        constraints.append({j: 1.0 for j, (g, i) in enumerate(variables) if predicate(g, rows[i], i)})
        lower.append(lo); upper.append(hi)

    for g, statements in enumerate(GROUP_STATEMENTS):
        for statement in statements:
            add(lambda a, r, i: a == g and r['statement'] == statement, 1, 1)
        for noise in NOISES:
            add(lambda a, r, i: a == g and r['noise'] == noise, 2, 2)
        for snr, count in zip(SNRS, SNR_COUNTS[g]):
            add(lambda a, r, i: a == g and r['snr'] == snr, count, count)
    for statement in sorted({r['statement'] for r in rows}):
        for noise in NOISES:
            add(lambda g, r, i: r['statement'] == statement and r['noise'] == noise, 0, 1)
        for snr in SNRS:
            add(lambda g, r, i: r['statement'] == statement and r['snr'] == snr, 0, 1)
    for noise in NOISES:
        for snr in SNRS:
            add(lambda g, r, i: r['noise'] == noise and r['snr'] == snr, 2, 3)
    for category, count in [('both_increase', 7), ('both_decrease', 17), ('mixed', 6)]:
        add(lambda g, r, i: direction(r) == category, count, count)
    for q, count in enumerate([8, 7, 7, 8]):
        add(lambda g, r, i: quartile[i] == q, count, count)

    # Minimize standardized differences from source means at each SNR, for both
    # untreated difficulty and before/after effects. Neither metric is preferred.
    moments = [(snr, mode, metric) for snr in SNRS for mode in ['baseline', 'delta'] for metric in ['stoi', 'estoi']]
    for k, (snr, mode, metric) in enumerate(moments):
        source_values = [r[mode][metric] for r in rows if r['snr'] == snr]
        mean, sd = float(np.mean(source_values)), float(np.std(source_values))
        count = sum(SNR_COUNTS[g][SNRS.index(snr)] for g in range(5))
        coefficients = {j: (rows[i][mode][metric] - mean) / (count * sd)
                        for j, (g, i) in enumerate(variables) if rows[i]['snr'] == snr}
        for sign in [1, -1]:
            constraints.append({**{j: sign * v for j, v in coefficients.items()}, nv+k: -1})
            lower.append(-np.inf); upper.append(0)
    size = nv + len(moments)
    matrix = lil_matrix((len(constraints), size))
    for k, coefficients in enumerate(constraints):
        for j, value in coefficients.items(): matrix[k, j] = value
    rng = np.random.default_rng(20261122)
    objective = np.r_[rng.random(nv)*1e-8, np.ones(len(moments))]
    result = milp(objective, integrality=np.r_[np.ones(nv), np.zeros(len(moments))],
                  bounds=Bounds(np.zeros(size), np.r_[np.ones(nv), np.full(len(moments), np.inf)]),
                  constraints=LinearConstraint(matrix.tocsr(), lower, upper),
                  options={'time_limit': 45, 'mip_rel_gap': .05})
    if result.x is None:
        raise ValueError('No allocation satisfies the registered balance constraints: ' + result.message)
    chosen = [(g, i) for j, (g, i) in enumerate(variables) if result.x[j] > .5]
    if len(chosen) != 30 or len({i for g, i in chosen}) != 30:
        raise ValueError('Invalid selection size or duplicate source conditions.')
    groups = []
    recordings = {r['id']: r for r in data['recordings']}
    for g in range(5):
        selected = sorted([rows[i] for a, i in chosen if a == g], key=lambda r: GROUP_STATEMENTS[g].index(r['statement']))
        conditions = []
        for row in selected:
            reference = recordings[row['statement']]
            conditions.append({**{k: row[k] for k in ['statement', 'speaker', 'noise', 'snr', 'input_path', 'input_sha256', 'output_path', 'output_sha256']},
                               'text': reference['text'], 'baseline': {m: row['baseline'][m] for m in ['stoi','estoi']},
                               'filtered': {m: row['filtered'][m] for m in ['stoi','estoi']},
                               'delta': row['delta'], 'direction': direction(row),
                               'change_magnitude_quartile': quartile[by_key[(row['statement'], row['noise'], row['snr'])]]+1})
        groups.append({'id': str(g+1), 'conditions': conditions})
    selected_rows = [rows[i] for g, i in chosen]
    summary = {mode: {m: float(np.mean([r[mode][m] for r in selected_rows])) for m in ['stoi','estoi']}
               for mode in ['baseline', 'filtered', 'delta']}
    return {'version': 1, 'status': 'audio_selection_completed', 'created_at': datetime.now(timezone.utc).isoformat(),
            'source': {'run_id': data['run_id'], 'path': pointer['results'], 'sha256': pointer['sha256'], 'bpf_run_id': data['bpf_run_id']},
            'scope': {'groups': 5, 'conditions_per_group': 6, 'audio_per_participant': 12,
                      'selected_conditions': 30, 'selected_audio_files': 60, 'covered_statements': 12, 'target_participants': None},
            'selection': {'basis': 'balanced representative sample by baseline STOI/ESTOI, paired changes, direction and magnitude quartiles',
                          'direction_counts': {'both_increase': 7, 'both_decrease': 17, 'mixed': 6},
                          'magnitude_quartile_counts': [8, 7, 7, 8], 'magnitude_delta_standard_deviations': scale,
                          'seed': 20261122, 'optimizer': 'scipy.optimize.milp', 'solver_status': int(result.status),
                          'solver_message': result.message, 'objective_value': float(result.fun),
                          'mip_gap': float(result.mip_gap) if result.mip_gap is not None else None,
                          'optimality_claim': False},
            'playback': {'pair_order': ['baseline', 'filtered'], 'adjacent_pairs': True,
                         'pair_sequence': 'shuffle_per_participant_then_persist', 'replay_limit': None,
                         'baseline': 'original_mixture', 'filtered': 'existing_stored_bpf_wav', 'new_wavs_created': 0},
            'evaluation_relationship': 'The source 12 sentences and 144 mixtures informed BPF selection. This score-selected 30-condition subset is for exploratory paired listening and is not an independent final evaluation or a random estimate for all 144 conditions. Fixed baseline-first order includes repetition/order effects.',
            'groups': groups, 'selected_summary': summary, 'source_summary': data['summaries'][0]}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path)
    parser.add_argument('--verify-config', type=Path)
    parser.add_argument('--csv-output', type=Path)
    args = parser.parse_args()
    selection = read(args.verify_config) if args.verify_config else select()
    verification = verify(selection)
    if args.output:
        target = args.output.resolve()
        if not target.is_relative_to(ROOT / 'experiment/config'):
            raise ValueError('Selection configuration must stay inside experiment/config.')
        with target.open('x', encoding='utf-8', newline='\n') as stream:
            json.dump(selection, stream, ensure_ascii=False, allow_nan=False, indent=2)
            stream.write('\n')
    if args.csv_output:
        write_csv(selection, args.csv_output)
    print(json.dumps({'status': selection['status'], 'output': str(args.output),
                      'verification': verification,
                      'scope': selection['scope'], 'selected_summary': selection['selected_summary'],
                      'groups': [{'id': g['id'], 'conditions': [{k:r[k] for k in ['statement','noise','snr','direction']} for r in g['conditions']]} for g in selection['groups']]}, ensure_ascii=False))
