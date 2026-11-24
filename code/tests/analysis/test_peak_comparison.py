from tests.legacy import archive_path
"""Independent aggregation, segment-boundary, missing-value and band-power checks."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

import numpy as np
from scipy.signal import find_peaks, welch

ROOT = Path(__file__).resolve().parents[3]


class PeakComparisonTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(dir=ROOT / '.cache/noise_analysis')
        cls.folder = Path(cls.temporary.name)
        cls.aggregate = cls.folder / 'aggregate.exe'
        cls.analyzer = cls.folder / 'analyzer.exe'
        for code, target in [('aggregate_peak_comparison.c', cls.aggregate), ('analyze_signals.c', cls.analyzer)]:
            subprocess.run([str(ROOT / '.tools/tcc/tcc.exe'), '-std=c99', '-Wall', '-Werror',
                            str(ROOT / 'analysis/mkgraphs' / code), '-o', str(target)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def test_missing_tracks_excluded_from_frequency_stats_but_zero_in_appearance(self):
        lines = []
        for group in range(20):
            lines.append(f'{group} 1\n')
            for bin in range(1025): lines.append(f'{bin * 16000 / 2048} {10 * np.log10(5)} 0\n')
            lines.append('1 100 90 110 20 -1 -1 -1 0 0 0 0\n')
            for i in range(12):
                if group == 0 and i < 2: lines.append(f'1 {100 + i * 4} {1 + i * 2} {50 + i * 50} 1 0 1\n')
                else: lines.append('0 0 0 0 0 0 0\n')
        source, result = self.folder / 'stats.txt', self.folder / 'stats.json'
        source.write_text(''.join(lines), encoding='ascii')
        subprocess.run([str(self.aggregate), str(source), str(result)], check=True)
        data = json.loads(result.read_text())['groups']
        peak = data[0]['peaks'][0]
        self.assertEqual(peak['valid_tracks'], 2)
        self.assertEqual(peak['mean_frequency_hz'], 102)
        self.assertEqual(peak['mean_offset_hz'], 2)
        self.assertEqual(peak['mean_std_hz'], 2)
        self.assertEqual(peak['mean_appearance_percent'], 12.5)
        self.assertEqual(peak['mixture_count'], 2)
        self.assertAlmostEqual(peak['clean_to_noise_db'], 10 * np.log10(5), places=9)
        self.assertGreater(abs(peak['clean_to_noise_db'] - (10 * np.log10(1) + 10 * np.log10(9)) / 2), 2)
        empty = data[1]['peaks'][0]
        self.assertIsNone(empty['mean_frequency_hz']); self.assertIsNone(empty['mean_std_hz'])
        self.assertEqual(empty['mean_appearance_percent'], 0)

    def test_exact_split_excludes_boundary_windows_and_preserves_subtraction(self):
        with tempfile.TemporaryDirectory(dir=self.folder) as name:
            folder = Path(name)
            t = np.arange(88000) / 16000
            clean = np.round(2000 * np.sin(2 * np.pi * 500 * t)).astype(np.int16)
            noise = np.round(2000 * np.sin(2 * np.pi * 1000 * t)).astype(np.int16); noise[:40000] = 0
            for key, samples in [('clean', clean), ('mixture', clean + noise)]:
                with wave.open(str(folder / (key + '.wav')), 'wb') as file:
                    file.setparams((1, 2, 16000, 0, 'NONE', 'not compressed')); file.writeframes(samples.tobytes())
            (folder / 'input.tsv').write_text(f"noise\t2\t{folder / 'mixture.wav'}\t{folder / 'clean.wav'}\n", encoding='ascii')
            (folder / 'anchors.csv').write_text('1,1000,16,992,1008\n', encoding='ascii')
            output = folder / 'result.json'
            subprocess.run([str(self.analyzer), '--peak-periods-manifest', str(folder / 'input.tsv'), '--anchors', str(folder / 'anchors.csv'), '--output', str(output)], check=True)
            before, after = json.loads(output.read_text())['records'][0]['periods']
            self.assertEqual(before['start_sample'], 0); self.assertEqual(before['sample_count'], 40000)
            self.assertEqual(before['frame_count'], 38); self.assertFalse(before['peaks'][0]['peak_detected'])
            self.assertIsNone(before['peaks'][0]['track_id']); self.assertEqual(before['peaks'][0]['appearance_percent'], 0)
            self.assertEqual(after['start_sample'], 40000); self.assertEqual(after['frame_count'], 45)
            self.assertTrue(after['peaks'][0]['peak_detected']); self.assertEqual(after['peaks'][0]['mean_hz'], 1000)
            self.assertEqual(after['peaks'][0]['std_hz'], 0); self.assertEqual(after['peaks'][0]['appearance_percent'], 100)

    def test_completed_aggregates_match_individual_tracks_and_linear_band_ratio(self):
        folder = archive_path('experiment/outputs/mixture_summary')
        data = json.loads((folder / 'peak_comparison.json').read_text(encoding='utf-8'))
        summary = json.loads((folder / 'results.json').read_text(encoding='utf-8'))
        frequency = np.array(summary['frequency_hz'])
        self.assertEqual(len(data['groups']), 20); self.assertEqual(len(data['graphs']), 9)
        cache = {}
        def read(path):
            if path not in cache: cache[path] = json.loads(path.read_text(encoding='utf-8'))
            return cache[path]
        for group in data['groups']:
            source = next(g for g in summary['groups'] if (g['noise'], g['snr']) == (group['noise'], group['snr']))
            for i, peak in enumerate(group['peaks']):
                tracks = []
                for member in group['members']:
                    if group['period'] == 'whole':
                        values = read(archive_path('experiment/outputs/peak_analysis') / member['details'])['signal']['tracking']['tracks']
                        track = next((t for t in values if t['id'] == member['track_ids'][i]), None)
                    else:
                        record = next(r for r in read(folder / member['period_data'])['records'] if r['id'] == 'm_' + member['id'])
                        track = next(p for p in record['periods'] if p['period'] == group['period'])['peaks'][i]
                        if track['track_id'] is None: track = None
                    if track is not None: tracks.append(track)
                self.assertEqual(peak['valid_tracks'], len(tracks))
                if tracks:
                    self.assertAlmostEqual(peak['mean_frequency_hz'], np.mean([t['mean_hz'] for t in tracks]), delta=2e-8)
                    self.assertAlmostEqual(peak['mean_std_hz'], np.mean([t['std_hz'] for t in tracks]), delta=2e-8)
                else:
                    self.assertIsNone(peak['mean_frequency_hz']); self.assertIsNone(peak['mean_std_hz'])
                self.assertAlmostEqual(peak['mean_appearance_percent'], sum(t['appearance_percent'] for t in tracks) / 12, delta=1e-8)
                field = 'mean_db' if group['period'] == 'whole' else group['period'] + '_db'
                band = (frequency >= peak['low_hz']) & (frequency <= peak['high_hz'])
                clean = np.sum(10 ** (np.array(source['signals']['speech'][field])[band] / 10))
                noise = np.sum(10 ** (np.array(source['signals']['added_noise'][field])[band] / 10))
                self.assertAlmostEqual(peak['clean_to_noise_db'], 10 * np.log10(clean / noise), delta=1e-8)

    def test_all_changing_segment_detection_flags_match_independent_scipy(self):
        folder = archive_path('experiment/outputs/mixture_summary')
        data = json.loads((folder / 'peak_comparison.json').read_text(encoding='utf-8'))
        analysis = json.loads((archive_path('experiment/outputs/peak_analysis/results.json')).read_text(encoding='utf-8'))
        anchors = next(s for s in analysis['sources'] if s['noise'] == 'changing')['peaks']
        def wave_read(path):
            with wave.open(str(path), 'rb') as file: return np.frombuffer(file.readframes(file.getnframes()), '<i2').astype(float) / 32768
        for relative in data['period_hashes']:
            snr = int(Path(relative).stem.split('_')[1][3:])
            records = json.loads((folder / relative).read_text(encoding='utf-8'))['records']
            for record in records:
                if record['id'] == 'original': signal = wave_read(ROOT / 'data/noise/changing.wav')
                else:
                    prefix, identity = record['id'].split('_', 1)
                    clean = wave_read(ROOT / f'data/reference/{identity}.wav')
                    signal = clean if prefix == 'c' else wave_read(ROOT / f'data/mixtures/changing/snr{snr:02d}/{identity}.wav')
                    if prefix == 'n': signal = signal - clean
                signal = signal * record['normalization_gain']
                for period in record['periods']:
                    start, count = period['start_sample'], period['sample_count']
                    self.assertIn(start, [0, 40000])
                    self.assertEqual(period['frame_count'], 1 + (count - 2048) // 1024)
                    frequency, power = welch(signal[start:start+count], 16000, nperseg=2048, noverlap=1024)
                    indices = find_peaks(10 * np.log10(np.maximum(power, 1e-16)), prominence=6, distance=6)[0]
                    for peak, anchor in zip(period['peaks'], anchors):
                        tolerance = max(2 * 16000 / 2048, anchor['bandwidth_hz'] * .5)
                        self.assertEqual(peak['peak_detected'], any(abs(frequency[index] - anchor['frequency_hz']) <= tolerance for index in indices))


if __name__ == '__main__':
    unittest.main()
