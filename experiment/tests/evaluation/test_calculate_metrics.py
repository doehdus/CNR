import csv
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import numpy as np
import soundfile as sf
from pystoi import stoi
from scipy.signal import resample_poly
from experiment.src.evaluation.calculate_metrics import BatchCalculationError, MetricInputError, PROJECT_ROOT, calculate_dataset, calculate_signals, calculate_wav_pair, prepare_signals, resolve_audio_path, write_results


def signals(seed=123, rate=16000, seconds=1.2):
    rng = np.random.default_rng(seed)
    t = np.arange(int(rate * seconds)) / rate
    clean = .15 * (.5 + .3 * np.sin(2 * np.pi * 3 * t) ** 2) * rng.standard_normal(t.size)
    return clean, clean + rng.normal(0, .06, clean.size)


class SignalTests(unittest.TestCase):
    def test_both_scores_match_the_unmodified_reference(self):
        for rate in (10000, 16000, 48000):
            with self.subTest(rate=rate):
                clean, target = signals(rate=rate)
                actual = calculate_signals(clean, target, rate)
                self.assertAlmostEqual(actual['stoi'], stoi(clean, target, rate, extended=False), places=11)
                self.assertAlmostEqual(actual['estoi'], stoi(clean, target, rate, extended=True), places=11)
                self.assertGreater(abs(actual['stoi'] - actual['estoi']), 1e-5)

    def test_identical_audio_is_near_one(self):
        clean, _ = signals()
        result = calculate_signals(clean, clean, 16000)
        self.assertAlmostEqual(result['stoi'], 1, places=10)
        self.assertAlmostEqual(result['estoi'], 1, places=10)

    def test_invalid_signals_do_not_produce_placeholder_scores(self):
        clean, target = signals()
        cases = [(clean,target[:-1],16000,'length_mismatch'), (clean[:,None],target[:,None],16000,'channels'), (clean,np.zeros_like(target),16000,'silence'), (np.zeros_like(clean),target,16000,'silence'), ([],[],16000,'empty'), (clean,np.full_like(target,np.nan),16000,'non_finite'), (clean,target,0,'sample_rate'), (clean,target,True,'sample_rate'), (clean,target,16000.5,'sample_rate'), (clean.astype(complex),target,16000,'invalid_signal')]
        for reference, compared, rate, code in cases:
            with self.subTest(code=code):
                with self.assertRaises(MetricInputError) as caught:
                    calculate_signals(reference, compared, rate)
                self.assertEqual(caught.exception.code, code)

    def test_too_short_audio_is_an_error_not_a_small_score(self):
        clean, target = signals(seconds=.08)
        with self.assertRaises(MetricInputError) as caught:
            calculate_signals(clean, target, 16000)
        self.assertEqual(caught.exception.code, 'insufficient_audio')


