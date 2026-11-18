import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import wave

spec = importlib.util.spec_from_file_location('export_results', Path(__file__).resolve().parents[1] / 'export_results.py')
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cnr-export-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.layout = {'version': 1, 'manifest': 'experiment/data/metadata/dataset.json', 'metric_results': 'experiment/outputs/metrics.json', 'audio_roots': [
            {'public': 'data/clean', 'source': 'experiment/data/clean'},
            {'public': 'data/noise', 'source': 'experiment/data/noise'},
            {'public': 'data/mixed', 'source': 'experiment/data/mixtures'},
            {'public': 'outputs', 'source': 'experiment/outputs/enhanced'},
        ]}
        self.manifest = {'version': 1, 'samples': [
            {'id': 'clean_instruction_01', 'kind': 'clean', 'statement': 'instruction_01', 'path': 'data/clean/instruction_01.wav'},
            {'id': 'single_snr20_instruction_01_noisy', 'kind': 'noisy', 'statement': 'instruction_01', 'path': 'data/mixed/single/snr20/instruction_01.wav'},
            {'id': 'single_snr20_instruction_01_ss_fixed', 'kind': 'processed', 'statement': 'instruction_01', 'path': 'outputs/ss_fixed/single/snr20/instruction_01.wav'},
        ], 'noise_sources': []}
        self.put_json(self.layout['manifest'], self.manifest)
        self.put_json('experiment/config/paths.json', self.layout)
        for entry in self.manifest['samples'][:2]:
            target = exporter.audio_path(self.root, entry['path'], self.layout)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'RIFFtestWAVE' + entry['id'].encode())
        self.row = {'sample_id': 'single_snr20_instruction_01_noisy', 'stoi': 0, 'estoi': -.1, 'tool_version': 'fixture/1',
                    'reference_id': 'clean_instruction_01', 'reference_path': self.manifest['samples'][0]['path'],
                    'compared_path': self.manifest['samples'][1]['path'], 'sample_rate': 16000, 'samples': 16000,
                    'calculated_at': '2026-11-16T00:00:00+00:00', 'alignment_delay_samples': -16}
        for prefix in ['reference', 'compared']:
            self.row[prefix + '_sha256'] = hashlib.sha256(exporter.audio_path(self.root, self.row[prefix + '_path'], self.layout).read_bytes()).hexdigest()
        self.put_json(self.layout['metric_results'], [self.row])
        self.destination = self.root / 'website/public/dataset'

    def put_json(self, relative, value):
        filename = self.root / relative
        filename.parent.mkdir(parents=True, exist_ok=True)
        filename.write_text(json.dumps(value), encoding='utf-8')

    def test_completed_results_and_existing_audio_only_are_exported(self):
        for relative in ['experiment/data/noise_train/private.wav', 'experiment/data/noise_test/private.wav', 'before261116/old.wav']:
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(b'RIFFtestWAVEprivate')
        result = exporter.export_results(self.root)
        self.assertEqual((result['audio'], result['metrics']), (2, 1))
        self.assertEqual(json.loads((self.destination / 'results.json').read_text()), [self.row])
        catalog = json.loads((self.destination / 'audio/catalog.json').read_text())
        self.assertEqual([entry['path'] for entry in catalog['files']], sorted(entry['path'] for entry in self.manifest['samples'][:2]))
        self.assertEqual(len(list((self.destination / 'audio').rglob('*.wav'))), 2)
        for entry in self.manifest['samples'][:2]:
            self.assertEqual((self.destination / 'audio' / entry['path']).read_bytes(), exporter.audio_path(self.root, entry['path'], self.layout).read_bytes())

    def test_stale_audio_or_invalid_metrics_preserve_previous_snapshot(self):
        exporter.export_results(self.root)
        previous = (self.destination / 'results.json').read_bytes()
        invalid = [[], [self.row, self.row], [{**self.row, 'stoi': True}], [{**self.row, 'estoi': 2}],
                   [{**self.row, 'sample_id': 'unknown'}], [{**self.row, 'reference_sha256': 'a' * 64}],
                   [{**self.row, 'compared_path': '../outside.wav'}]]
        for rows in invalid:
            with self.subTest(rows=rows):
                self.put_json(self.layout['metric_results'], rows)
                with self.assertRaises(ValueError):
                    exporter.export_results(self.root)
                self.assertEqual((self.destination / 'results.json').read_bytes(), previous)
        self.put_json(self.layout['metric_results'], [self.row])
        source = exporter.audio_path(self.root, self.row['compared_path'], self.layout)
        source.write_bytes(b'RIFFtestWAVEchanged')
        with self.assertRaisesRegex(ValueError, 'changed'):
            exporter.export_results(self.root)
        self.assertEqual((self.destination / 'results.json').read_bytes(), previous)

    def test_unregistered_or_traversing_source_cannot_cross_the_boundary(self):
        for path in ['data/noise_train/private.wav', '../outside.wav', 'C:/outside.wav']:
            with self.subTest(path=path):
                manifest = copy.deepcopy(self.manifest)
                manifest['samples'][1]['path'] = path
                self.put_json(self.layout['manifest'], manifest)
                with self.assertRaises(ValueError):
                    exporter.export_results(self.root)
        self.assertFalse(self.destination.exists())

    def test_private_noise_roots_cannot_be_remapped_as_public_audio(self):
        for name in ['noise_train', 'noise_test']:
            with self.subTest(name=name):
                layout = copy.deepcopy(self.layout)
                layout['audio_roots'][1]['source'] = 'experiment/data/' + name
                self.put_json('experiment/config/paths.json', layout)
                with self.assertRaisesRegex(ValueError, 'not public'):
                    exporter.export_results(self.root)
        self.assertFalse(self.destination.exists())


    def test_input_only_snapshot_can_have_no_metrics_without_fabricated_scores(self):
        self.manifest['samples'] = []
        self.put_json(self.layout['manifest'], self.manifest)
        (self.root / self.layout['metric_results']).unlink()
        self.prepare_clean_collection()
        result = exporter.export_results(self.root)
        self.assertEqual((result['audio'], result['metrics'], result['clean_recordings']), (12, 0, 12))
        self.assertEqual(json.loads((self.destination / 'results.json').read_text()), [])

    def prepare_noise_analysis(self):
        noise = {'id': 'noise_single', 'path': 'data/noise/single.wav'}
        self.manifest['noise_sources'] = [noise]
        self.put_json(self.layout['manifest'], self.manifest)
        source = exporter.audio_path(self.root, noise['path'], self.layout)
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_bytes(b'RIFFtestWAVEsource noise')
        graph = self.root / 'experiment/outputs/graphs/noise_analysis/fixture/single.png'
        graph.parent.mkdir(parents=True, exist_ok=True)
        graph.write_bytes(b'\x89PNG\r\n\x1a\nfixture image')
        image = 'graphs/fixture/single.png'
        data = {'version': 1, 'sources': [{
            'noise': 'single', 'inputs': [{'sample_id': noise['id'], 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()}],
            'analysis': {'method': 'full_fft', 'sample_rate_hz': 16000, 'sample_count': 16000, 'fft_size': 16384,
                         'window_function': 'hann_periodic', 'magnitude_reference': 'fixture dBFS', 'peak_rule': 'pending'},
            'spectrum_image': image, 'peaks': None, 'candidates': [],
        }], 'mixtures': [], 'overview': None, 'artifacts': {image: hashlib.sha256(graph.read_bytes()).hexdigest()}}
        self.put_json('experiment/outputs/noise_analysis/results.json', data)
        return data, graph

    def test_completed_analysis_graphs_are_copied_and_pending_peaks_remain_null(self):
        data, graph = self.prepare_noise_analysis()
        result = exporter.export_results(self.root)
        self.assertEqual(result['noise_analysis'], {'sources': 1, 'graphs': 1})
        exported = json.loads((self.destination / 'noise_analysis/results.json').read_text())
        self.assertIsNone(exported['sources'][0]['peaks'])
        self.assertEqual((self.destination / 'noise_analysis' / data['sources'][0]['spectrum_image']).read_bytes(), graph.read_bytes())

    def test_analysis_only_update_preserves_audio_and_metrics_when_old_research_references_are_absent(self):
        data, _ = self.prepare_noise_analysis()
        exporter.export_results(self.root)
        preserved = {path: path.read_bytes() for path in self.destination.rglob('*') if path.is_file() and 'noise_analysis' not in path.parts}
        exporter.audio_path(self.root, self.manifest['samples'][0]['path'], self.layout).unlink()
        result = exporter.export_analysis_only(self.root)
        self.assertEqual(result['noise_analysis'], {'sources': 1, 'graphs': 1})
        for path, contents in preserved.items():
            self.assertEqual(path.read_bytes(), contents)
        previous = (self.destination / 'noise_analysis/results.json').read_bytes()
        (self.destination / 'audio' / self.manifest['samples'][1]['path']).write_bytes(b'RIFFtestWAVEchanged')
        with self.assertRaisesRegex(ValueError, 'changed'):
            exporter.export_analysis_only(self.root)
        self.assertEqual((self.destination / 'noise_analysis/results.json').read_bytes(), previous)

    def prepare_clean_collection(self):
        records = []
        for category in ['instruction', 'warning']:
            for number in range(1, 7):
                identity = category + f'{number:02}'
                records.append({'id': identity, 'category': category, 'speaker': '유채원' if number <= 3 else '김도연', 'text': 'fixture ' + identity})
                path = self.root / 'experiment/data/clean' / (identity + '.wav')
                path.parent.mkdir(parents=True, exist_ok=True)
                with wave.open(str(path), 'wb') as audio:
                    audio.setnchannels(1)
                    audio.setsampwidth(2)
                    audio.setframerate(16000 if number <= 3 else 48000)
                    audio.writeframes(b'\x01\x00' * (160 + number))
        self.put_json('experiment/config/collection.json', {'version': 1, 'source_root': 'experiment/data/clean', 'recordings': records})

    def test_new_twelve_clean_files_are_exported_without_replacing_legacy_results_or_analysis(self):
        self.prepare_noise_analysis()
        exporter.export_results(self.root)
        preserved = {path.relative_to(self.destination): path.read_bytes() for path in self.destination.rglob('*')
                     if path.is_file() and path.name not in {'catalog.json', 'export.json'}}
        self.prepare_clean_collection()
        exporter.audio_path(self.root, self.manifest['samples'][0]['path'], self.layout).unlink()
        result = exporter.export_collection_only(self.root)
        self.assertEqual((result['clean_recordings'], result['audio'], result['metrics']), (12, 15, 1))
        for relative, contents in preserved.items():
            self.assertEqual((self.destination / relative).read_bytes(), contents)
        recordings = json.loads((self.destination / 'collection.json').read_text(encoding='utf-8'))['recordings']
        self.assertEqual(len(recordings), 12)
        self.assertEqual({row['sample_rate_hz'] for row in recordings}, {16000, 48000})
        for row in recordings:
            original = (self.root / 'experiment/data/clean' / (row['id'] + '.wav')).read_bytes()
            self.assertEqual((self.destination / 'audio' / row['path']).read_bytes(), original)
            self.assertEqual(row['sha256'], hashlib.sha256(original).hexdigest())
        exporter.export_collection_only(self.root)
        self.assertEqual(len(json.loads((self.destination / 'audio/catalog.json').read_text())['files']), 15)

    def test_missing_new_recording_does_not_partially_replace_the_web_snapshot(self):
        exporter.export_results(self.root)
        self.prepare_clean_collection()
        exporter.export_collection_only(self.root)
        previous = (self.destination / 'collection.json').read_bytes()
        previous_catalog = (self.destination / 'audio/catalog.json').read_bytes()
        (self.root / 'experiment/data/clean/warning06.wav').unlink()
        with self.assertRaises(FileNotFoundError):
            exporter.export_collection_only(self.root)
        self.assertEqual((self.destination / 'collection.json').read_bytes(), previous)
        self.assertEqual((self.destination / 'audio/catalog.json').read_bytes(), previous_catalog)

    def test_stale_or_invalid_analysis_preserves_the_previous_web_snapshot(self):
        data, graph = self.prepare_noise_analysis()
        exporter.export_results(self.root)
        previous = (self.destination / 'noise_analysis/results.json').read_bytes()
        previous_graph = (self.destination / 'noise_analysis' / data['sources'][0]['spectrum_image']).read_bytes()
        for mutate in [
            lambda value: value['sources'][0]['inputs'][0].update(sha256='0' * 64),
            lambda value: value['artifacts'].update({'graphs/fixture/single.png': '0' * 64}),
            lambda value: value['sources'][0].update(spectrum_image='graphs/../outside.png'),
            lambda value: value['sources'][0]['analysis'].update(fft_size=256),
        ]:
            invalid = copy.deepcopy(data)
            mutate(invalid)
            self.put_json('experiment/outputs/noise_analysis/results.json', invalid)
            with self.assertRaises(ValueError):
                exporter.export_results(self.root)
            self.assertEqual((self.destination / 'noise_analysis/results.json').read_bytes(), previous)
            self.assertEqual((self.destination / 'noise_analysis' / data['sources'][0]['spectrum_image']).read_bytes(), previous_graph)
        self.put_json('experiment/outputs/noise_analysis/results.json', data)
        graph.unlink()
        with self.assertRaises(FileNotFoundError):
            exporter.export_results(self.root)
        self.assertEqual((self.destination / 'noise_analysis/results.json').read_bytes(), previous)


if __name__ == '__main__':
    unittest.main()
