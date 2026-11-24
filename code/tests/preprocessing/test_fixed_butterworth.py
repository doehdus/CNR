"""Check the compiled fixed filters and the actual run's preservation contract."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

import numpy as np
from scipy.signal import butter, sosfilt

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('fixed_butterworth_runner', ROOT / 'code/pre/run_research_bpf.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class FixedButterworthTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(dir=ROOT / '.cache/noise_analysis')
        cls.base = Path(cls.temporary.name)
        cls.executables = {}
        for identity, (number, low, high, order) in runner.CANDIDATES.items():
            executable = cls.base / f'butterworth{number}.exe'
            subprocess.run([str(ROOT / '.tools/tcc/tcc.exe'), *runner.COMPILE_ARGUMENTS,
                            str(ROOT / f'code/pre/butterworth{number}/butterworth{number}.c'),
                            '-o', str(executable)], check=True)
            cls.executables[identity] = executable

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def setUp(self):
        self.case = tempfile.TemporaryDirectory(dir=self.base)
        self.addCleanup(self.case.cleanup)
        self.directory = Path(self.case.name)

    def wav(self, name, values, rate=16000):
        path = self.directory / name
        with wave.open(str(path), 'wb') as stream:
            stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
            stream.writeframes(np.asarray(values, dtype='<i2').tobytes())
        return path

    def execute(self, identity, source, output=None, extra=()):
        arguments = [str(self.executables[identity]), '--input', str(source)]
        if output is not None:
            arguments.extend(['--output', str(output)])
        return subprocess.run([*arguments, *extra], capture_output=True, text=True)

    def test_both_fixed_filters_match_independent_scipy_and_reset_per_wav(self):
        pcm = np.random.default_rng(1124).integers(-3000, 3000, 48000, dtype=np.int16)
        pcm[0] = 15000
        source = self.wav('input.wav', pcm)
        original = source.read_bytes()
        for identity, (number, low, high, order) in runner.CANDIDATES.items():
            with self.subTest(candidate=identity):
                output = self.directory / f'{identity}.wav'
                process = self.execute(identity, source, output)
                self.assertEqual(process.returncode, 0, process.stderr)
                measurements = json.loads(process.stdout)
                self.assertEqual((measurements['filter_id'], measurements['lower_hz'], measurements['upper_hz'],
                                  measurements['prototype_order'], measurements['sos_sections']),
                                 (identity, low, high, order, order))
                self.assertEqual(measurements['output_gain_db'], -1.7)
                sos = butter(order, [low, high], btype='bandpass', fs=16000, output='sos')
                self.assertEqual(runner.verify_output(source, output, sos),
                                 dict(sample_count=len(pcm), max_abs_error_lsb=0, differing_samples=0))
                second = self.directory / f'{identity}-second.wav'
                self.assertEqual(self.execute(identity, source, second).returncode, 0)
                self.assertEqual(output.read_bytes(), second.read_bytes())
        self.assertEqual(source.read_bytes(), original)

    def test_coefficients_and_gain_cannot_be_overridden(self):
        source = self.wav('input.wav', np.zeros(1024))
        for identity in runner.CANDIDATES:
            for extra in [('--section', '1', '0', '0', '0', '0'), ('--gain-db', '-6')]:
                output = self.directory / 'unused.wav'
                process = self.execute(identity, source, output, extra)
                self.assertNotEqual(process.returncode, 0)
                self.assertFalse(output.exists())

    def test_existing_outputs_same_path_and_wrong_rate_are_preserved(self):
        source = self.wav('input.wav', np.arange(1024))
        output = self.directory / 'existing.wav'
        output.write_bytes(b'preserve existing results')
        wrong = self.wav('wrong-rate.wav', np.arange(1024), rate=48000)
        for identity in runner.CANDIDATES:
            self.assertNotEqual(self.execute(identity, source, output).returncode, 0)
            self.assertEqual(output.read_bytes(), b'preserve existing results')
            before = source.read_bytes()
            self.assertNotEqual(self.execute(identity, source, source).returncode, 0)
            self.assertEqual(source.read_bytes(), before)
            invalid = self.directory / 'invalid.wav'
            self.assertNotEqual(self.execute(identity, wrong, invalid).returncode, 0)
            self.assertFalse(invalid.exists())

    def test_overflow_fails_without_creating_clipped_audio(self):
        samples = np.r_[np.zeros(1024), np.full(4000, 32760), np.full(4000, -32760), np.zeros(1024)]
        source = self.wav('overflow.wav', samples)
        original = source.read_bytes()
        for identity, (_, low, high, order) in runner.CANDIDATES.items():
            reference = sosfilt(butter(order, [low, high], btype='bandpass', fs=16000, output='sos'), samples/32768) * 10**(-1.7/20)
            self.assertGreater(float(np.max(np.abs(reference))), 1)
            output = self.directory / f'{identity}-overflow.wav'
            process = self.execute(identity, source, output)
            self.assertNotEqual(process.returncode, 0)
            self.assertIn('overflow', process.stderr)
            self.assertFalse(output.exists())
            measured = self.execute(identity, source, extra=('--measure-only',))
            self.assertEqual(measured.returncode, 0, measured.stderr)
            self.assertGreater(json.loads(measured.stdout)['would_overflow_samples'], 0)
            with self.assertRaisesRegex(ValueError, 'No WAVs were saved'):
                runner.check_headroom(self.executables[identity], [source])
        self.assertEqual(source.read_bytes(), original)

    def test_configured_cutoffs_order_and_processing_are_required(self):
        for identity in runner.CANDIDATES:
            workflow, candidate, sos = runner.prepare(identity)
            self.assertEqual(sos.shape, (candidate['prototype_order'], 6))
        with tempfile.TemporaryDirectory(dir=self.base) as temporary:
            root = Path(temporary)
            config = root / 'code/config/workflow.json'
            config.parent.mkdir(parents=True)
            workflow['candidates']['butterworth']['parameters']['bpf01']['output_gain_db'] = -6
            config.write_text(json.dumps(workflow), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'fixed C filter'):
                runner.prepare('bpf01', root)

    def test_real_input_registry_and_all_condition_keys_are_verified_before_processing(self):
        workflow, _, _ = runner.prepare('bpf01')
        mixtures, registered, watched, _, _ = runner.load_inputs(ROOT, workflow)
        self.assertEqual((len(mixtures), len(registered), len(watched)), (144, 171, 171))
        with tempfile.TemporaryDirectory(dir=self.base) as temporary:
            root = Path(temporary)
            registry = root / 'inputs.json'
            registry.write_text(json.dumps(dict(expected_count=171, files=[])), encoding='utf-8')
            (root / 'mixtures.csv').write_text('unused', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, '171-file'):
                runner.load_inputs(root, dict(input_registry='inputs.json', mixture_metadata='mixtures.csv'))
