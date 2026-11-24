from tests.legacy import archive_path
import csv
import json
from pathlib import Path
import unittest
import numpy as np
from pystoi import stoi
from evaluation import calculate_metrics as engine
from evaluation.prefilter_metrics import paired_scores,inside,digest

ROOT=engine.PROJECT_ROOT/'before1123'
class PrefilterMetricTests(unittest.TestCase):
    def test_different_fixed_delays_use_identical_clean_interval_and_preserve_scale(self):
        rng=np.random.default_rng(31);t=np.arange(48000)/16000
        clean=.1*(.6+.3*np.sin(2*np.pi*3*t)**2)*rng.standard_normal(t.size)
        baseline=np.r_[np.zeros(7),.8*clean[:-7]];filtered=np.r_[np.zeros(11),.7*clean[:-11]]
        row=paired_scores(clean,baseline,filtered)
        self.assertEqual(row['baseline']['alignment']['alignment_delay_samples'],7)
        self.assertEqual(row['filtered']['alignment']['alignment_delay_samples'],11)
        self.assertEqual((row['reference_start'],row['reference_stop'],row['samples']),(0,47989,47989))
        for mode in ('baseline','filtered'):
            self.assertAlmostEqual(row[mode]['stoi'],1,places=10);self.assertAlmostEqual(row[mode]['estoi'],1,places=10)
        self.assertLess(abs(row['delta']['stoi']),1e-10)

    def test_completed_scores_have_real_hashes_and_match_independent_library_calls(self):
        pointer=json.loads(archive_path('experiment/outputs/prefilter_metrics.json').read_text())
        path=ROOT/pointer['results'];self.assertEqual(digest(path),pointer['sha256'])
        data=json.loads(path.read_text(encoding='utf-8'))
        self.assertEqual((data['actual_count'],data['scored_audio_count'],data['score_value_count']),(144,288,576))
        with (path.parent/'comparison.csv').open(encoding='utf-8-sig',newline='') as stream:self.assertEqual(len(list(csv.DictReader(stream))),144)
        for index in (0,12,24,36,48,96):
            row=data['conditions'][index]
            reference=engine._read_wav(ROOT/'experiment/data/reference'/Path(row['reference_path']).name)
            self.assertEqual(reference.sha256,row['reference_sha256'])
            clean=reference.signal[row['reference_start']:row['reference_stop']]
            for mode,field in [('baseline','input'),('filtered','output')]:
                audio=engine._read_wav(engine._project_wav_path(row[field+'_path'],ROOT,json.loads((ROOT/'experiment/config/paths.json').read_text(encoding='utf-8-sig')))[1])
                self.assertEqual(audio.sha256,row[field+'_sha256'])
                start=row[mode]['scored_target_start'];target=audio.signal[start:start+row['samples']]
                self.assertEqual(len(clean),len(target))
                for metric,extended in [('stoi',False),('estoi',True)]:
                    self.assertAlmostEqual(row[mode][metric],stoi(clean,target,16000,extended=extended),places=11)
            for metric in ('stoi','estoi'):self.assertEqual(row['delta'][metric],row['filtered'][metric]-row['baseline'][metric])

    def test_artifact_paths_cannot_escape_project(self):
        with self.assertRaises(ValueError):inside(ROOT,'../outside.json')

if __name__=='__main__':unittest.main()
