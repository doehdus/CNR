import copy
import csv
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

import numpy as np
from scipy.signal import butter, sosfreqz

from experiment.src.preprocessing import compare_bpf as comparison
from experiment.src.preprocessing import design_peaking_eq as common

ROOT = common.ROOT


class BPFComparisonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(dir=ROOT / '.cache/noise_analysis')
        cls.folder = Path(cls.temporary.name)
        cls.executable = cls.folder / 'compare_bpf.exe'
        subprocess.run([str(ROOT / '.tools/tcc/tcc.exe'), '-std=c99', '-Wall', '-Werror',
                        str(comparison.CODE), '-o', str(cls.executable)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def example(self):
        grid = [0, 20, 50, 75, 100, 150, 500, 2000, 3500, 4000, 8000]
        speech = [-100, -80, -70, -60, -40, -30, -35, -40, -60, -70, -100]
        noise = [-80, -50, -40, -40, -40, -45, -50, -50, -45, -40, -60]
        mixture = [-70, -45, -35, -35, -30, -25, -30, -35, -35, -35, -50]
        candidates = [{'id': f'test_n{n}', 'lower_hz': 75, 'upper_hz': 4000, 'prototype_order': n} for n in [1, 2, 3, 4]]
        cases = [{'id': 'paired', 'kind': 'individual_mixture', 'has_speech': True, 'arrays': [mixture, speech, noise]},
                 {'id': 'noise_only', 'kind': 'raw_noise', 'has_speech': False, 'arrays': [noise, [-160] * len(grid), noise]}]
        return grid, candidates, cases

    def run_example(self, grid, candidates, cases):
        folder = Path(tempfile.mkdtemp(dir=self.folder))
        transport = folder / 'input.txt'
        comparison.write_transport(transport, grid, candidates, cases)
        args = [str(self.executable), str(transport), str(folder / 'cases.csv'), str(folder / 'responses.csv'), str(folder / 'results.json')]
        subprocess.run(args, check=True, capture_output=True)
        return folder, args

    def test_exact_response_cutoffs_order_and_weighted_metrics(self):
        grid, candidates, cases = self.example()
        folder, _ = self.run_example(grid, candidates, cases)
        with (folder / 'responses.csv').open() as stream: responses = list(csv.DictReader(stream))
        with (folder / 'cases.csv').open() as stream: rows = list(csv.DictReader(stream))
        summary = common.read_json(folder / 'results.json')
        for candidate, measured in zip(candidates, summary['candidates']):
            n = candidate['prototype_order']
            sos = butter(n, [75, 4000], btype='bandpass', fs=16000, output='sos')
            gains = np.abs(sosfreqz(sos, worN=grid, fs=16000)[1]) ** 2
            actual = [float(r['power_gain']) for r in responses if r['candidate_id'] == candidate['id']]
            np.testing.assert_allclose(actual, gains, atol=1e-10, rtol=0)
            self.assertAlmostEqual(actual[grid.index(75)], .5, delta=1e-10)
            self.assertAlmostEqual(actual[grid.index(4000)], .5, delta=1e-10)
            self.assertEqual(actual[0], 0); self.assertEqual(actual[-1], 0)
            self.assertEqual(measured['digital_order'], 2 * n)
            powers = [10 ** (np.array(v) / 10) for v in cases[0]['arrays']]
            drops = [-10 * np.log10(np.sum(p * gains) / np.sum(p)) for p in powers]
            retained = 100 * np.sum(powers[1] * gains) / np.sum(powers[1])
            row = next(r for r in rows if r['candidate_id'] == candidate['id'] and r['case_id'] == 'paired')
            self.assertAlmostEqual(float(row['clean_retained_percent']), retained, delta=1e-10)
            self.assertAlmostEqual(float(row['noise_reduction_db']), drops[2], delta=1e-10)
            self.assertAlmostEqual(float(row['mixture_reduction_db']), drops[0], delta=1e-10)
            self.assertAlmostEqual(float(row['snr_change_db']), drops[2] - drops[1], delta=1e-10)
            self.assertAlmostEqual(measured['clean_retained_percent']['min'], retained, delta=1e-10)
            self.assertEqual(measured['individual_count'], 1)
            raw = next(r for r in rows if r['candidate_id'] == candidate['id'] and r['case_id'] == 'noise_only')
            self.assertEqual(raw['clean_retained_percent'], '')
            self.assertEqual(raw['snr_change_db'], '')

    def test_invalid_candidate_and_existing_outputs_are_rejected(self):
        grid, candidates, cases = self.example()
        for key, value in [('lower_hz', 0), ('lower_hz', 5000), ('upper_hz', 8000), ('prototype_order', 0)]:
            changed = copy.deepcopy(candidates); changed[0][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(subprocess.CalledProcessError):
                self.run_example(grid, changed, cases)
        folder, args = self.run_example(grid, candidates, cases)
        before = {p.name: p.read_bytes() for p in folder.iterdir()}
        with self.assertRaises(subprocess.CalledProcessError): subprocess.run(args, check=True, capture_output=True)
        self.assertEqual(before, {p.name: p.read_bytes() for p in folder.iterdir()})

    def test_all_completed_candidate_responses_match_scipy(self):
        paths = sorted((ROOT / 'experiment/outputs/bpf_candidates/runs').glob('*/manifest.json'), reverse=True)
        if not paths: self.skipTest('Generate the exploratory candidate comparison first.')
        manifest = common.read_json(paths[0]); folder = paths[0].parent
        self.assertEqual(manifest['actual_counts']['individual_mixtures'], 144)
        self.assertEqual(manifest['actual_counts']['filtered_wavs'], 0)
        for name, sha in manifest['artifacts'].items(): self.assertEqual(common.digest(folder / name), sha)
        data = np.genfromtxt(folder / 'responses.csv', delimiter=',', names=True,
                             dtype=[('candidate_id', 'U60'), ('frequency_hz', float), ('power_gain', float)])
        result = common.read_json(folder / 'results.json')
        blocks = data.reshape(result['candidate_count'], result['frequency_bins'])
        for row, block in zip(result['candidates'], blocks):
            with self.subTest(candidate=row['id']):
                self.assertTrue(np.all(block['candidate_id'] == row['id']))
                sos = butter(row['prototype_order'], [row['lower_hz'], row['upper_hz']], btype='bandpass', fs=16000, output='sos')
                expected = np.abs(sosfreqz(sos, worN=block['frequency_hz'], fs=16000)[1]) ** 2
                np.testing.assert_allclose(block['power_gain'], expected, atol=1e-10, rtol=0)
                self.assertEqual(row['individual_count'], 144)
                self.assertLessEqual(row['clean_retained_percent']['max'], 100 + 1e-10)

    def test_grid_is_exploratory_and_never_implicitly_selects_a_filter(self):
        settings = common.read_json(comparison.CONFIG)
        rows = comparison.candidate_grid(settings)
        self.assertEqual(len(rows), 288)
        self.assertIsNone(settings['selected_candidate_id'])
        for change in [{'selected_candidate_id': rows[0]['id']}, {'lower_cutoffs_hz': [100, 100]},
                       {'comparison_mode': 'forward_backward'}, {'prototype_orders': [0]}]:
            altered = {**settings, **change}
            with self.assertRaises(ValueError): comparison.candidate_grid(altered)


if __name__ == '__main__': unittest.main()
