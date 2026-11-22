"""Physical response, independent SciPy and result-preservation checks."""
import copy
import csv
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
from scipy.optimize import brentq
from scipy.signal import bilinear, freqz

from experiment.src.preprocessing import design_peaking_eq as designer

ROOT = designer.ROOT


class PeakingEQDesignTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cache = ROOT / ".cache/noise_analysis"
        cache.mkdir(parents=True, exist_ok=True)
        cls.temporary = tempfile.TemporaryDirectory(dir=cache)
        cls.directory = Path(cls.temporary.name)
        cls.executable = cls.directory / "designer.exe"
        designer.compile_designer(cls.executable)
        cls.settings = designer.validate_settings(designer.read_json(designer.CONFIG))

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    def calculate(self, settings=None, csv_path=None):
        if csv_path is None:
            folder = Path(tempfile.mkdtemp(dir=self.directory))
            csv_path = folder / "response.csv"
        return designer.calculate(self.executable, settings or self.settings, csv_path), csv_path

    def test_complex_response_matches_independent_prewarped_analog_bilinear_design(self):
        raw, csv_path = self.calculate()
        with csv_path.open(encoding="ascii", newline="") as stream:
            rows = list(csv.DictReader(stream))
        frequency = np.array([float(row["frequency_hz"]) for row in rows])
        self.assertEqual(frequency.size, raw["response_rows"])
        self.assertEqual((frequency[0], frequency[-1]), (0, 8000))
        self.assertTrue(np.all(np.diff(frequency) > 0))
        references = []
        for settings, section in zip(self.settings["sections"], raw["sections"]):
            # Independent route: prewarp an analog peaking prototype, then use
            # SciPy's polynomial bilinear transform, not the C digital formula.
            omega = 2 * 16000 * np.tan(np.pi * settings["center_hz"] / 16000)
            amplitude = 10 ** (settings["gain_db"] / 40)
            b, a = bilinear([1, amplitude * omega / settings["q"], omega ** 2],
                            [1, omega / (amplitude * settings["q"]), omega ** 2], fs=16000)
            np.testing.assert_allclose(section["b"], b, atol=1e-12, rtol=0)
            np.testing.assert_allclose(section["a"], a, atol=1e-12, rtol=0)
            _, expected = freqz(b, a, worN=frequency, fs=16000)
            name = section["id"]
            measured = np.array([complex(float(row[f"{name}_real"]), float(row[f"{name}_imag"])) for row in rows])
            np.testing.assert_allclose(measured, expected, atol=1e-10, rtol=0)
            np.testing.assert_allclose([float(row[f"{name}_gain_db"]) for row in rows],
                                       20 * np.log10(np.abs(expected)), atol=1e-9, rtol=0)
            np.testing.assert_allclose([float(row[f"{name}_phase_deg"]) for row in rows],
                                       np.angle(expected, deg=True), atol=1e-8, rtol=0)
            references.append(expected)
        cascade = np.array([complex(float(row["cascade_real"]), float(row["cascade_imag"])) for row in rows])
        np.testing.assert_allclose(cascade, references[0] * references[1], atol=1e-10, rtol=0)
        np.testing.assert_allclose([float(row["cascade_gain_db"]) for row in rows],
                                   20 * np.log10(np.abs(cascade)), atol=1e-10, rtol=0)
        np.testing.assert_allclose([float(row["cascade_phase_deg"]) for row in rows],
                                   np.angle(cascade, deg=True), atol=1e-10, rtol=0)
        self.assertLessEqual(np.max(np.abs(cascade)), 1 + 1e-12)

    def test_center_half_gain_width_endpoints_and_poles(self):
        raw, _ = self.calculate()
        for section in raw["sections"]:
            def db(frequency):
                return float(20 * np.log10(abs(freqz(section["b"], section["a"], worN=[frequency], fs=16000)[1][0])))
            center, width, gain = section["center_hz"], section["bandwidth_hz"], section["gain_db"]
            self.assertAlmostEqual(db(center), gain, delta=1e-6)
            self.assertAlmostEqual(db(0), 0, delta=1e-6)
            self.assertAlmostEqual(db(8000), 0, delta=1e-6)
            low = brentq(lambda f: db(f) - gain / 2, center - 2 * width, center)
            high = brentq(lambda f: db(f) - gain / 2, center, center + 2 * width)
            self.assertAlmostEqual(high - low, width, delta=.001)
            np.testing.assert_allclose(section["half_gain_edges_hz"], [low, high], atol=1e-7, rtol=0)
            poles = np.roots(section["a"])
            self.assertTrue(np.all(np.abs(poles) < 1))
            saved = [complex(p["real"], p["imag"]) for p in section["poles"]]
            np.testing.assert_allclose(sorted(saved, key=lambda p: p.imag), sorted(poles, key=lambda p: p.imag), atol=1e-12, rtol=0)
        np.testing.assert_allclose(raw["cascade_center_gain_db"], [-6.00391428196052, -6.011681137232788], atol=1e-9, rtol=0)

    def test_c_rejects_invalid_parameters_before_creating_response(self):
        changes = [("center_hz", 0), ("center_hz", 8000), ("center_hz", float("nan")),
                   ("bandwidth_hz", 0), ("bandwidth_hz", 8000), ("bandwidth_hz", float("inf")),
                   ("q", 0), ("q", 1), ("gain_db", 0), ("gain_db", 3), ("gain_db", -1e300)]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                settings = copy.deepcopy(self.settings)
                settings["sections"][0][key] = value
                target = self.directory / "invalid.csv"
                with self.assertRaises(subprocess.CalledProcessError):
                    self.calculate(settings, target)
                self.assertFalse(target.exists())
        for mutate in [lambda s: s.update(sample_rate_hz=8000),
                       lambda s: s["sections"].pop(),
                       lambda s: s["sections"][1].update(center_hz=s["sections"][0]["center_hz"])]:
            settings = copy.deepcopy(self.settings)
            mutate(settings)
            with self.assertRaises(subprocess.CalledProcessError):
                self.calculate(settings, self.directory / "invalid.csv")

    def test_existing_response_is_never_overwritten(self):
        _, path = self.calculate()
        before = path.read_bytes()
        with self.assertRaises(subprocess.CalledProcessError):
            self.calculate(csv_path=path)
        self.assertEqual(path.read_bytes(), before)

    def test_stale_evidence_and_wrong_peak_references_are_rejected(self):
        designer.verify_evidence(self.settings)
        stale = copy.deepcopy(self.settings)
        stale["design_evidence"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "changed"):
            designer.verify_evidence(stale)
        wrong = copy.deepcopy(self.settings)
        wrong["sections"][0]["source_peaks"][0]["peak_id"] = "p1"
        with self.assertRaisesRegex(ValueError, "peak"):
            designer.verify_evidence(wrong)

    def test_runner_rejects_invalid_settings_and_output_paths(self):
        for mutate in [lambda s: s.update(sample_rate_hz=True),
                       lambda s: s.update(connection="parallel"),
                       lambda s: s.update(evaluation_relationship=""),
                       lambda s: s["sections"][0].update(q="30"),
                       lambda s: s["sections"][0].update(bandwidth_hz=float("nan")),
                       lambda s: s["sections"][0].update(gain_db=1),
                       lambda s: s["sections"][0].update(source_peaks=[]),
                       lambda s: s["design_evidence"][0].update(path="../outside.json"),
                       lambda s: s["design_evidence"].pop()]:
            settings = copy.deepcopy(self.settings)
            mutate(settings)
            with self.assertRaises(ValueError):
                designer.validate_settings(settings)
        with self.assertRaises(ValueError):
            designer.generate(output_root=ROOT / "experiment/data")
        with self.assertRaises(ValueError):
            designer.generate(run_id="../invalid")

    def test_complete_run_has_artifact_hashes_preserves_inputs_and_refuses_repeat(self):
        inputs = [designer.CONFIG, ROOT / "experiment/config/prefilter_initial.json",
                  *(ROOT / e["path"] for e in self.settings["design_evidence"])]
        before = {p: designer.digest(p) for p in inputs}
        output = self.directory / "completed"
        run_id = "20261121T000000Z-12345678"
        result = designer.generate(output_root=output, run_id=run_id)
        manifest_path = Path(result["manifest"])
        manifest = designer.read_json(manifest_path)
        self.assertEqual(manifest["settings"], self.settings)
        self.assertEqual(manifest["actual_counts"], {"eq_sections": 2, "response_rows": 16006, "graphs": 3,
                                                    "processed_wavs": 0, "objective_scores": 0, "listening_responses": 0})
        self.assertEqual(len(manifest["artifacts"]), 5)
        for name, sha in manifest["artifacts"].items():
            self.assertEqual(hashlib.sha256((manifest_path.parent / name).read_bytes()).hexdigest(), sha)
        saved = {p: designer.digest(p) for p in manifest_path.parent.iterdir()}
        with self.assertRaises(FileExistsError):
            designer.generate(output_root=output, run_id=run_id)
        self.assertEqual(saved, {p: designer.digest(p) for p in manifest_path.parent.iterdir()})
        self.assertEqual(before, {p: designer.digest(p) for p in inputs})
        self.assertEqual(list(manifest_path.parent.glob("*.wav")), [])

    def test_changed_configuration_during_generation_is_not_published(self):
        config = self.directory / "draft.json"
        designer.write_json(config, self.settings)
        output = self.directory / "not-published"

        def change_config(*args):
            config.write_text("{}\n", encoding="utf-8")
            return []

        with patch.object(designer, "render", side_effect=change_config):
            with self.assertRaisesRegex(ValueError, "changed during"):
                designer.generate(config_path=config, output_root=output)
        self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