class PreparationTests(unittest.TestCase):
    def test_different_rates_and_both_delay_directions_recover_matching_audio(self):
        for original_rate in (44100, 48000):
            clean, _ = signals(rate=original_rate)
            expected = resample_poly(clean, 16000, original_rate)
            for delay in (-704, 0, 400):
                with self.subTest(original_rate=original_rate, delay=delay):
                    target = np.pad(expected, (delay, 0)) if delay >= 0 else expected[-delay:]
                    reference, compared, metadata = prepare_signals(clean, target, original_rate, 16000)
                    np.testing.assert_array_equal(reference, expected[max(0, -delay):])
                    np.testing.assert_array_equal(reference, compared)
                    self.assertEqual(metadata['alignment_delay_samples'], delay)
                    self.assertEqual(metadata['reference_sample_rate'], original_rate)
                    self.assertEqual(metadata['compared_sample_rate'], 16000)
                    self.assertEqual(metadata['sample_rate'], 16000)
                    self.assertEqual(metadata['samples'], reference.size)
                    self.assertEqual(metadata['reference_trim_start'], max(0, -delay))
                    self.assertEqual(metadata['compared_trim_start'], max(0, delay))
                    self.assertEqual(metadata['reference_trim_end'], 0)
                    self.assertEqual(metadata['compared_trim_end'], 0)
                    self.assertAlmostEqual(metadata['alignment_correlation'], 1)
                    scores = calculate_signals(reference, compared, metadata['sample_rate'])
                    self.assertAlmostEqual(scores['stoi'], 1)
                    self.assertAlmostEqual(scores['estoi'], 1)

    def test_equal_length_files_can_have_a_delay_and_require_trimming_both_ends(self):
        clean, _ = signals()
        target = np.pad(clean[:-400], (400, 0))
        reference, compared, metadata = prepare_signals(clean, target, 16000, 16000)
        np.testing.assert_array_equal(reference, clean[:-400])
        np.testing.assert_array_equal(compared, clean[:-400])
        self.assertEqual(metadata['alignment_delay_samples'], 400)
        self.assertEqual(metadata['reference_trim_end'], 400)
        self.assertEqual(metadata['compared_trim_start'], 400)

    def test_target_resampling_and_zero_search_range(self):
        clean, _ = signals()
        low_rate_target = resample_poly(clean, 1, 2)
        reference, compared, metadata = prepare_signals(clean, low_rate_target, 16000, 8000, max_delay_seconds=0)
        np.testing.assert_array_equal(reference, clean)
        np.testing.assert_array_equal(compared, resample_poly(low_rate_target, 2, 1))
        self.assertEqual(metadata['alignment_delay_samples'], 0)
        self.assertEqual(metadata['compared_sample_rate'], 8000)
        shifted = np.pad(clean[:-400], (400, 0))
        reference, compared, metadata = prepare_signals(clean, shifted, 16000, 16000, max_delay_seconds=0)
        np.testing.assert_array_equal(reference, clean)
        np.testing.assert_array_equal(compared, shifted)
        self.assertEqual(metadata['alignment_delay_samples'], 0)

    def test_noise_and_polarity_do_not_change_the_estimated_delay(self):
        clean, noisy = signals()
        for polarity in (1, -1):
            with self.subTest(polarity=polarity):
                target = np.pad(polarity * noisy, (240, 0))
                reference, compared, metadata = prepare_signals(clean, target, 16000, 16000)
                np.testing.assert_array_equal(reference, clean)
                np.testing.assert_array_equal(compared, polarity * noisy)
                self.assertEqual(metadata['alignment_delay_samples'], 240)
                self.assertEqual(np.sign(metadata['alignment_correlation']), polarity)

    def test_invalid_preparation_options_and_signals_are_rejected(self):
        clean, target = signals()
        options = [
            {'sample_rate': 0}, {'sample_rate': True}, {'sample_rate': 16000.5},
            {'max_delay_seconds': -1}, {'max_delay_seconds': float('nan')},
            {'max_delay_seconds': float('inf')}, {'max_delay_seconds': True},
        ]
        for option in options:
            with self.subTest(option=option), self.assertRaises(MetricInputError):
                prepare_signals(clean, target, 16000, 16000, **option)
        for rate in (0, True, 16000.5):
            with self.subTest(rate=rate), self.assertRaises(MetricInputError):
                prepare_signals(clean, target, rate, 16000)
            with self.subTest(rate=rate), self.assertRaises(MetricInputError):
                prepare_signals(clean, target, 16000, rate)
        for invalid in (np.zeros_like(clean), clean[:, None], np.full_like(clean, np.nan), []):
            with self.assertRaises(MetricInputError):
                prepare_signals(invalid, target, 16000, 16000)


class WavTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cnr-wav-test-')
        self.root = Path(self.temporary.name)
        self.clean, self.target = signals()
        self.reference, self.compared = self.root/'기준.wav', self.root/'비교.wav'
        sf.write(self.reference, self.clean, 16000, subtype='PCM_16')
        sf.write(self.compared, self.target, 16000, subtype='PCM_16')

    def tearDown(self):
        self.temporary.cleanup()

    def test_wav_decoding_matches_reference_without_result_writes(self):
        reference, rate = sf.read(self.reference, dtype='float64')
        target, _ = sf.read(self.compared, dtype='float64')
        actual = calculate_wav_pair(self.reference, self.compared)
        self.assertAlmostEqual(actual['stoi'], stoi(reference,target,rate,extended=False), places=11)
        self.assertAlmostEqual(actual['estoi'], stoi(reference,target,rate,extended=True), places=11)
        self.assertEqual(len(list(self.root.iterdir())), 2)

    def test_wav_entry_point_resamples_and_aligns_without_modifying_sources(self):
        high_rate_clean, _ = signals(rate=48000)
        aligned = resample_poly(high_rate_clean, 1, 3)[704:]
        sf.write(self.reference, high_rate_clean, 48000, subtype='FLOAT')
        sf.write(self.compared, aligned, 16000, subtype='FLOAT')
        before = [path.read_bytes() for path in (self.reference, self.compared)]
        scores = calculate_wav_pair(self.reference, self.compared)
        self.assertGreater(scores['stoi'], .999999)
        self.assertGreater(scores['estoi'], .999999)
        self.assertEqual(before, [path.read_bytes() for path in (self.reference, self.compared)])

    def test_channel_and_file_errors(self):
        sf.write(self.compared, np.column_stack([self.target, self.target]), 16000)
        with self.assertRaises(MetricInputError) as caught:
            calculate_wav_pair(self.reference, self.compared)
        self.assertEqual(caught.exception.code, 'channels')
        self.compared.write_bytes(b'not a wave')
        with self.assertRaises(MetricInputError):
            calculate_wav_pair(self.reference,self.compared)
        with self.assertRaises(MetricInputError) as caught:
            calculate_wav_pair(self.reference,self.root/'missing.wav')
        self.assertEqual(caught.exception.code,'file_missing')


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cnr-batch-test-')
        self.root = Path(self.temporary.name)
        self.manifest = json.loads((PROJECT_ROOT/'experiment/data/metadata/dataset.json').read_text(encoding='utf-8-sig'))
        config = self.root/'experiment/config/paths.json'
        config.parent.mkdir(parents=True)
        config.write_text((PROJECT_ROOT/'experiment/config/paths.json').read_text(encoding='utf-8'),encoding='utf-8')
        self.manifest_path = self.root/'experiment/data/metadata/dataset.json'
        self.manifest_path.parent.mkdir(parents=True)
        self.manifest_path.write_text(json.dumps(self.manifest,ensure_ascii=False),encoding='utf-8')
        voices = {statement:signals(index+1) for index,statement in enumerate(('instruction_01','instruction_02','warning_01'))}
        for entry in self.manifest['samples']:
            path = resolve_audio_path(entry['path'],self.root)
            path.parent.mkdir(parents=True,exist_ok=True)
            clean, noisy = voices[entry['statement']]
            samples = clean if entry['kind']=='clean' else noisy if entry['kind']=='noisy' else clean+(noisy-clean)/2
            sf.write(path,samples,16000,subtype='PCM_16')

    def tearDown(self):
        self.temporary.cleanup()

    def test_180_pairs_reference_mapping_and_both_output_formats(self):
        rows = calculate_dataset(self.manifest_path,root=self.root)
        self.assertEqual(len(rows),180)
        self.assertEqual(len({row['sample_id'] for row in rows}),180)
        for row in rows:
            entry = next(item for item in self.manifest['samples'] if item['id']==row['sample_id'])
            self.assertEqual(row['reference_id'],'clean_'+entry['statement'])
            for kind in ('reference','compared'):
                digest = hashlib.sha256(resolve_audio_path(row[kind+'_path'],self.root).read_bytes()).hexdigest()
                self.assertEqual(row[kind+'_sha256'],digest)
            self.assertEqual(row['sample_rate'], 16000)
            self.assertEqual(row['reference_sample_rate'], 16000)
            self.assertEqual(row['compared_sample_rate'], 16000)
            self.assertEqual(row['alignment_delay_samples'], 0)
        for row in (rows[0],rows[-1]):
            direct = calculate_wav_pair(resolve_audio_path(row['reference_path'],self.root),resolve_audio_path(row['compared_path'],self.root))
            self.assertAlmostEqual(row['stoi'],direct['stoi'],places=11)
            self.assertAlmostEqual(row['estoi'],direct['estoi'],places=11)
        csv_path,json_path = write_results(rows,self.root/'results')
        self.assertEqual(json.loads(json_path.read_text(encoding='utf-8')),rows)
        with csv_path.open(encoding='utf-8-sig',newline='') as handle:
            csv_rows = list(csv.DictReader(handle))
        self.assertEqual(len(csv_rows),180)
        self.assertEqual(float(csv_rows[0]['stoi']),rows[0]['stoi'])
        self.assertEqual(int(csv_rows[0]['samples']), rows[0]['samples'])
        self.assertEqual(int(csv_rows[0]['reference_sample_rate']), 16000)
        self.assertEqual(float(csv_rows[0]['alignment_correlation']), rows[0]['alignment_correlation'])

    def test_batch_records_actual_resampled_overlap_and_original_file_hashes(self):
        sample_id = 'single_snr20_instruction_01_noisy'
        clean, _ = signals(rate=48000)
        target = resample_poly(clean, 1, 3)[704:]
        reference_path = resolve_audio_path('data/clean/instruction_01.wav',self.root)
        compared_path = resolve_audio_path('data/mixed/single/snr20/instruction_01.wav',self.root)
        sf.write(reference_path, clean, 48000, subtype='FLOAT')
        sf.write(compared_path, target, 16000, subtype='FLOAT')
        row, = calculate_dataset(self.manifest_path, root=self.root, sample_ids=[sample_id])
        self.assertEqual(row['reference_sample_rate'], 48000)
        self.assertEqual(row['compared_sample_rate'], 16000)
        self.assertEqual(row['sample_rate'], 16000)
        self.assertEqual(row['samples'], target.size)
        self.assertEqual(row['alignment_delay_samples'], -704)
        self.assertEqual(row['reference_trim_start'], 704)
        self.assertEqual(row['reference_sha256'], hashlib.sha256(reference_path.read_bytes()).hexdigest())
        self.assertEqual(row['compared_sha256'], hashlib.sha256(compared_path.read_bytes()).hexdigest())

    def test_bad_pair_prevents_cli_overwriting_existing_results(self):
        broken = next(entry for entry in self.manifest['samples'] if entry['kind']=='processed')
        resolve_audio_path(broken['path'],self.root).unlink()
        with self.assertRaises(BatchCalculationError) as caught:
            calculate_dataset(self.manifest_path,root=self.root)
        self.assertEqual(caught.exception.errors[0]['sample_id'],broken['id'])
        output = self.root/'results'
        output.mkdir()
        (output/'metrics.json').write_text('[]\n',encoding='utf-8')
        (output/'metrics.csv').write_text('preserved\n',encoding='utf-8')
        run = subprocess.run([sys.executable,str(PROJECT_ROOT/'experiment/src/evaluation/calculate_metrics.py'),'--manifest',str(self.manifest_path),'--root',str(self.root),'--output-dir',str(output)],capture_output=True,encoding='utf-8')
        self.assertEqual(run.returncode,1)
        self.assertEqual(json.loads(run.stderr)['errors'][0]['code'],'file_missing')
        self.assertEqual((output/'metrics.json').read_text(),'[]\n')
        self.assertEqual((output/'metrics.csv').read_text(),'preserved\n')

    def test_wrong_speaker_duplicate_and_escaping_paths_rejected(self):
        changes = [lambda data:data['samples'][0].update(speaker='김도연'), lambda data:data['samples'].append(data['samples'][0]), lambda data:data['samples'][0].update(path='data/../outside.wav'), lambda data:data['samples'][0].update(path=data['samples'][1]['path'])]
        for change in changes:
            manifest = json.loads(json.dumps(self.manifest))
            change(manifest)
            self.manifest_path.write_text(json.dumps(manifest),encoding='utf-8')
            with self.assertRaises(MetricInputError):
                calculate_dataset(self.manifest_path,root=self.root)

    def test_subset_excludes_clean_and_noise_source_recordings(self):
        sample_id = next(entry['id'] for entry in self.manifest['samples'] if entry['kind']=='noisy')
        self.assertEqual([row['sample_id'] for row in calculate_dataset(self.manifest_path,root=self.root,sample_ids=[sample_id])],[sample_id])
        with self.assertRaises(MetricInputError):
            calculate_dataset(self.manifest_path,root=self.root,sample_ids=['clean_warning_01'])

    def test_invalid_results_do_not_create_an_output_directory(self):
        destination = self.root/'invalid-results'
        with self.assertRaises(MetricInputError):
            write_results([],destination)
        with self.assertRaises(MetricInputError):
            write_results([{'sample_id':'single_snr20_instruction_01_noisy','stoi':float('nan'),'estoi':.5}],destination)
        self.assertFalse(destination.exists())

    def test_layout_preserves_public_paths_and_rejects_outside_sources(self):
        self.assertEqual(resolve_audio_path('data/mixed/a.wav',self.root),self.root/'experiment/data/mixtures/a.wav')
        self.assertEqual(resolve_audio_path('outputs/ss_fixed/a.wav',self.root),self.root/'experiment/outputs/enhanced/ss_fixed/a.wav')
        config = self.root/'experiment/config/paths.json'
        layout = json.loads(config.read_text())
        layout['audio_roots'][0]['source'] = '../outside'
        config.write_text(json.dumps(layout),encoding='utf-8')
        with self.assertRaises(MetricInputError):
            calculate_dataset(self.manifest_path,root=self.root)


if __name__ == '__main__':
    unittest.main()
