"""Independent numerical checks against SciPy and known synthetic trajectories."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import wave

import numpy as np
from scipy.signal import find_peaks, peak_widths, welch

ROOT = Path(__file__).resolve().parents[3]


class SignalAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(dir=ROOT / ".cache/noise_analysis")
        cls.directory = Path(cls.temporary.name)
        cls.executable = cls.directory / "analyze_signals.exe"
        subprocess.run([str(ROOT / ".tools/tcc/tcc.exe"), "-std=c99", "-Wall", "-Werror",
                        str(ROOT / "analysis/mkgraphs/analyze_signals.c"), "-o", str(cls.executable)], check=True)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def run_signal(self, pcm):
        with tempfile.TemporaryDirectory(dir=self.directory) as directory:
            input_file, output = Path(directory) / "signal.wav", Path(directory) / "result.json"
            with wave.open(str(input_file), "wb") as file:
                file.setnchannels(1); file.setsampwidth(2); file.setframerate(16000)
                file.writeframes(np.asarray(pcm, dtype="<i2").tobytes())
            subprocess.run([str(self.executable), "--input", str(input_file), "--output", str(output)], check=True)
            return json.loads(output.read_text(encoding="utf-8"))

    def test_welch_frame_psd_and_peak_widths_match_independent_scipy(self):
        for count in (4096, 79851):
            with self.subTest(samples=count):
                t = np.arange(count) / 16000
                pcm = np.round(5000 * np.sin(2 * np.pi * 109.375 * t) +
                               3000 * np.sin(2 * np.pi * 476.5625 * t) +
                               np.random.default_rng(count).normal(0, 700, count)).astype(np.int16)
                signal = pcm.astype(float) / 32768
                result = self.run_signal(pcm)["signal"]
                frequency, power = welch(signal, 16000, window="hann", nperseg=2048,
                                         noverlap=1024, detrend="constant", scaling="density")
                expected_db = 10 * np.log10(np.maximum(power, 1e-16))
                np.testing.assert_allclose(result["psd_db"], expected_db, atol=1e-7, rtol=0)
                ids, properties = find_peaks(expected_db, prominence=6, distance=6)
                selected = ids[np.argsort(power[ids])[::-1]][:8]
                self.assertEqual([p["frequency_hz"] for p in result["peaks"]], frequency[selected].tolist())
                for peak, index in zip(result["peaks"], selected):
                    width, _, left, right = peak_widths(power, [index], rel_height=.5)
                    self.assertAlmostEqual(peak["bandwidth_hz"], width[0] * 16000 / 2048, places=7)
                    self.assertAlmostEqual(peak["low_hz"], left[0] * 16000 / 2048, places=7)
                    self.assertAlmostEqual(peak["high_hz"], right[0] * 16000 / 2048, places=7)
                np.testing.assert_allclose(result["spectrogram_db"][0],
                    10 * np.log10(np.maximum(welch(signal[:2048], 16000, nperseg=2048)[1], 1e-16)), atol=1e-7)

    def test_adjacent_frame_tracks_have_real_counts_and_break_at_missing_frames(self):
        count = 16384
        t = np.arange(count) / 16000
        pcm = np.round(8000 * np.sin(2 * np.pi * 500 * t)).astype(np.int16)
        pcm[6144:10240] = 0
        result = self.run_signal(pcm)["signal"]
        tracks = result["tracking"]["tracks"]
        tone_tracks = [track for track in tracks if abs(track["mean_hz"] - 500) < 1]
        self.assertGreaterEqual(len(tone_tracks), 2)
        for track in tracks:
            frames = [point[0] for point in track["points"]]
            self.assertEqual(frames, list(range(frames[0], frames[-1] + 1)))
            self.assertEqual(track["count"], len(frames))
            self.assertAlmostEqual(track["appearance_percent"], len(frames) / result["frame_count"] * 100)
            values = [point[1] for point in track["points"]]
            self.assertAlmostEqual(track["mean_hz"], np.mean(values), places=6)
            self.assertAlmostEqual(track["std_hz"], np.std(values), places=5)

    def test_silence_remains_finite_and_has_no_peaks(self):
        signal = self.run_signal(np.zeros(4096, dtype=np.int16))["signal"]
        self.assertEqual(signal["peaks"], [])
        self.assertEqual(signal["tracking"]["tracks"], [])
        self.assertTrue(all(value == -160 for value in signal["psd_db"]))

    def test_original_three_noise_results_remain_exact_after_tracking_reuse(self):
        base = ROOT / 'before1123/experiment/outputs/peak_analysis'
        result_path = base / 'results.json'
        if not result_path.exists(): self.skipTest('No registered individual results.')
        original = json.loads(result_path.read_text(encoding='utf-8'))
        for source in original['sources']:
            with self.subTest(noise=source['noise']):
                with wave.open(str(ROOT / f"data/noise/{source['noise']}.wav"), 'rb') as file:
                    samples = np.frombuffer(file.readframes(file.getnframes()), '<i2')
                measured = self.run_signal(samples)['signal']
                measured.pop('spectrogram_db')
                expected = json.loads((base / source['details']).read_text(encoding='utf-8'))['signal']
                self.assertEqual(measured, expected)

    def test_reference_subtraction_snr_and_noise_peak_correspondence_are_calculated_in_c(self):
        with tempfile.TemporaryDirectory(dir=self.directory) as directory:
            base = Path(directory)
            time = np.arange(8192) / 16000
            speech = np.round(7000 * np.sin(2 * np.pi * 500 * time)).astype(np.int16)
            noise = np.round(7000 * np.sin(2 * np.pi * 1000 * time)).astype(np.int16)
            for name, pcm in (("reference", speech), ("mixture", speech + noise)):
                with wave.open(str(base / (name + ".wav")), "wb") as file:
                    file.setnchannels(1); file.setsampwidth(2); file.setframerate(16000); file.writeframes(pcm.tobytes())
            # A narrow anchor still admits a peak one bin away: the two-bin
            # minimum must win over width/2 (regression for TinyCC fmax calls).
            (base / "anchors.csv").write_text("1,1007.8125,10,1002.8125,1012.8125\n", encoding="ascii")
            command = [str(self.executable), "--input", str(base / "mixture.wav"), "--output", str(base / "result.json"),
                       "--reference", str(base / "reference.wav"), "--anchors", str(base / "anchors.csv"),
                       "--start-sample", "1024", "--end-sample", "6144"]
            subprocess.run(command, check=True)
            result = json.loads((base / "result.json").read_text())
            expected = 10 * np.log10(np.mean(speech[1024:6144].astype(float) ** 2) / np.mean(noise[1024:6144].astype(float) ** 2))
            self.assertAlmostEqual(result["actual_snr_db"], expected, places=9)
            self.assertEqual(result["interval_sec"], [1024 / 16000, 6144 / 16000])
            self.assertEqual(result["observations"][0]["mixture_frequency_hz"], 1000)
            self.assertIsInstance(result["observations"][0]["noise_track_id"], int)
            saved = (base / "result.json").read_bytes()
            self.assertNotEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(saved, (base / "result.json").read_bytes())


if __name__ == "__main__":
    unittest.main()
