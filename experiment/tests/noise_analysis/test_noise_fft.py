import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import wave

import numpy as np

from experiment.src.noise_analysis.run_fft import PROJECT_ROOT, load_json, run_fft, write_json
from experiment.src.noise_analysis.plot_spectrum import plot_spectra


class NoiseFFTTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cache = PROJECT_ROOT / ".cache/noise_analysis"
        cache.mkdir(parents=True, exist_ok=True)
        cls.build = tempfile.TemporaryDirectory(prefix="fft-tests-", dir=cache)
        cls.executable = Path(cls.build.name) / "noise_fft.exe"
        subprocess.run([str(PROJECT_ROOT / ".tools/tcc/tcc.exe"), "-std=c99", "-Wall", "-Werror",
                        str(PROJECT_ROOT / "experiment/src/noise_analysis/noise_fft.c"), "-o", str(cls.executable)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="case-", dir=self.build.name)
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def wav(self, path, pcm, channels=1):
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as file:
            file.setnchannels(channels)
            file.setsampwidth(2)
            file.setframerate(16000)
            file.writeframes(np.asarray(pcm, dtype="<i2").tobytes())

    def calculate(self, pcm):
        wav = self.root / "input.wav"
        self.wav(wav, pcm)
        csv = self.root / "spectrum.csv"
        metadata = self.root / "metadata.json"
        process = self.execute(wav, csv, metadata)
        self.assertEqual(process.returncode, 0, process.stderr)
        return np.loadtxt(csv, delimiter=",", skiprows=1), load_json(metadata)

    def execute(self, wav, csv, metadata):
        return subprocess.run([str(self.executable), "--input", str(wav), "--spectrum", str(csv),
                               "--metadata", str(metadata), "--window", "hann_periodic"], capture_output=True, text=True)

    def test_whole_record_hann_matches_numpy_at_actual_and_non_power_of_two_lengths(self):
        for count in (13, 1025, 87360):
            with self.subTest(samples=count):
                pcm = np.random.default_rng(count).integers(-20000, 20000, count, dtype=np.int16)
                values, metadata = self.calculate(pcm)
                size = 1 << (count - 1).bit_length()
                weights = 0.5 - 0.5 * np.cos(2 * np.pi * np.arange(count) / count)
                fft = np.fft.rfft(pcm.astype(float) / 32768 * weights, n=size)
                factor = np.full(fft.size, 2.0); factor[[0, -1]] = 1
                amplitude = factor * np.abs(fft) / weights.sum()
                density = factor * np.abs(fft) ** 2 / (16000 * np.dot(weights, weights))
                np.testing.assert_allclose(values[:, 0], np.fft.rfftfreq(size, 1 / 16000), rtol=0, atol=1e-9)
                np.testing.assert_allclose(values[:, 1], amplitude, rtol=1e-8, atol=1e-13)
                np.testing.assert_allclose(values[:, 2], 20 * np.log10(np.maximum(amplitude, 1e-15)), rtol=0, atol=1e-5)
                np.testing.assert_allclose(values[:, 3], density, rtol=1e-8, atol=1e-15)
                expected_power = np.dot((pcm / 32768 * weights), (pcm / 32768 * weights)) / np.dot(weights, weights)
                self.assertAlmostEqual(values[:, 3].sum() * 16000 / size, expected_power, places=10)
                self.assertEqual((metadata["sample_count"], metadata["fft_size"]), (count, size))
                (self.root / "spectrum.csv").unlink(); (self.root / "metadata.json").unlink()

    def test_amplitude_reference_and_dc_nyquist_scaling(self):
        count = 4096
        for signal, expected_bin, expected_amplitude in (
            (np.round(8192 * np.sin(2 * np.pi * 256 * np.arange(count) / count)), 256, .25),
            (np.full(count, 16384), 0, .5),
            (16384 * (-1) ** np.arange(count), count // 2, .5),
            (np.zeros(count), 0, 0),
        ):
            values, _ = self.calculate(signal)
            self.assertAlmostEqual(values[expected_bin, 1], expected_amplitude, delta=2e-5)
            if expected_amplitude == 0:
                self.assertTrue(np.all(values[:, 2] == -300))
            (self.root / "spectrum.csv").unlink(); (self.root / "metadata.json").unlink()

    def test_invalid_input_and_existing_output_are_not_overwritten(self):
        wav, csv, metadata = (self.root / name for name in ("input.wav", "spectrum.csv", "metadata.json"))
        self.wav(wav, np.ones(32), channels=2)
        self.assertNotEqual(self.execute(wav, csv, metadata).returncode, 0)
        self.assertFalse(csv.exists())
        self.wav(wav, np.ones(32))
        original = wav.read_bytes()
        self.assertNotEqual(self.execute(wav, wav, metadata).returncode, 0)
        self.assertEqual(wav.read_bytes(), original)
        wav.write_bytes(original[:-3])
        self.assertNotEqual(self.execute(wav, csv, metadata).returncode, 0)
        self.assertFalse(csv.exists())

    def prepare_project(self):
        cache = self.root / ".cache/noise_analysis"
        cache.mkdir(parents=True)
        shutil.copyfile(self.executable, cache / "noise_fft.exe")
        source = self.root / "experiment/src/noise_analysis/noise_fft.c"
        source.parent.mkdir(parents=True)
        shutil.copyfile(PROJECT_ROOT / "experiment/src/noise_analysis/noise_fft.c", source)
        config = self.root / "experiment/config"
        config.mkdir(parents=True)
        write_json(config / "noise_analysis.json", {"version": 1, "window_function": "hann_periodic", "peak_detection": "pending"})
        write_json(config / "paths.json", {"manifest": "experiment/data/metadata/dataset.json",
                   "audio_roots": [{"public": "data/noise", "source": "experiment/data/noise"}]})
        catalog = self.root / "experiment/data/metadata/dataset.json"
        catalog.parent.mkdir(parents=True)
        noises = ("single", "complex", "changing")
        write_json(catalog, {"noise_sources": [{"id": "noise_" + noise, "path": "data/noise/" + noise + ".wav"} for noise in noises]})
        for index, noise in enumerate(noises):
            self.wav(self.root / ("experiment/data/noise/" + noise + ".wav"), np.arange(256) * (index + 1))

    def test_plotting_uses_saved_c_results_without_executable_and_preserves_run_history(self):
        self.prepare_project()
        first = run_fft(self.root)
        second = run_fft(self.root)
        self.assertNotEqual(first["manifest"], second["manifest"])
        self.assertTrue(Path(first["manifest"]).exists())
        (self.root / ".cache/noise_analysis/noise_fft.exe").unlink()
        result = plot_spectra(self.root)
        self.assertEqual(result["graphs"], 4)
        public = load_json(self.root / "experiment/outputs/noise_analysis/results.json")
        self.assertTrue(all(row["peaks"] is None for row in public["sources"]))
        self.assertEqual(public["mixtures"], [])
        for relative, expected in public["artifacts"].items():
            graph = self.root / "experiment/outputs/graphs/noise_analysis" / relative.removeprefix("graphs/")
            self.assertEqual(hashlib.sha256(graph.read_bytes()).hexdigest(), expected)

    def test_changed_csv_and_failed_calculation_preserve_completed_results(self):
        self.prepare_project()
        result = run_fft(self.root)
        latest_file = self.root / "experiment/outputs/noise_analysis/latest.json"
        latest = latest_file.read_bytes()
        csv = Path(result["manifest"]).parent / "single/spectrum.csv"
        csv.write_text("corrupted", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "changed"):
            plot_spectra(self.root)
        (self.root / "experiment/data/noise/complex.wav").write_bytes(b"invalid WAV")
        with self.assertRaises(subprocess.CalledProcessError):
            run_fft(self.root)
        self.assertEqual(latest_file.read_bytes(), latest)
        self.assertTrue(Path(result["manifest"]).exists())


if __name__ == "__main__":
    unittest.main()
