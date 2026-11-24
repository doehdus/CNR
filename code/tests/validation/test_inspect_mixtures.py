import hashlib
import json
from pathlib import Path
import tempfile
import unittest
import wave

from prepare.inspect_mixtures import NOISES, SNRS, inspect_dataset, save_report


class MixtureInspectionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="cnr-mixtures-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        recordings = []
        for category in ("instruction", "warning"):
            for number in range(1, 7):
                identity = category + f"{number:02}"
                recordings.append({"id": identity, "speaker": "유채원" if number <= 3 else "김도연"})
                self.wav(self.root / "data/clean" / (identity + ".wav"), 16000 if number <= 3 else 48000)
        self.recordings = recordings
        config = self.root / "data/metadata/collection.json"
        config.parent.mkdir(parents=True)
        config.write_text(json.dumps({"source_root": "data/clean", "recordings": recordings}), encoding="utf-8")

    def wav(self, path, rate=16000):
        path.parent.mkdir(parents=True, exist_ok=True)
        with wave.open(str(path), "wb") as file:
            file.setnchannels(1); file.setsampwidth(2); file.setframerate(rate)
            file.writeframes(b"\x01\x00" * 160)

    def test_empty_new_folder_is_pending_and_old_mixtures_are_not_counted(self):
        self.wav(self.root / "experiment/mixtures/single/snr20/instruction_01.wav")
        report = inspect_dataset(self.root)
        self.assertEqual((report["status"], report["received_files"], report["expected_mixtures"], report["missing_count"]), ("awaiting_files", 0, 144, 144))
        self.assertEqual({row["sample_rate_hz"]: row["files"] for row in report["clean_formats"]}, {16000: 6, 48000: 6})
        self.assertFalse((self.root / "data/mixtures").exists())

    def test_duplicate_conditions_unknown_names_and_truncated_wavs_require_review(self):
        folder = self.root / "data/mixtures"
        for name in ("single/snr00/instruction01.wav", "single/snr0/instruction01.wav", "single/snr20/instruction_01.wav"):
            self.wav(folder / name)
        bad = folder / "single/snr10/warning01.wav"
        self.wav(bad)
        bad.write_bytes(bad.read_bytes()[:-3])
        report = inspect_dataset(self.root)
        self.assertEqual(report["status"], "needs_review")
        self.assertEqual(len(report["duplicate_conditions"]), 1)
        self.assertEqual(len(report["unmapped_files"]), 1)
        self.assertEqual(len(report["invalid_files"]), 1)
        self.assertEqual(report["snr_status"], "not_measured")

    def test_complete_input_is_inspected_without_modifying_audio_or_claiming_snr_measurement(self):
        for noise in NOISES:
            for snr in SNRS:
                for recording in self.recordings:
                    self.wav(self.root / f"data/mixtures/{noise}/snr{snr:02}" / (recording["id"] + ".wav"))
        sample = self.root / "data/mixtures/single/snr20/instruction01.wav"
        original = hashlib.sha256(sample.read_bytes()).hexdigest()
        report = inspect_dataset(self.root)
        self.assertEqual((report["status"], report["received_files"], report["matched_conditions"], report["missing_count"]), ("file_checks_complete", 144, 144, 0))
        self.assertTrue(all(row["snr_verified"] is False for row in report["mixtures"]))
        self.assertEqual(hashlib.sha256(sample.read_bytes()).hexdigest(), original)
        first, second = save_report(self.root, report), save_report(self.root, report)
        self.assertNotEqual(first, second)
        self.assertTrue((first / "report.json").is_file())
        self.assertEqual(len((first / "files.csv").read_text(encoding="utf-8-sig").splitlines()), 145)


if __name__ == "__main__":
    unittest.main()
