import copy
import json
from pathlib import Path
import unittest
from experiment.src.evaluation.select_prefilter_listening import ROOT, verify


class ListeningSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.selection = json.loads((ROOT/'experiment/config/prefilter_listening.json').read_text(encoding='utf-8'))

    def test_all_30_exact_pairs_cover_the_12_sentences_and_registered_wavs(self):
        self.assertEqual(verify(self.selection), {'groups':5, 'paired_conditions':30, 'verified_wavs':60, 'covered_statements':12})

    def test_replaced_source_condition_score_and_fingerprint_are_rejected(self):
        for field, value in [('snr', 99), ('input_path', 'data/mixed/single/snr00/warning01.wav'),
                             ('output_sha256', '0'*64), ('delta', {'stoi':1,'estoi':1})]:
            with self.subTest(field=field):
                changed = copy.deepcopy(self.selection)
                changed['groups'][0]['conditions'][0][field] = value
                with self.assertRaises((ValueError, KeyError)):
                    verify(changed)


if __name__ == '__main__': unittest.main()
