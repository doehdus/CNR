"""Independent tests of normalized cohort power and variable-length frames."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

import numpy as np
from scipy.signal import find_peaks, welch

ROOT = Path(__file__).resolve().parents[3]


class MixtureSummaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(dir=ROOT / '.cache/noise_analysis')
        cls.folder = Path(cls.temporary.name)
        cls.executable = cls.folder / 'analysis.exe'
        subprocess.run([str(ROOT / '.tools/tcc/tcc.exe'), '-std=c99', '-Wall', '-Werror',
                        str(ROOT / 'analysis/mkgraphs/analyze_signals.c'), '-o', str(cls.executable)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def write_wave(self, path, pcm):
        with wave.open(str(path), 'wb') as file:
            file.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
            file.writeframes(np.asarray(pcm, dtype='<i2').tobytes())

    def calculate(self, folder, silent=False, multiplier=1):
        members, lines = [], []
        for i, count in enumerate([8192, 12288]):
            time = np.arange(count) / 16000
            speech = np.round(1800 * np.sin(2 * np.pi * 500 * time)).astype(np.int16) * (i + 1) * multiplier
            noise = np.round(900 * np.sin(2 * np.pi * 1000 * time)).astype(np.int16) * (i + 1) * multiplier
            noise[:4096] = 0
            if silent: speech[:] = 0
            self.write_wave(folder / f's{i}.wav', speech)
            self.write_wave(folder / f'm{i}.wav', speech + noise)
            lines.append(f'1024\t7168\tid{i}\t{folder / f"m{i}.wav"}\t{folder / f"s{i}.wav"}\n')
            members.append((speech.astype(float) / 32768, noise.astype(float) / 32768))
        (folder / 'inputs.tsv').write_text(''.join(lines), encoding='ascii')
        (folder / 'anchors.csv').write_text('1,1000,16,992,1008\n', encoding='ascii')
        result = subprocess.run([str(self.executable), '--summary-manifest', str(folder / 'inputs.tsv'),
            '--anchors', str(folder / 'anchors.csv'), '--output', str(folder / 'result.json'), '--split-sample', '4096'], capture_output=True)
        return result, members

    def test_equal_weight_power_rms_and_variable_length_stft_match_scipy(self):
        with tempfile.TemporaryDirectory(dir=self.folder) as name:
            folder = Path(name)
            process, members = self.calculate(folder)
            self.assertEqual(process.returncode, 0, process.stderr)
            data = json.loads((folder / 'result.json').read_text())
            normalized = []
            for index, (speech, noise) in enumerate(members):
                rms = np.sqrt(np.mean(speech[1024:7168] ** 2))
                self.assertAlmostEqual(data['members'][index]['clean_rms'], rms, places=10)
                self.assertAlmostEqual(data['members'][index]['normalization_gain'] * rms, 1, places=10)
                expected_snr = 10 * np.log10(np.mean(speech[1024:7168] ** 2) / np.mean(noise[1024:7168] ** 2))
                self.assertAlmostEqual(data['members'][index]['actual_snr_db'], expected_snr, places=9)
                normalized.append([(speech + noise) / rms, speech / rms, noise / rms])
            db = lambda power: 10 * np.log10(np.maximum(power, 1e-16))
            for k, key in enumerate(['mixture', 'speech', 'added_noise']):
                spectra = np.array([welch(row[k], 16000, nperseg=2048, noverlap=1024)[1] for row in normalized])
                measured = data['signals'][key]
                np.testing.assert_allclose(measured['mean_db'], db(spectra.mean(axis=0)), atol=1e-7, rtol=0)
                np.testing.assert_allclose(measured['min_db'], db(spectra.min(axis=0)), atol=1e-7, rtol=0)
                np.testing.assert_allclose(measured['max_db'], db(spectra.max(axis=0)), atol=1e-7, rtol=0)
                for frame in range(11):
                    available = [row[k][frame * 1024:frame * 1024 + 2048] for row in normalized if len(row[k]) >= frame * 1024 + 2048]
                    expected = np.mean([welch(x, 16000, nperseg=2048)[1] for x in available], axis=0)
                    np.testing.assert_allclose(measured['spectrogram_db'][frame], db(expected), atol=1e-7, rtol=0)
                for part, start, end in [('before_db', 0, 4096), ('after_db', 4096, None)]:
                    expected = np.mean([welch(row[k][start:end], 16000, nperseg=2048)[1] for row in normalized], axis=0)
                    np.testing.assert_allclose(measured[part], db(expected), atol=1e-7, rtol=0)
                for peak, matched in zip(measured['peaks'], measured['peak_counts']):
                    tolerance = max(2 * 16000 / 2048, peak['bandwidth_hz'] * .5)
                    expected = sum(any(abs(index * 16000 / 2048 - peak['frequency_hz']) <= tolerance for index in find_peaks(db(power), prominence=6, distance=6)[0]) for power in spectra)
                    self.assertEqual(matched, expected)
            self.assertEqual(data['participant_counts'], [2] * 7 + [1] * 4)
            frames = data['signals']['mixture']['temporal_peaks'][0]['frames']
            self.assertEqual(frames[0], [0, 0, None, None])
            self.assertTrue(all(frame[0] <= valid for frame, valid in zip(frames, data['participant_counts'])))

    def test_common_amplitude_change_cancels_and_silent_clean_is_rejected(self):
        with tempfile.TemporaryDirectory(dir=self.folder) as a, tempfile.TemporaryDirectory(dir=self.folder) as b:
            first, _ = self.calculate(Path(a))
            second, _ = self.calculate(Path(b), multiplier=2)
            self.assertEqual(first.returncode, 0); self.assertEqual(second.returncode, 0)
            one = json.loads((Path(a) / 'result.json').read_text())
            two = json.loads((Path(b) / 'result.json').read_text())
            self.assertEqual(one['signals'], two['signals'])
        with tempfile.TemporaryDirectory(dir=self.folder) as a:
            failed, _ = self.calculate(Path(a), silent=True)
            self.assertNotEqual(failed.returncode, 0)
            self.assertFalse((Path(a) / 'result.json').exists())

    def test_completed_144_condition_summary_matches_independent_welch(self):
        target = ROOT / 'before1123/experiment/outputs/mixture_summary/results.json'
        if not target.exists(): self.skipTest('No completed summary is registered yet.')
        data = json.loads(target.read_text(encoding='utf-8'))
        self.assertEqual(len(data['groups']), 12)
        for group in data['groups']:
            spectra = [[], [], []]
            for member in group['members']:
                with wave.open(str(ROOT / f"data/mixtures/{group['noise']}/snr{group['snr']:02d}/{member['id']}.wav"), 'rb') as file:
                    mixture = np.frombuffer(file.readframes(file.getnframes()), '<i2').astype(float) / 32768
                with wave.open(str(ROOT / f"data/reference/{member['id']}.wav"), 'rb') as file:
                    speech = np.frombuffer(file.readframes(file.getnframes()), '<i2').astype(float) / 32768
                rms = np.sqrt(np.mean(speech[member['start_sample']:member['end_sample']] ** 2))
                self.assertAlmostEqual(rms, member['clean_rms'], places=10)
                for k, signal in enumerate([mixture, speech, mixture - speech]):
                    spectra[k].append(welch(signal / rms, 16000, nperseg=2048, noverlap=1024)[1])
            for k, key in enumerate(['mixture', 'speech', 'added_noise']):
                expected = 10 * np.log10(np.maximum(np.mean(spectra[k], axis=0), 1e-16))
                np.testing.assert_allclose(group['signals'][key]['mean_db'], expected, atol=1e-7, rtol=0,
                                           err_msg=f"{group['noise']}/{group['snr']}/{key}")


if __name__ == '__main__':
    unittest.main()
