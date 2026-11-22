import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

import numpy as np
from scipy.signal import sosfilt
from experiment.src.preprocessing import design_peaking_eq as designer
from experiment.src.preprocessing.run_prefilter import filter_file, selected_design

ROOT = designer.ROOT


class PrefilterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(dir=ROOT / '.cache/noise_analysis')
        cls.folder = Path(cls.temporary.name)
        cls.executable = cls.folder / 'prefilter.exe'
        subprocess.run([str(ROOT / '.tools/tcc/tcc.exe'), '-std=c99', '-Wall', '-Werror',
                        str(ROOT / 'experiment/src/preprocessing/prefilter.c'), '-o', str(cls.executable)], check=True)
        cls.sections = selected_design()[3]['sections']

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def write_wave(self, name, samples, rate=16000):
        target = self.folder / name
        with wave.open(str(target), 'wb') as stream:
            stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            stream.writeframes(np.asarray(samples, dtype='<i2').tobytes())
        return target

    def test_c_cascade_matches_scipy_and_preserves_length_and_input(self):
        time = np.arange(32000) / 16000
        signal = np.rint(4000 * np.sin(2 * np.pi * 4117.1875 * time) +
                         3000 * np.sin(2 * np.pi * 5062.5 * time) + np.random.default_rng(4).normal(0, 1000, time.size)).astype('<i2')
        source = self.write_wave('input.wav', signal)
        before = source.read_bytes()
        first, second = self.folder / 'first.wav', self.folder / 'second.wav'
        stats = filter_file(self.executable, source, first, self.sections)
        filter_file(self.executable, source, second, self.sections)
        sos = np.array([[*s['b'], *s['a']] for s in self.sections])
        expected = sosfilt(sos, signal.astype(float) / 32768) * 32768
        expected = np.where(expected >= 0, np.floor(expected + .5), np.ceil(expected - .5))
        with wave.open(str(first), 'rb') as stream:
            self.assertEqual((stream.getframerate(), stream.getnchannels(), stream.getsampwidth(), stream.getnframes()), (16000, 1, 2, signal.size))
            actual = np.frombuffer(stream.readframes(stream.getnframes()), '<i2')
        np.testing.assert_allclose(actual, expected, atol=1, rtol=0)
        self.assertEqual(stats['clipped_samples'], 0)
        self.assertEqual(before, source.read_bytes())
        self.assertEqual(first.read_bytes(), second.read_bytes())
        with self.assertRaises(subprocess.CalledProcessError): filter_file(self.executable, source, first, self.sections)
        self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_no_resampling_clipping_or_unstable_coefficients(self):
        source = self.write_wave('invalid-rate.wav', [0, 1000, -1000], rate=8000)
        target = self.folder / 'invalid-output.wav'
        with self.assertRaises(subprocess.CalledProcessError): filter_file(self.executable, source, target, self.sections)
        self.assertFalse(target.exists())
        identity = [{'b': [1, 0, 0], 'a': [1, 0, 0]}] * 2
        loud = self.write_wave('loud.wav', [30000] * 10)
        unstable = [{'b': [1, 0, 0], 'a': [1, 0, 2]}, identity[0]]
        for sections in [unstable, [{'b': [3, 0, 0], 'a': [1, 0, 0]}, identity[0]]]:
            with self.assertRaises(subprocess.CalledProcessError): filter_file(self.executable, loud, target, sections)
            self.assertFalse(target.exists())

    def test_completed_batch_matches_independent_scipy_for_all_144_pairs(self):
        pointer = ROOT / 'experiment/outputs/prefilter_results.json'
        if not pointer.exists(): self.skipTest('Run the explicitly selected 144-condition batch first.')
        record = designer.read_json(ROOT / designer.read_json(pointer)['manifest'])
        if not all((ROOT / 'experiment/outputs/enhanced' / r['output_path'].removeprefix('outputs/')).exists() for r in record['conditions']):
            self.skipTest('Archived EQ WAVs are kept locally and are not part of the active shared dataset.')
        self.assertEqual(record['actual_count'], 144)
        sos = np.array([[*s['b'], *s['a']] for s in self.sections])
        for row in record['conditions']:
            with self.subTest(noise=row['noise'], snr=row['snr'], statement=row['statement']):
                source = ROOT / 'experiment/mixtures' / row['input_path'].removeprefix('data/mixed/')
                target = ROOT / 'experiment/outputs/enhanced' / row['output_path'].removeprefix('outputs/')
                self.assertEqual(designer.digest(source), row['input_sha256'])
                self.assertEqual(designer.digest(target), row['output_sha256'])
                with wave.open(str(source), 'rb') as stream: original = np.frombuffer(stream.readframes(stream.getnframes()), '<i2')
                with wave.open(str(target), 'rb') as stream:
                    self.assertEqual((stream.getframerate(), stream.getnchannels(), stream.getsampwidth()), (16000, 1, 2))
                    actual = np.frombuffer(stream.readframes(stream.getnframes()), '<i2')
                self.assertEqual(original.size, actual.size)
                self.assertEqual(actual.size, row['sample_count'])
                expected = sosfilt(sos, original.astype(float) / 32768) * 32768
                expected = np.where(expected >= 0, np.floor(expected + .5), np.ceil(expected - .5))
                np.testing.assert_allclose(actual, expected, atol=1, rtol=0)
                self.assertFalse(np.array_equal(actual, original))


if __name__ == '__main__': unittest.main()
