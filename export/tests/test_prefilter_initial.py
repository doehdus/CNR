import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('prefilter_exporter', ROOT / 'export/export_results.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class InitialPrefilterExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.target = self.root / 'experiment/config/prefilter_initial.json'
        self.target.parent.mkdir(parents=True)
        self.settings = json.loads((ROOT / 'experiment/config/prefilter_initial.json').read_text(encoding='utf-8'))
        contents = (ROOT / 'experiment/outputs/peak_analysis/results.json').read_bytes()
        self.analysis, self.hash = json.loads(contents), hashlib.sha256(contents).hexdigest()

    def write(self, data):
        self.target.write_text(json.dumps(data), encoding='utf-8')

    def test_matching_design_is_delivered_but_missing_or_stale_design_is_withheld(self):
        self.assertIsNone(exporter.prefilter_initial_for_analysis(self.root, self.analysis, self.hash))
        self.write(self.settings)
        self.assertEqual(exporter.prefilter_initial_for_analysis(self.root, self.analysis, self.hash), self.settings)
        self.assertIsNone(exporter.prefilter_initial_for_analysis(self.root, self.analysis, '0' * 64))
        changed = copy.deepcopy(self.analysis)
        changed['sources'][0]['peaks'][0]['frequency_hz'] += 1
        self.assertIsNone(exporter.prefilter_initial_for_analysis(self.root, changed, self.hash))

    def test_invalid_designs_cannot_be_exported(self):
        for key, value in [('gain_db', 6), ('q', 0), ('q', 20), ('bandwidth_hz', -1)]:
            with self.subTest(key=key, value=value):
                broken = copy.deepcopy(self.settings)
                broken['presets'][0][key] = value
                self.write(broken)
                with self.assertRaises(ValueError):
                    exporter.prefilter_initial_for_analysis(self.root, self.analysis, self.hash)
